#!/usr/bin/env node
// End-to-end smoke run of the built plugin against this computer's real
// Hermes, outside the app. It loads dist/plugin.js as Buzz loads it, with a
// stand-in for the parts of the app the plugin uses: the manifest's process
// grant (`hermes acp`), a loopback MCP server, agent storage and an agent
// handle that records what it would publish instead of signing it.
//
// Why: the plugin's value is the path from a Buzz turn to Hermes and back
// through Buzz tools. Type checks and a bundle cannot prove that path; this
// run proves the model picker reads Hermes' models, a turn starts a Hermes ACP
// session on the chosen model, and Hermes answers through the Buzz `send` tool.
// The model picker is the app's own, bundled: it renders with real React in
// a jsdom window, both from the buzz-app clone the plugin is built from.
//
// It writes nothing outside a temporary workspace and touches no relay: the
// agent handle publishes to memory only. Hermes itself runs with the user's
// own Hermes setup, so its provider is called and billed as usual.
//
// Usage: node smoke/run.mjs [--plugin <dir>] [--model <id>] [--skip-turn]
//   --plugin <dir>  the built plugin directory (default: dist/)
//   --model <id>    run the turn on this listed model, which proves the model
//                   switch (default: the model Hermes' config picks)
//   --skip-turn     only check model discovery (no model call)
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** How long model discovery may take: one `hermes acp` start and session. */
const DISCOVERY_TIMEOUT_MS = 2 * 60_000;
/** How long the turn may take, model call included. */
const TURN_TIMEOUT_MS = 5 * 60_000;
/** How long a stopped process may take to exit before it is killed. */
const KILL_GRACE_MS = 3_000;
/** The largest MCP request body accepted, as a loopback server should cap it. */
const MCP_BODY_LIMIT = 1024 * 1024;
const LOOPBACK = "127.0.0.1";
/** The header the app's host names an MCP session with (src-tauri host_mcp). */
const MCP_SESSION_HEADER = "mcp-session-id";
/** An ACP request's method in the plugin's JSON-RPC output. */
const METHOD_RE = /"method":"([^"]+)"/g;
/** The buzz-app clone link (scripts/link-toolchain): React, its renderer and
 * jsdom come from there, the versions the plugin is built and run with. */
const APP_LINK = join(ROOT, "buzz-app");
/** How often the run looks at the rendered model picker. */
const DOM_POLL_MS = 100;
/** The window members the app's components read as globals. */
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
  "matchMedia",
];
const AGENT_NAME = "HermesSmoke";
const EXIT_FAIL = 1;
const EXIT_USAGE = 64;

/** A smoke check that failed, with what it saw. */
class SmokeError extends Error {
  constructor(message, { exit = EXIT_FAIL, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SmokeError";
    this.exit = exit;
  }
}

function parseArgs(argv) {
  const options = { plugin: join(ROOT, "dist"), turn: true, model: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-turn") options.turn = false;
    else if (arg === "--plugin") {
      if (!argv[i + 1])
        throw new SmokeError("--plugin needs a directory", {
          exit: EXIT_USAGE,
        });
      options.plugin = resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--model") {
      if (!argv[i + 1])
        throw new SmokeError("--model needs a model id", { exit: EXIT_USAGE });
      options.model = argv[i + 1];
      i += 1;
    } else
      throw new SmokeError(`unknown argument: ${arg}`, { exit: EXIT_USAGE });
  }
  return options;
}

const log = (step, detail = "") =>
  console.log(`smoke: ${step}${detail ? ` ${detail}` : ""}`);
const hex = (bytes) => randomBytes(bytes).toString("hex");
const expand = (path, cwd = homedir()) =>
  path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : isAbsolute(path)
        ? path
        : join(cwd, path);

/** Rejects after `ms`, naming what took too long. */
function deadline(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new SmokeError(`${what} took longer than ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The desktop host's process grant, as the app enforces it: only the
 * manifest's processes, only with the arguments it declares. */
function processHost(manifest, children, methods, stdout) {
  const declared = new Map(
    manifest.host.processes.map((entry) => [entry.id, entry]),
  );
  return (id, options = {}) => {
    const entry = declared.get(id);
    if (!entry)
      return Promise.reject(
        new SmokeError(`process ${id} is not in the manifest`),
      );
    const args = options.args ?? entry.args ?? [];
    if (JSON.stringify(args) !== JSON.stringify(entry.args ?? []))
      return Promise.reject(
        new SmokeError(
          `process ${id} asked for undeclared arguments ${JSON.stringify(args)}`,
        ),
      );
    const env = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {}))
      if (value === null) delete env[key];
      else env[key] = value;
    const cwd = options.cwd ? expand(options.cwd) : homedir();
    mkdirSync(cwd, { recursive: true });
    const child = spawn(entry.program, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      // Hermes' answers, to read its model list as the picker got it.
      stdout.push(data);
      options.onStdout?.(data);
    });
    child.stderr.on("data", (data) => options.onStderr?.(data));
    const exited = new Promise((done) => {
      child.on("exit", (code) => {
        children.delete(child);
        done(code);
      });
      child.on("error", (error) => {
        children.delete(child);
        options.onStderr?.(`${error.message}\n`);
        done(null);
      });
    });
    // The ACP methods the plugin calls, as evidence of what the turn did.
    const write = (data) => {
      for (const [, method] of String(data).matchAll(METHOD_RE))
        methods.push(method);
      return new Promise((done, fail) =>
        child.stdin.write(data, (error) => (error ? fail(error) : done())),
      );
    };
    return Promise.resolve({
      write,
      end: async (data) => {
        if (data) await write(data);
        child.stdin.end();
      },
      kill: () => stop(child, exited),
      exited,
    });
  };
}

/** Asks a process to stop, then kills it after a grace period. */
async function stop(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

/** A loopback MCP server (Streamable HTTP, JSON answers) that hands each
 * message to the plugin, as the app's host does. Requests without the
 * server's token are refused. Like the host, a token admits one MCP session:
 * a second `initialize` stops the server unless the plugin asked for a shared
 * session, so a harness that reconnects fails here as it fails in the app. */
function mcpHost(servers) {
  return (handler, options) =>
    new Promise((ready, fail) => {
      const token = hex(32);
      const expected = Buffer.from(`Bearer ${token}`);
      let resolveClosed;
      const closed = new Promise((done) => {
        resolveClosed = done;
      });
      let session;
      let handle;
      const server = createServer((request, response) => {
        const given = Buffer.from(request.headers.authorization ?? "");
        if (
          given.length !== expected.length ||
          !timingSafeEqual(given, expected)
        ) {
          response.writeHead(401).end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST" }).end();
          return;
        }
        const chunks = [];
        let size = 0;
        const sent = request.headers[MCP_SESSION_HEADER];
        request.on("data", (chunk) => {
          size += chunk.length;
          if (size > MCP_BODY_LIMIT) request.destroy();
          else chunks.push(chunk);
        });
        request.on("end", async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const messages = Array.isArray(body) ? body : [body];
            if (messages.some((m) => m.method === "initialize")) {
              if (session && !options?.sharedSession) {
                response.writeHead(404).end();
                void handle.close();
                return;
              }
              session ??= randomUUID();
            } else if (sent !== session) {
              response.writeHead(404).end();
              return;
            }
            const answers = (await Promise.all(messages.map(handler))).filter(
              (answer) => answer !== undefined,
            );
            if (!answers.length) {
              response.writeHead(202).end();
              return;
            }
            response.writeHead(200, {
              "content-type": "application/json",
              [MCP_SESSION_HEADER]: session,
            });
            response.end(
              JSON.stringify(Array.isArray(body) ? answers : answers[0]),
            );
          } catch (error) {
            response
              .writeHead(400, { "content-type": "text/plain" })
              .end(String(error?.message ?? error));
          }
        });
      });
      server.on("error", fail);
      server.on("close", () => resolveClosed());
      server.listen(0, LOOPBACK, () => {
        const { port } = server.address();
        handle = {
          url: `http://${LOOPBACK}:${port}/mcp`,
          headers: [{ name: "Authorization", value: `Bearer ${token}` }],
          close: () =>
            new Promise((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
          closed,
        };
        servers.add(handle);
        ready(handle);
      });
    });
}

/** Agent storage in memory, as the app's agent store behaves. */
function memoryStore() {
  const map = new Map();
  return {
    keys: () => [...map.keys()],
    get: (key) => map.get(key) ?? null,
    set: async (key, value) =>
      value === null ? map.delete(key) : map.set(key, value),
    add: async (key, value) => {
      if (!map.has(key)) map.set(key, value);
      return map.get(key);
    },
  };
}

/** `localStorage` for Node, which has none without a flag. */
function memoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

/** The React, renderer and window the views run with: real React and
 * react-dom from the buzz-app clone (the version Buzz runs, which the plugin
 * checks), and a jsdom window in place of the app's. */
function appRuntime() {
  const require = createRequire(join(APP_LINK, "package.json"));
  const { JSDOM } = require("jsdom");
  const { window } = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  // jsdom has no media queries; the app's motion reads one for reduced motion.
  window.matchMedia ??= () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  for (const name of DOM_GLOBALS)
    Object.defineProperty(globalThis, name, {
      value: name === "window" ? window : window[name],
      configurable: true,
      writable: true,
    });
  return {
    react: require("react"),
    client: require("react-dom/client"),
    root: window.document.getElementById("root"),
  };
}

/** The model state of Hermes' `session/new` answers in its output, or
 * undefined before one came. */
function sessionModels(stdout) {
  for (const line of stdout.join("").split("\n")) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const state = message?.result?.models;
    if (!Array.isArray(state?.availableModels)) continue;
    return {
      models: state.availableModels.map(({ modelId, name }) => ({
        id: modelId,
        label: name ?? modelId,
      })),
      ...(state.currentModelId ? { current: state.currentModelId } : {}),
    };
  }
  return undefined;
}

/** An agent handle that records what it would publish. Buzz tools that need
 * a connected community fail as they do when it is offline. */
function recordingHandle(published) {
  const pubkey = hex(32);
  return {
    key: pubkey,
    pubkey,
    name: AGENT_NAME,
    owner: hex(32),
    publish: async (event) => {
      const signed = {
        ...event,
        id: hex(32),
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        sig: "",
      };
      published.push(signed);
      return signed;
    },
    query: async () => [],
    searchProfiles: async () => [],
    tabs: () => undefined,
  };
}

/** Waits for the model picker's read to finish. */
/** What the picker shows for the default choice: the name of the model
 * Hermes' config picks, or the plain default. */
const currentLabel = ({ models, current }) =>
  current
    ? (models.find((model) => model.id === current)?.label ?? current)
    : "Hermes default";

async function discoverModels(type, app, stdout) {
  const root = app.client.createRoot(app.root);
  root.render(
    app.react.createElement(type.CreateModel, {
      config: {},
      onChange: () => {},
      disabled: false,
    }),
  );
  try {
    const started = Date.now();
    for (;;) {
      const alert = app.root.querySelector('[role="alert"]');
      if (alert)
        throw new SmokeError(`model discovery failed: ${alert.textContent}`);
      // Done when the picker shows the model Hermes' config picks, so the
      // view has the list, not only the process.
      const discovery = sessionModels(stdout);
      const shown = app.root.querySelector("button")?.textContent ?? "";
      if (discovery && shown.includes(currentLabel(discovery)))
        return { discovery, shown };
      if (Date.now() - started > DISCOVERY_TIMEOUT_MS)
        throw new SmokeError(
          `model discovery took longer than ${DISCOVERY_TIMEOUT_MS} ms; the picker shows "${shown}"`,
        );
      await new Promise((done) => setTimeout(done, DOM_POLL_MS));
    }
  } finally {
    root.unmount();
  }
}

/** One standalone turn that must answer through the Buzz `send` tool. */
async function turn(type, agent, handle, published) {
  const channel = randomUUID();
  const nonce = hex(8);
  const text = `hermes-smoke ${nonce}`;
  const prompt = [
    "This is an automated smoke test of the Buzz tools.",
    `Call the Buzz tool \`send\` exactly once, with channel "${channel}", audience "agents" and text "${text}".`,
    "Do not run commands, read files or call any other tool. After the send, stop.",
  ].join("\n");
  const result = await deadline(
    type.runOnce({
      delivery: { agent: handle, config: agent.config, team: "" },
      key: "smoke",
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      prompt: async () => prompt,
    }),
    TURN_TIMEOUT_MS,
    "the turn",
  );
  if (!result.ok)
    throw new SmokeError(
      `the turn failed: ${result.error ?? "no error given"}`,
    );
  const sent = published.find(
    (event) =>
      event.content.includes(text) &&
      event.tags.some(([key, value]) => key === "h" && value === channel),
  );
  if (!sent)
    throw new SmokeError(
      `Hermes did not post through \`send\`; published: ${JSON.stringify(published, null, 2)}`,
    );
  return { kind: sent.kind, content: sent.content };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(
    readFileSync(join(options.plugin, "manifest.json"), "utf8"),
  );
  const plugin = await import(
    pathToFileURL(join(options.plugin, "plugin.js")).href
  );
  const children = new Set();
  const methods = [];
  const listeners = new Set();
  const servers = new Set();
  const cleanups = [];
  const workspace = mkdtempSync(join(tmpdir(), "hermes-smoke-"));
  // Node's own localStorage needs a file flag and warns on each read; the
  // app's is per profile, so a fresh one in memory stands in for it.
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  const published = [];
  const types = [];
  const app = appRuntime();
  const stdout = [];
  const agent = {
    key: undefined,
    type: `${manifest.id}/${plugin.TYPE_ID}`,
    name: AGENT_NAME,
    config: { workspace },
  };
  const handle = recordingHandle(published);
  agent.key = handle.key;
  const ctx = {
    pluginOwner: { id: manifest.id },
    react: app.react,
    effect: (setup) => cleanups.push(setup()),
    host: {
      spawn: processHost(manifest, children, methods, stdout),
      serveMcp: mcpHost(servers),
      resolveDirectory: async (path) => {
        const dir = expand(path);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      readFile: async (path, { cwd } = {}) =>
        new Uint8Array(
          readFileSync(expand(path, cwd ? expand(cwd) : homedir())),
        ),
    },
    agents: {
      register: (type) => types.push(type),
      relay: () => undefined,
      core: async () => undefined,
      tools: () => [],
      storage: memoryStore(),
      snapshot: () => ({ status: "ready", running: [agent] }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  try {
    plugin.apply(ctx);
    const [type] = types;
    if (types.length !== 1 || type.id !== plugin.TYPE_ID)
      throw new SmokeError(
        `expected one ${plugin.TYPE_ID} type, got ${types.length}`,
      );
    log("registered", `${agent.type} "${type.title}"`);
    const { discovery, shown } = await discoverModels(type, app, stdout);
    if (!discovery.models.length)
      throw new SmokeError("Hermes listed no models");
    log(
      "models",
      `${discovery.models.length} listed, current ${discovery.current ?? "(none)"}, picker shows "${shown}"`,
    );
    if (!options.turn) return;
    if (
      options.model &&
      !discovery.models.some((entry) => entry.id === options.model)
    )
      throw new SmokeError(`Hermes does not list the model ${options.model}`);
    const model = options.model ?? discovery.current ?? discovery.models[0].id;
    // A model is an agent setting, which the app hands the runtime as a
    // changed agent, as when the owner saves it.
    agent.config = { ...agent.config, model };
    for (const listener of listeners) listener();
    const sent = await turn(type, agent, handle, published);
    log(
      "turn",
      `model ${model}: Hermes sent kind ${sent.kind}: ${JSON.stringify(sent.content)}`,
    );
    log("acp", [...new Set(methods)].join(", "));
  } finally {
    for (const cleanup of cleanups)
      if (typeof cleanup === "function") cleanup();
    await Promise.all([...servers].map((server) => server.close()));
    await Promise.all(
      [...children].map((child) =>
        stop(child, new Promise((done) => child.on("exit", done))),
      ),
    );
    rmSync(workspace, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`smoke: FAILED: ${error.message}`);
    if (error.cause) console.error(error.cause);
    process.exit(error.exit ?? EXIT_FAIL);
  },
);
