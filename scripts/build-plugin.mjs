#!/usr/bin/env node
// Builds the installable plugin, dist/manifest.json and dist/plugin.js, from
// src/ and buzz-app modules in a clone at the pinned revision (BUZZ_APP_REV
// below). plugin.js is one ES module with no imports, as Buzz loads it.
//
// Why a pinned clone: the plugin runs buzz-app's shared ACP client and Goose
// runtime unchanged, so a Hermes agent behaves as a Goose agent does. Their
// contract with the app is the app version the owner runs, so the pin is
// the revision of a released app (README, "Compatibility").
//
// Three modules are swapped while bundling (SWAPS): Goose's process adapter
// and sessions module for this plugin's, and the app's agent service for a
// shim that carries only what the runtime calls. The build then fails closed
// if the bundle holds a module that must stay the app's own (FORBIDDEN):
// a second React, Tauri bindings, the real agent service or app stores would
// run with their own state inside the plugin.
//
// Usage: node scripts/build-plugin.mjs [--out <dir>] [--check-only]
//   BUZZ_APP_DIR  the buzz-app clone (default: the `buzz-app` link at the
//                 repository top), at BUZZ_APP_REV with its packages installed
//   --out <dir>   write there instead of dist/
//   --check-only  type-check only, no bundle
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The buzz-app revision of Buzz Desktop 0.7.0-preview.240.1. */
export const BUZZ_APP_REV = "0b2dfbf98";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLONE_LINK = join(ROOT, "buzz-app");
const MANIFEST = join(ROOT, "plugin", "manifest.json");
const ENTRY = join(ROOT, "src", "index.ts");
const OUT_NAME = "plugin.js";
const EXPECTED_PACKAGE = "buzz-foundation";
const GIT_TIMEOUT_MS = 30_000;
const TSC_TIMEOUT_MS = 5 * 60_000;
const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;

/** buzz-app module (relative to its src/, no extension) to this repository's
 * module that replaces it. */
const SWAPS = {
  "bundled/goose/goose": "src/hermes.ts",
  "bundled/goose/sessions": "src/sessions.ts",
  "features/agents/service": "src/service-shim.ts",
};
/** Modules that must never be bundled (see the header). */
const FORBIDDEN = [
  /node_modules\/react\//,
  /node_modules\/react-dom\//,
  /node_modules\/@tauri-apps\//,
  /\/src\/features\/agents\/service\.ts$/,
  /\/src\/features\/agents\/store-native/,
  /\/src\/features\/identity\//,
  /\.css$/,
];

/** A build precondition or step that failed, with what to do about it. */
class BuildError extends Error {
  constructor(message, { exit = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BuildError";
    this.exit = exit;
  }
}

function parseArgs(argv) {
  const options = { out: join(ROOT, "dist"), checkOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--out") {
      if (!argv[i + 1])
        throw new BuildError("--out needs a directory", { exit: EXIT_USAGE });
      options.out = resolve(argv[i + 1]);
      i += 1;
    } else
      throw new BuildError(`unknown argument: ${arg}`, { exit: EXIT_USAGE });
  }
  return options;
}

/** Runs a tool with a bounded wait. */
function run(
  label,
  command,
  args,
  { cwd = ROOT, timeout, capture = false } = {},
) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    timeout,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  const elapsedMs = Date.now() - started;
  if (result.error)
    throw new BuildError(
      `${label} could not run (${command}, ${elapsedMs} ms)`,
      { cause: result.error },
    );
  if (result.signal)
    throw new BuildError(
      `${label} stopped by ${result.signal} after ${elapsedMs} ms (limit ${timeout} ms)`,
    );
  if (result.status !== 0)
    throw new BuildError(
      `${label} failed with exit ${result.status} after ${elapsedMs} ms${capture ? `: ${result.stderr.trim()}` : ""}`,
    );
  return capture ? result.stdout.trim() : "";
}

/** The clone, checked: buzz-app, at the pinned revision, no local edits under
 * src/, packages installed. */
function clone() {
  const given = resolve(process.env.BUZZ_APP_DIR || CLONE_LINK);
  if (!existsSync(given))
    throw new BuildError(
      `no buzz-app clone at ${given}: set BUZZ_APP_DIR or link it (README, "Build")`,
      { exit: EXIT_CONFIG },
    );
  // The real path: the bundler names modules by it, and the swaps match on it.
  const dir = realpathSync(given);
  const pkg = join(dir, "package.json");
  if (
    !existsSync(pkg) ||
    JSON.parse(readFileSync(pkg, "utf8")).name !== EXPECTED_PACKAGE
  )
    throw new BuildError(
      `no buzz-app clone at ${dir}: set BUZZ_APP_DIR or link it (README, "Build")`,
      { exit: EXIT_CONFIG },
    );
  const head = run("git rev-parse", "git", ["-C", dir, "rev-parse", "HEAD"], {
    timeout: GIT_TIMEOUT_MS,
    capture: true,
  });
  if (!head.startsWith(BUZZ_APP_REV))
    throw new BuildError(
      `buzz-app clone is at ${head.slice(0, 12)}, not ${BUZZ_APP_REV}: check out the pinned revision`,
      { exit: EXIT_CONFIG },
    );
  const dirty = run(
    "git status",
    "git",
    ["-C", dir, "status", "--porcelain", "--", "src"],
    { timeout: GIT_TIMEOUT_MS, capture: true },
  );
  if (dirty)
    throw new BuildError(
      `buzz-app clone has local edits under src/:\n${dirty}`,
      { exit: EXIT_CONFIG },
    );
  if (!existsSync(join(dir, "node_modules", "vite")))
    throw new BuildError(
      `buzz-app clone has no packages: run 'bin/pnpm install --frozen-lockfile --ignore-scripts' in ${dir}`,
      { exit: EXIT_CONFIG },
    );
  return dir;
}

/** Resolves the swapped modules, by absolute path, from any importer except
 * the replacement itself (src/sessions.ts imports the original). */
function swapPlugin(app) {
  const swaps = new Map(
    Object.entries(SWAPS).map(([from, to]) => [
      join(app, "src", from),
      join(ROOT, to),
    ]),
  );
  return {
    name: "hermes-swaps",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved) return null;
      const bare = resolved.id.replace(/\.(ts|tsx)$/, "");
      const target = swaps.get(bare);
      if (!target || importer === target) return null;
      return target;
    },
  };
}

async function bundle(app, out) {
  const { build } = await import(
    pathToFileURL(join(app, "node_modules", "vite", "dist", "node", "index.js"))
      .href
  );
  const result = await build({
    configFile: false,
    root: ROOT,
    logLevel: "warn",
    resolve: { alias: { "@app": join(app, "src") } },
    plugins: [swapPlugin(app)],
    // buzz-app modules read Vite build inputs; an installed plugin has none.
    define: { "import.meta.env.VITE_BUZZ_DATABRICKS_HOST": "undefined" },
    build: {
      write: false,
      target: "es2022",
      minify: false,
      lib: { entry: ENTRY, formats: ["es"], fileName: () => OUT_NAME },
      rollupOptions: { output: { codeSplitting: false } },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const chunk = output.find((item) => item.type === "chunk" && item.isEntry);
  if (!chunk || output.some((item) => item.type === "chunk" && item !== chunk))
    throw new BuildError("the bundle is not one module");
  const bad = Object.keys(chunk.modules).filter((id) =>
    FORBIDDEN.some((re) => re.test(id)),
  );
  if (bad.length)
    throw new BuildError(
      `the bundle holds app modules it must not copy:\n${bad.join("\n")}`,
    );
  if (chunk.imports.length || chunk.dynamicImports.length)
    throw new BuildError(
      `the bundle imports other modules: ${[...chunk.imports, ...chunk.dynamicImports].join(", ")}`,
    );
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, OUT_NAME), chunk.code);
  copyFileSync(MANIFEST, join(out, "manifest.json"));
  console.log(
    `built ${join(out, OUT_NAME)} (${Math.round(chunk.code.length / 1024)} KiB, buzz-app ${BUZZ_APP_REV})`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const app = clone();
  run(
    "type check",
    join(app, "node_modules", ".bin", "tsc"),
    ["--noEmit", "-p", join(ROOT, "tsconfig.json")],
    {
      timeout: TSC_TIMEOUT_MS,
    },
  );
  if (!options.checkOnly) await bundle(app, options.out);
}

main().catch((error) => {
  console.error(`build-plugin: ${error.message}`);
  if (error.cause) console.error(error.cause);
  process.exit(error.exit ?? 1);
});
