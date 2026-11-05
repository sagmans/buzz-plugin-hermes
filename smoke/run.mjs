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
// a jsdom window, both from this repository's lockfile.
//
// It writes nothing outside a temporary workspace and touches no relay: the
// agent handle publishes to memory only. Hermes itself runs with the user's
// own Hermes setup, so its provider is called and billed as usual.
//
// It starts with what real Hermes cannot show on demand or free of charge, the
// same built plugin against a stand-in process (smoke/stub.mjs): what the
// Activity record and tab show for a steer, per-turn usage from Hermes' running
// totals, and how the provider row and dialog read a missing program or gateway.
// Those checks call no model.
//
// Usage: node smoke/run.mjs [--plugin <dir>] [--model <id>] [--route <id>]
//                           [--effort <level>] [--skip-turn] [--controls]
//                           [--stub-only]
//   --plugin <dir>  the built plugin directory (default: dist/)
//   --model <id>    run the turn on this listed model, which proves the model
//                   switch (default: the model Hermes' config picks)
//   --route <id>    the `provider:model` id --model must reach. The run stops
//                   with no model call on another route, and refuses any prompt
//                   before that session's switch
//   --effort <level> the effort Hermes' config must set for --model
//   --skip-turn     only check model discovery (no model call)
//   --controls      after the turn, steer a running turn and compact its
//                   session. More model calls and a slower run, so it is not
//                   part of `scripts/check`
//   --stub-only     only the stand-in's checks: no Hermes, no model call
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMPRESS_NOOP,
  COMPRESSED,
  OTHER_MODEL,
  STEER_ECHO as STUB_STEER_ECHO,
  StubHermes,
  STUB_MODEL,
  STUB_MODEL_NAME,
} from "./stub.mjs";

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
/** How the bundle carries the Settings icon: one file, no asset to load. */
const ICON_DATA_URL = "data:image/png;base64,";
/** How long the steered turn's shell command runs: time to steer it. */
const CONTROLS_SLEEP_SECONDS = 20;
/** Hermes' update that shows a turn runs and has started a tool. */
const TOOL_CALL_RE = /"sessionUpdate":\s*"tool_call"/;
/** Hermes' reply to a steer, which must never reach Buzz. */
const STEER_ECHO = "Steer queued";
const STEER_PROMPT = "/steer ";
const COMPRESS_PROMPT = "/compress";
const COMPACT_PROMPT = "/compact";
const CHAT_KIND = 9;
/** A model id for the synced settings check only; no turn runs on it. */
const SYNCED_MODEL = "smoke:synced";
/** The plugin's agent storage key of an agent's activity record. */
const ACTIVITY_PREFIX = "sagmans.hermes.activity.v1:";
/** The method a steer's frame carries, which the app shows as a steer. */
const STEER_FRAME_METHOD = "_session/steering";
/** A reply only a real Markdown renderer draws as a bold word and a table. */
const MARKDOWN_REPLY = "**Done**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
/** Finds the Activity tab's way back from an open transcript. */
const BACK_BUTTON = 'button[aria-label="Back to profile"]';
/** Finds a row of the Activity tab's session list. */
const VIEW_BUTTON = 'button[aria-label^="View transcript"]';
/** The gateway's state file, as the plugin asks the host for it. */
const GATEWAY_STATE_PATH = "~/.hermes/gateway_state.json";
/** Hermes' config, the only place that sets a model's effort. */
const HERMES_CONFIG_PATH = "~/.hermes/config.yaml";
/** Bounds the route check, which starts a session but calls no model. */
const ROUTE_TIMEOUT_MS = 120_000;
/** Older than Hermes' own bound on that file's stamp. */
const STALE_STATE_MS = 10 * 60_000;
/** The manifest's id of the `hermes acp` process. */
const HERMES_PROCESS = "hermes";
/** Hermes' words when a session finds no gateway. */
const GATEWAY_REFUSAL = "Gateway inaccessible: authorization";
const CHECK_AGAIN = "Check again";
/** Stand-in checks run in moments; a wait this long means a hang. */
const STUB_TIMEOUT_MS = 30_000;
/** The turns a transcript shows. */
const TURN_LIMIT = 50;
/** The local storage key of the plugin's session log. */
const SESSION_LOG_KEY = "sagmans.hermes.history.v1";
/** Longer than the record keeps a string, so seeing all of it proves the read. */
const LONG_TEXT_CHARS = 20_000;
const LONG_TEXT_END = "end-of-long-reply";
/** Past the turns a transcript shows, so that it says there are more. */
const OLD_TURNS = 60;
/** The sessions the tab reads for one conversation. */
const SESSION_READ_LIMIT = 10;
/** More old sessions than it reads. */
const OLD_SESSIONS = 12;
/** Bounds the separate process that loads the plugin with no window. */
const BARE_LOAD_TIMEOUT_MS = 60_000;
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
  const options = {
    plugin: join(ROOT, "dist"),
    turn: true,
    controls: false,
    stubOnly: false,
    model: undefined,
    route: undefined,
    effort: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-turn") options.turn = false;
    else if (arg === "--controls") options.controls = true;
    else if (arg === "--stub-only") options.stubOnly = true;
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
    } else if (arg === "--route" || arg === "--effort") {
      if (!argv[i + 1])
        throw new SmokeError(`${arg} needs a value`, { exit: EXIT_USAGE });
      options[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else
      throw new SmokeError(`unknown argument: ${arg}`, { exit: EXIT_USAGE });
  }
  if ((options.route || options.effort) && !options.model)
    throw new SmokeError("--route and --effort need --model", {
      exit: EXIT_USAGE,
    });
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
function processHost(manifest, children, methods, stdout, prompts, guard) {
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
      guard?.answered(data);
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
      try {
        guard?.written(data);
      } catch (error) {
        return stop(child, exited).then(() => {
          throw error;
        });
      }
      for (const [, method] of String(data).matchAll(METHOD_RE))
        methods.push(method);
      prompts.push(...promptTexts(data));
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

/**
 * Stops a prompt from leaving unless its session switched to the routed model.
 *
 * Why here: a session starts on Hermes' default provider, so one prompt sent
 * before a switch, or after a refused one, spends on the wrong plan. Only the
 * process boundary sees every prompt the plugin writes, whichever path sent it.
 */
function routeGuard(model) {
  const pending = new Map();
  const switched = new Set();
  let partial = "";
  return {
    /** Throws for a prompt whose session did not switch; it is never written. */
    written(data) {
      for (const line of String(data).split("\n").filter(Boolean)) {
        const { id, method, params } = JSON.parse(line);
        if (method === "session/set_model" && params?.modelId === model)
          pending.set(id, params.sessionId);
        if (method === "session/prompt" && !switched.has(params?.sessionId))
          throw new SmokeError(
            `a prompt without the switch to ${model}: refused, so no model call`,
          );
      }
    },
    /** Lines can split across chunks, so an answer is read only when whole. */
    answered(data) {
      const lines = (partial + data).split("\n");
      partial = lines.pop();
      for (const line of lines) {
        const answer = parseJsonLine(line);
        if (pending.has(answer?.id) && answer.result)
          switched.add(pending.get(answer.id));
        if (answer) pending.delete(answer.id);
      }
    },
  };
}

/** One line of Hermes' output as JSON, or null: it can also print plain text. */
function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Sends one request to a Hermes process and waits for its answer. */
function acpRequest(child, state, method, params) {
  state.next += 1;
  const id = state.next;
  return new Promise((done, fail) => {
    state.waiting.set(id, { done, fail });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });
}

/**
 * Proves on the real gateway where the switch goes, and sends no prompt.
 *
 * Why: Hermes answers success for an id that stays on the default provider. It
 * reads `zai:<model>` as a model name on that provider, so only the session's
 * current model after the switch shows the route. A wrong route stops the run
 * before the plugin starts its turn.
 */
async function checkRoute(entry, model, route) {
  const child = spawn(entry.program, entry.args, {
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise((done) => child.on("exit", done));
  const state = { next: 0, waiting: new Map(), partial: "" };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    const lines = (state.partial + data).split("\n");
    state.partial = lines.pop();
    for (const answer of lines.map(parseJsonLine)) {
      const waiter = state.waiting.get(answer?.id);
      if (!waiter) continue;
      if (answer.error)
        waiter.fail(new SmokeError(JSON.stringify(answer.error)));
      else waiter.done(answer.result);
    }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), ROUTE_TIMEOUT_MS);
  const closed = exited.then(() => {
    throw new SmokeError(`Hermes stopped before the route check of ${route}`);
  });
  const call = (method, params) =>
    Promise.race([acpRequest(child, state, method, params), closed]);
  try {
    await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const made = await call("session/new", { cwd: tmpdir(), mcpServers: [] });
    const session = { sessionId: made.sessionId };
    await call("session/set_model", { ...session, modelId: model });
    const after = await call("session/resume", {
      ...session,
      cwd: tmpdir(),
      mcpServers: [],
    });
    const current = after.models?.currentModelId;
    if (current !== route)
      throw new SmokeError(`model ${model} routes to ${current}, not ${route}`);
    log("route", `${model} routes to ${current}, with no model call`);
  } finally {
    clearTimeout(timer);
    closed.catch(() => {});
    await stop(child, exited);
  }
}

/**
 * Proves Hermes' config sets the effort this run asks for.
 *
 * Why: ACP has no effort setting, and Hermes silently uses its global effort
 * for a model with no override, so a run could pass at the wrong effort.
 */
function checkEffort(model, effort) {
  const config = readFileSync(expand(HERMES_CONFIG_PATH), "utf8");
  if (
    !new RegExp(
      `^\\s+${model.replaceAll(".", "\\.")}:\\s*${effort}\\s*$`,
      "m",
    ).test(config)
  )
    throw new SmokeError(
      `Hermes' config has no agent.reasoning_overrides line ${model}: ${effort}`,
    );
}

/** The text of each `session/prompt` in what the plugin writes to Hermes. */
function promptTexts(data) {
  return String(data)
    .split("\n")
    .filter((line) => line.includes('"session/prompt"'))
    .map((line) => JSON.parse(line).params?.prompt?.[0]?.text ?? "");
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
 * react-dom from this repository's lockfile (the version Buzz runs, which the
 * plugin checks), and a jsdom window in place of the app's. */
function appRuntime() {
  const require = createRequire(join(ROOT, "package.json"));
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

/** The parts of the native agent type the plugin takes over, which need no
 * model call: per-message model picks and synced settings. */
async function checkNativeParity(type, agent, discovery) {
  const picks = await type.models(agent);
  const listed = (models) => models.map(({ id }) => id).join();
  if (listed(picks.models) !== listed(discovery.models))
    throw new SmokeError(
      `the per-message picks differ from Hermes' models: ${listed(picks.models)}`,
    );
  if (picks.current !== (discovery.current ?? ""))
    throw new SmokeError(`the picks rest on ${picks.current}, not the default`);
  const synced = type.syncedSettings?.withSynced(agent.config, {
    model: SYNCED_MODEL,
  });
  if (synced?.model !== SYNCED_MODEL)
    throw new SmokeError("the type does not take synced settings");
  log("parity", `${picks.models.length} picks, synced settings apply`);
}

/** One turn for a message, as the app delivers it, that must answer through the
 * Buzz `send` tool. A message and not a bare prompt: only a Buzz prompt says
 * which agent a turn is for, which the Activity record needs. */
async function turn(type, agent, handle, published) {
  const channel = randomUUID();
  const nonce = hex(8);
  const text = `hermes-smoke ${nonce}`;
  const prompt = [
    "This is an automated smoke test of the Buzz tools.",
    `Call the Buzz tool \`send\` exactly once, with channel "${channel}", audience "agents" and text "${text}".`,
    "Do not run commands, read files or call any other tool. After the send, stop.",
  ].join("\n");
  const outcome = await deadline(
    mention(type, agent, handle, channel, prompt),
    TURN_TIMEOUT_MS,
    "the turn",
  );
  if (outcome && outcome.ok === false)
    throw new SmokeError(
      `the turn failed: ${outcome.error ?? "no error given"}`,
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
  return { kind: sent.kind, content: sent.content, channel, nonce };
}

/** The real turn on the record and on the Activity tab's data: filed under its
 * channel, with the tool call it made, its model's name, and no MCP credential.
 * Returns its session's id. */
function checkLiveActivity(type, agent, storage, { channel, nonce }) {
  const { history } = type.tabs.find((tab) => tab.id === "activity").component;
  const row = history.find(agent.key, { channelId: channel });
  if (!row)
    throw new SmokeError(
      `the channel's session is not on record: ${JSON.stringify(history.recent(agent.key))}`,
    );
  const { turns } = history.transcript(agent.key, row.sessionId);
  const shown = turns.find((item) => JSON.stringify(item).includes(nonce));
  if (!shown)
    throw new SmokeError(
      `the transcript lacks the turn: ${turns.length} turns`,
    );
  if (shown.channelId !== channel)
    throw new SmokeError(`the turn is filed under ${shown.channelId}`);
  const kinds = shown.items.map((item) => item.type);
  if (!kinds.includes("tool"))
    throw new SmokeError(`the transcript shows no tool call: ${kinds}`);
  if (!shown.config?.length)
    throw new SmokeError("the transcript names no model");
  const record = storage.get(`${ACTIVITY_PREFIX}${agent.key}`) ?? "";
  if (!record.includes(nonce))
    throw new SmokeError("the record lacks the turn");
  if (/bearer/i.test(record))
    throw new SmokeError("the record holds an MCP credential");
  log(
    "activity",
    `${turns.length} turn(s), ${shown.config.join(", ")}, ${kinds.join(",")}; record ${record.length} bytes`,
  );
  return row.sessionId;
}

/** What Hermes itself answered to each prompt, for a failure's report: no text
 * of the turn, only how it ended and the counters it gave. */
function promptAnswers(stdout) {
  return stdout
    .join("")
    .split("\n")
    .flatMap((line) => {
      try {
        const { id, result } = JSON.parse(line);
        return result?.stopReason
          ? [{ id, stopReason: result.stopReason, usage: result.usage }]
          : [];
      } catch {
        return [];
      }
    });
}

/** The real turn's use, as the app's usage reads it: real tokens, and no cost,
 * as Hermes reports none. */
async function checkLiveUsage(type, agent, sessionId, model, stdout, pinned) {
  const read = await type.usage(agent, {
    since: 0,
    signal: new AbortController().signal,
  });
  const session = read.find((item) => item.id === sessionId);
  const seen = session?.observations[0];
  if (!seen || !(seen.tokens.input > 0) || !(seen.tokens.output > 0))
    throw new SmokeError(
      `usage reports no tokens: ${JSON.stringify(session)}; Hermes answered ${JSON.stringify(promptAnswers(stdout))}`,
    );
  if ("cost" in seen)
    throw new SmokeError(`a cost nobody reported: ${JSON.stringify(seen)}`);
  // Hermes' fallback providers can answer after the switch; only this shows it.
  if (pinned && seen.model !== model)
    throw new SmokeError(`the turn ran on ${seen.model}, not ${model}`);
  log(
    "usage",
    `${session.observations.length} observation(s), model ${seen.model} (asked ${model}), tokens ${JSON.stringify(seen.tokens)}`,
  );
}

/** Polls `test` until it holds. */
async function until(what, test, ms = TURN_TIMEOUT_MS) {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > ms)
      throw new SmokeError(`${what} took longer than ${ms} ms`);
    await new Promise((done) => setTimeout(done, DOM_POLL_MS));
  }
}

/** A message from the owner that mentions the agent, as the app delivers it.
 * Resolves with the outcome of the work it joined. */
async function mention(type, agent, handle, channel, content, model) {
  const working = [];
  await type.run({
    trigger: {
      type: "mention",
      event: {
        id: hex(32),
        pubkey: handle.owner,
        kind: CHAT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        content,
        tags: [["h", channel]],
        sig: "",
      },
    },
    channelId: channel,
    agent: handle,
    config: agent.config,
    team: "",
    // The owner's pick for this message, as the composer's model menu sends it.
    ...(model ? { model } : {}),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    workingUntil: (done) => working.push(done),
  });
  const [outcome] = await Promise.all(working);
  return outcome;
}

/** Steers a running turn and compacts its session, the two controls that only
 * real Hermes can prove: the guidance must reach the model, and the steer
 * reply must stay out of Buzz. */
/** The steer real Hermes took, on the Activity transcript: a steer inside the
 * turn it steered, with Hermes' own reply to it nowhere. */
function checkLiveSteerRecord(type, agent, channel, word) {
  const { history } = type.tabs.find((tab) => tab.id === "activity").component;
  const row = history.find(agent.key, { channelId: channel });
  const { turns = [] } = row
    ? history.transcript(agent.key, row.sessionId)
    : {};
  const steers = turns.flatMap(({ items }) =>
    items.filter((item) => item.steer === true),
  );
  if (steers.length !== 1 || !JSON.stringify(steers[0]).includes(word))
    throw new SmokeError(
      `the transcript shows ${steers.length} steers: ${JSON.stringify(steers)}`,
    );
  if (JSON.stringify(turns).includes(STEER_ECHO))
    throw new SmokeError("the transcript shows Hermes' steer reply");
  log("activity", `the steer shows as a steer in ${turns.length} turn(s)`);
}

async function controls(type, agent, handle, record) {
  const { published, prompts, stdout } = record;
  const channel = randomUUID();
  const word = `steered-${hex(4)}`;
  const marker = `hermes-controls ${hex(8)}`;
  const seen = stdout.length;
  const first = mention(
    type,
    agent,
    handle,
    channel,
    [
      "This is an automated smoke test of the Buzz tools.",
      `First run the shell command \`sleep ${CONTROLS_SLEEP_SECONDS}\`, once.`,
      `Then call the Buzz tool \`send\` exactly once, with channel "${channel}", audience "agents" and text "${marker}", followed by any word that a newer message asks you to add.`,
      "Do not call any other tool. After the send, stop.",
    ].join("\n"),
  );
  await until("the steered turn's tool call", () =>
    TOOL_CALL_RE.test(stdout.slice(seen).join("")),
  );
  const second = mention(
    type,
    agent,
    handle,
    channel,
    `Add the word ${word} to your send.`,
  );
  const outcomes = await deadline(
    Promise.all([first, second]),
    TURN_TIMEOUT_MS,
    "the steered turn",
  );
  if (outcomes.some((outcome) => outcome && outcome.ok === false))
    throw new SmokeError(`a message failed: ${JSON.stringify(outcomes)}`);
  if (!prompts.some((text) => text.startsWith(STEER_PROMPT)))
    throw new SmokeError("the second message was not steered");
  const sent = published.find((event) => event.content.includes(marker));
  if (!sent?.content.includes(word))
    throw new SmokeError(
      `the guidance did not reach the model; it sent: ${sent?.content}`,
    );
  if (published.some((event) => event.content.includes(STEER_ECHO)))
    throw new SmokeError("Hermes' steer reply reached Buzz");
  log("steer", `the turn took the guidance: ${JSON.stringify(sent.content)}`);
  checkLiveSteerRecord(type, agent, channel, word);
  const read = await checkLiveRead({ type, agent }, channel, word);
  if (steersIn(read.turns).length !== 1)
    throw new SmokeError(
      `after a read, ${steersIn(read.turns).length} steers show`,
    );
  const place = { channelId: channel };
  await until(
    "the session to fall idle",
    () => type.sessionControls.state(agent, place) === "idle",
  );
  await type.sessionControls.run(agent, place, "compact");
  if (!prompts.includes(COMPRESS_PROMPT) || prompts.includes(COMPACT_PROMPT))
    throw new SmokeError(`Hermes did not get ${COMPRESS_PROMPT}`);
  log("compact", "the session compacted through Hermes' own command");
}

/** A fresh load of the plugin on `spawn`, with the stand-ins for the app. The
 * query gives each load its own module, as each app run has. */
async function loadPlugin(options, manifest, app, spawn, load, readFile) {
  const url = pathToFileURL(join(options.plugin, "plugin.js"));
  url.searchParams.set("load", load);
  const plugin = await import(url.href);
  const workspace = mkdtempSync(join(tmpdir(), "hermes-smoke-"));
  const published = [];
  const handle = recordingHandle(published);
  const agent = {
    key: handle.key,
    type: `${manifest.id}/${plugin.TYPE_ID}`,
    name: AGENT_NAME,
    config: { workspace, scope: "channel" },
  };
  const storage = memoryStore();
  const types = [];
  const cleanups = [];
  const servers = new Set();
  plugin.apply({
    pluginOwner: { id: manifest.id },
    react: app.react,
    effect: (setup) => cleanups.push(setup()),
    host: {
      spawn,
      serveMcp: mcpHost(servers),
      resolveDirectory: async () => workspace,
      readFile: readFile ?? (async () => new Uint8Array()),
    },
    agents: {
      register: (type) => types.push(type),
      relay: () => undefined,
      core: async () => undefined,
      tools: () => [],
      storage,
      snapshot: () => ({ status: "ready", running: [agent] }),
      subscribe: () => () => {},
    },
  });
  return {
    type: types[0],
    agent,
    handle,
    storage,
    published,
    close: async () => {
      for (const cleanup of cleanups) cleanup?.();
      await Promise.all([...servers].map((server) => server.close()));
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** The agent's activity record, as agent storage holds it. */
function storedRecord({ storage, agent }) {
  return JSON.parse(storage.get(`${ACTIVITY_PREFIX}${agent.key}`) ?? "{}");
}

/** A turn the stand-in holds until `release`, so it can be steered. */
function heldPlan(plan = {}) {
  let release;
  const hold = new Promise((done) => {
    release = done;
  });
  return { plan: { ...plan, hold }, release };
}

/** A steer on the record: one turn, not two, with the guidance shown as a steer
 * and Hermes' echo nowhere. Also that the record names the session's model,
 * which Hermes reports only outside config options, and no MCP credential. */
async function checkStubSteer(stub, loaded) {
  const { type, agent, handle } = loaded;
  const channel = randomUUID();
  const guidance = `guidance-${hex(4)}`;
  const { plan, release } = heldPlan({ text: MARKDOWN_REPLY });
  stub.plans.push(plan);
  const first = mention(type, agent, handle, channel, "A first message.");
  await until("the stand-in's turn", () => stub.running === 1, STUB_TIMEOUT_MS);
  // The client steers only a run it has heard of, which comes with the first
  // output; it arrives on the next turn of the event loop.
  await new Promise((done) => setTimeout(done, DOM_POLL_MS));
  const second = mention(type, agent, handle, channel, `Please ${guidance}.`);
  await until(
    "the steer",
    () => stub.prompts.some((text) => text.startsWith(STEER_PROMPT)),
    STUB_TIMEOUT_MS,
  );
  release();
  await deadline(
    Promise.all([first, second]),
    STUB_TIMEOUT_MS,
    "the stand-in's steered turn",
  );
  const { turns = [] } = storedRecord(loaded);
  if (turns.length !== 1 || turns[0].endedAt === undefined)
    throw new SmokeError(
      `a steer must leave one ended turn; the record has ${JSON.stringify(turns.map(({ id, endedAt }) => ({ id, endedAt })))}`,
    );
  const [turn] = turns;
  const text = JSON.stringify(turn);
  const steers = turn.frames.filter(
    (frame) => frame.payload?.method === STEER_FRAME_METHOD,
  );
  if (steers.length !== 1 || !JSON.stringify(steers[0]).includes(guidance))
    throw new SmokeError(`the record holds no steer frame: ${text}`);
  if (JSON.stringify(steers[0]).includes(STEER_PROMPT))
    throw new SmokeError("the record shows Hermes' steer command");
  if (text.includes(STUB_STEER_ECHO))
    throw new SmokeError("the record holds Hermes' steer reply");
  if (turn.model !== STUB_MODEL || !text.includes(STUB_MODEL_NAME))
    throw new SmokeError(`the record names the model ${turn.model}: ${text}`);
  if (/bearer/i.test(JSON.stringify(storedRecord(loaded))))
    throw new SmokeError("the record holds an MCP credential");
  log("stub-steer", `one turn, ${steers.length} steer frame, no echo`);
}

/** The Activity tab of a loaded plugin, drawn by real React in the jsdom window:
 * the app's own layout and transcript, not the data behind them. */
async function openedTranscript(app, type, agent) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = app.client.createRoot(container);
  const { component } = type.tabs.find((tab) => tab.id === "activity");
  root.render(
    app.react.createElement(component, {
      agent,
      close: () => {},
      openConversation: () => {},
    }),
  );
  const button = () => container.querySelector(VIEW_BUTTON);
  await until("the Activity tab's session row", button, STUB_TIMEOUT_MS);
  button().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(
    "the transcript",
    () => container.querySelector("strong"),
    STUB_TIMEOUT_MS,
  );
  return { container, close: () => root.unmount() };
}

/** The plugin module loads with no DOM, in a process of its own because this one
 * has the jsdom window: the build keeps it so (`plainBuildAtLoad`), since a module
 * that touches `document` at load stops the plugin before it can say why. */
function checkLoadsWithoutDom(options) {
  const url = pathToFileURL(join(options.plugin, "plugin.js")).href;
  const loaded = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(url)});`],
    { encoding: "utf8", timeout: BARE_LOAD_TIMEOUT_MS },
  );
  if (loaded.status !== 0)
    throw new SmokeError(
      `the plugin does not load without a DOM: ${loaded.error ?? loaded.stderr}`,
    );
  log("bare-load", "the plugin loads with no DOM");
}

/** An open transcript takes the tab's place, and its back button returns the
 * list: left under the list, a long transcript would sit below every session. */
async function checkTranscriptLayout(container) {
  if (container.querySelector(VIEW_BUTTON))
    throw new SmokeError("the session list stays above an open transcript");
  const back = container.querySelector(BACK_BUTTON);
  if (!back) throw new SmokeError("an open transcript has no back button");
  back.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(
    "the session list after the back button",
    () => container.querySelector(VIEW_BUTTON),
    STUB_TIMEOUT_MS,
  );
}

/** What the tab shows for the steered turn: the reply as real Markdown, the steer
 * marked as one, nothing of Hermes' own steering or of the adapter's run ids. */
async function checkStubActivity(app, { type, agent }) {
  const { container, close } = await openedTranscript(app, type, agent);
  try {
    const shown = container.textContent;
    if (!container.querySelector("table td"))
      throw new SmokeError(`the reply's table is not a table: ${shown}`);
    if (!shown.includes("(steer)"))
      throw new SmokeError(`the steer does not show as one: ${shown}`);
    for (const hidden of [STUB_STEER_ECHO, STEER_PROMPT, "activeRunId"])
      if (shown.includes(hidden))
        throw new SmokeError(`the tab shows "${hidden}": ${shown}`);
    if (!shown.includes(STUB_MODEL_NAME))
      throw new SmokeError(`the tab names no model: ${shown}`);
    await checkTranscriptLayout(container);
    log(
      "stub-activity",
      "Markdown drawn, steer marked, no echo or run ids, back button",
    );
  } finally {
    close();
  }
}

/** ACP updates of a replay, as the stand-in says them. */
const userSaid = (text) => ({
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text },
});
const agentSaid = (text) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const steersIn = (turns) =>
  turns.flatMap(({ items }) => items.filter((item) => item.steer === true));

/** The tab's read of the conversation `row` is in: what it shows, and each read. */
async function tabRead({ type, agent }, row, working) {
  const { sessions } = type.tabs.find((tab) => tab.id === "activity").component;
  const from = sessions.conversation(agent.key, row);
  const signal = new AbortController().signal;
  const reads = await sessions.read(from, working, signal);
  return {
    from,
    reads,
    shown: sessions.shown(agent.key, from, reads, working),
  };
}

/** The harness's words win, whole, with the record's times; a steer stays a steer
 * whether a replay shows it as a plain user message or not at all; nothing of a
 * read goes on the record, and its process ends. */
async function checkHarnessTurns(stub, loaded, row, says) {
  const before = stub.processes.size;
  const longText = `${"x".repeat(LONG_TEXT_CHARS)}${LONG_TEXT_END}`;
  const replay = [userSaid(says.opening), agentSaid(longText)];
  for (const [name, updates] of [
    ["as a user message", [...replay, userSaid(says.steer)]],
    ["left out", replay],
  ]) {
    stub.replays.set(row.sessionId, updates);
    const { shown, reads } = await tabRead(loaded, row);
    if (reads.get(row.sessionId)?.status !== "read")
      throw new SmokeError(`no read: ${JSON.stringify([...reads])}`);
    const text = JSON.stringify(shown.turns);
    if (shown.turns.length !== 1 || !text.includes(longText))
      throw new SmokeError(`the replay is not what shows (${name}): ${text}`);
    if (steersIn(shown.turns).length !== 1)
      throw new SmokeError(`the steer is lost (${name}): ${text}`);
    const [turn] = shown.turns;
    if (!turn.startedAt || !turn.endedAt)
      throw new SmokeError(`no record times (${name}): ${text}`);
  }
  if (JSON.stringify(storedRecord(loaded)).includes(LONG_TEXT_END))
    throw new SmokeError("a read went on the record");
  if (stub.processes.size !== before)
    throw new SmokeError("a read left its process running");
}

/** A session that the harness cannot give, or that a turn runs in, shows as it is
 * on record; only a failure says so, and the running session is not read at all. */
async function checkHarnessFallback(stub, loaded, row) {
  stub.replays.set(row.sessionId, { error: "the store is locked" });
  const failing = await tabRead(loaded, row);
  if (failing.shown.failed.length !== 1 || !failing.shown.turns.length)
    throw new SmokeError(`a failed read: ${JSON.stringify(failing.shown)}`);
  if (steersIn(failing.shown.turns).length !== 1)
    throw new SmokeError("a failed read hides the record's steer");
  stub.replays.delete(row.sessionId);
  const absent = await tabRead(loaded, row);
  if (absent.shown.failed.length || !absent.shown.turns.length)
    throw new SmokeError(`an absent session: ${JSON.stringify(absent.shown)}`);
  const asked = stub.loads.length;
  const working = await tabRead(loaded, row, row.sessionId);
  if (stub.loads.length !== asked || !working.shown.turns.length)
    throw new SmokeError("the running session is read from the harness");
}

/** The log's sessions show too, and a conversation's sessions join, oldest first,
 * up to the app's limits. Saved as an earlier version of the plugin saved them. */
async function checkHarnessMerge(stub, loaded, row, says) {
  const { type, agent } = loaded;
  const { sessions } = type.tabs.find((tab) => tab.id === "activity").component;
  const key = row.root ? `${row.channelId}/${row.root}` : row.channelId;
  const old = Array.from({ length: OLD_SESSIONS }, (_, index) => ({
    sessionId: `old-${index}`,
    key,
    at: 1000 + index,
    workspace: "~/work",
  }));
  const log = JSON.parse(localStorage.getItem(SESSION_LOG_KEY) ?? "{}");
  log[agent.key] = [...(log[agent.key] ?? []), ...old];
  localStorage.setItem(SESSION_LOG_KEY, JSON.stringify(log));
  const newest = old.at(-1).sessionId;
  stub.replays.set(
    newest,
    Array.from({ length: OLD_TURNS }, (_, index) => [
      userSaid(`old turn ${index}`),
      agentSaid(`old answer ${index}`),
    ]).flat(),
  );
  stub.replays.set(row.sessionId, [userSaid(says.opening), agentSaid("New.")]);
  if (
    sessions
      .recent(agent.key)
      .filter((item) => item.channelId === row.channelId).length !== 1
  )
    throw new SmokeError("a conversation's sessions list as more than one");
  const { from, shown } = await tabRead(loaded, row);
  if (from.length !== SESSION_READ_LIMIT)
    throw new SmokeError(`read ${from.length} sessions`);
  const texts = JSON.stringify(shown.turns);
  if (shown.turns.length !== TURN_LIMIT || shown.more !== true)
    throw new SmokeError(`${shown.turns.length} turns, more ${shown.more}`);
  if (!JSON.stringify(shown.turns.at(-1)).includes("New."))
    throw new SmokeError(`the newest session is not last: ${texts}`);
  if (!texts.includes(`old turn ${OLD_TURNS - 1}`))
    throw new SmokeError(`the old session is not joined: ${texts}`);
  if (texts.includes('old turn 0"'))
    throw new SmokeError("turns past the limit show");
}

/** The tab itself: a read's words reach the screen, and a failed read says so
 * beside the record. */
async function checkHarnessPaint(app, stub, loaded, row, says) {
  stub.replays.set(row.sessionId, [
    userSaid(says.opening),
    agentSaid(`A whole reply ${LONG_TEXT_END}.`),
  ]);
  const read = await openedTranscript(app, loaded.type, loaded.agent);
  try {
    await until(
      "the harness's words in the tab",
      () => read.container.textContent.includes(LONG_TEXT_END),
      STUB_TIMEOUT_MS,
    );
    if (!read.container.textContent.includes("(steer)"))
      throw new SmokeError("the tab shows no steer after a read");
  } finally {
    read.close();
  }
  stub.replays.set(row.sessionId, { error: "the store is locked" });
  const failed = await openedTranscript(app, loaded.type, loaded.agent);
  try {
    await until(
      "the failed read's words in the tab",
      () => failed.container.querySelector('[role="alert"]'),
      STUB_TIMEOUT_MS,
    );
    if (!failed.container.textContent.includes("(steer)"))
      throw new SmokeError("the tab hides the record after a failed read");
  } finally {
    failed.close();
  }
}

/** What the Activity tab shows of a session Hermes reads back, on the session the
 * steer scenario left. The stand-in replays it; no model runs. */
async function checkStubHarnessRead(app, stub, loaded) {
  const { type, agent } = loaded;
  const { history } = type.tabs.find((tab) => tab.id === "activity").component;
  const [row] = history.recent(agent.key);
  const opening = stub.prompts.find((text) => !text.startsWith(STEER_PROMPT));
  const steered = stub.prompts.find((text) => text.startsWith(STEER_PROMPT));
  const says = { opening, steer: steered.slice(STEER_PROMPT.length) };
  await checkHarnessTurns(stub, loaded, row, says);
  await checkHarnessFallback(stub, loaded, row);
  await checkHarnessPaint(app, stub, loaded, row, says);
  await checkHarnessMerge(stub, loaded, row, says);
  log(
    "stub-read",
    "harness words whole, record times, steer kept, fallback, sessions joined",
  );
}

/** Real Hermes reads the session back: the tab shows the turn as Hermes kept it.
 * `session/load` costs no model call. */
async function checkLiveRead(loaded, channel, marker) {
  const { type, agent } = loaded;
  const { sessions } = type.tabs.find((tab) => tab.id === "activity").component;
  const row = sessions.find(agent.key, { channelId: channel });
  if (!row) throw new SmokeError("the session is not listed");
  const { reads, shown } = await tabRead(loaded, row);
  const read = reads.get(row.sessionId);
  if (read?.status !== "read" || !read.turns.length)
    throw new SmokeError(
      `Hermes did not read it back: ${JSON.stringify(read)}`,
    );
  if (shown.failed.length || !JSON.stringify(shown.turns).includes(marker))
    throw new SmokeError(
      `the read lacks the turn: ${shown.turns.length} turns`,
    );
  if (JSON.stringify(shown.turns).includes(STEER_ECHO))
    throw new SmokeError("the read shows Hermes' steer reply");
  log(
    "read",
    `${read.turns.length} turn(s) read back, ${steersIn(shown.turns).length} steer(s)`,
  );
  return shown;
}

/** One stand-in turn for `channel` that ends with these running totals. */
async function plannedTurn(stub, loaded, channel, running, model) {
  const { type, agent, handle } = loaded;
  stub.plans.push({ usage: running });
  const outcome = await deadline(
    mention(type, agent, handle, channel, "A message.", model),
    STUB_TIMEOUT_MS,
    "a stand-in turn",
  );
  if (outcome && outcome.ok === false)
    throw new SmokeError(`a stand-in turn failed: ${JSON.stringify(outcome)}`);
}

/** Hermes' usage object for running totals: inputs, outputs, cache reads. */
const totals = (input, output, cached = 0, thought = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  ...(cached ? { cachedReadTokens: cached } : {}),
  ...(thought ? { thoughtTokens: thought } : {}),
});

/** A session's observations as `[input, output, cacheRead]` rows. */
async function usageRows({ type, agent }, sessionId) {
  const read = () =>
    type.usage(agent, { since: 0, signal: new AbortController().signal });
  const session = (await read()).find((item) => item.id === sessionId);
  const again = (await read()).find((item) => item.id === sessionId);
  if (again?.revision !== session?.revision)
    throw new SmokeError("the usage revision changed with no new usage");
  for (const seen of session?.observations ?? [])
    if ("cost" in seen)
      throw new SmokeError(`a cost nobody reported: ${JSON.stringify(seen)}`);
  return session?.observations ?? [];
}

const rowsOf = (observations) =>
  JSON.stringify(
    observations.map(({ tokens }) => [
      tokens.input ?? 0,
      tokens.output ?? 0,
      tokens.cacheRead ?? 0,
    ]),
  );

/** Hermes' running totals, through every way they can move, as per-turn use: a
 * plain difference, reasoning not counted twice, a compress that kept the session
 * and one that restarted its counters, counters that fell with no notice, a steer
 * Hermes ran as a queued turn, and a new session after the process ended. */
async function checkStubUsage(stub, loaded) {
  const { type, agent, handle } = loaded;
  const channel = randomUUID();
  const place = { channelId: channel };
  const step = (running, model) =>
    plannedTurn(stub, loaded, channel, running, model);
  const compact = async (text) => {
    stub.compressText = text;
    await until(
      "the session to fall idle",
      () => type.sessionControls.state(agent, place) === "idle",
      STUB_TIMEOUT_MS,
    );
    await type.sessionControls.run(agent, place, "compact");
  };
  await step(totals(100, 10, 3, 4));
  await step(totals(250, 30, 8, 9));
  await compact(COMPRESS_NOOP);
  await step(totals(300, 35, 8, 9));
  await compact(COMPRESSED);
  // Higher than the last totals though the counters restarted.
  await step(totals(400, 40, 10));
  await step(totals(40, 4));
  const { plan, release } = heldPlan({ usage: totals(60, 6) });
  stub.plans.push(plan);
  stub.queuedSteerUsage = totals(90, 9);
  const held = mention(type, agent, handle, channel, "A long message.");
  await until("the held turn", () => stub.running === 1, STUB_TIMEOUT_MS);
  await new Promise((done) => setTimeout(done, DOM_POLL_MS));
  const steered = mention(type, agent, handle, channel, "A steer.");
  await until(
    "the queued steer",
    () => stub.queuedSteerUsage === undefined,
    STUB_TIMEOUT_MS,
  );
  release();
  await deadline(Promise.all([held, steered]), STUB_TIMEOUT_MS, "a held turn");
  await step(totals(120, 12));
  const { history } = type.tabs.find((tab) => tab.id === "activity").component;
  const first = history.find(agent.key, place).sessionId;
  const expected = JSON.stringify([
    [100, 10, 3],
    [150, 20, 5],
    // The compress turns report nothing: Hermes answers them without usage.
    [50, 5, 0],
    [400, 40, 10],
    [40, 4, 0],
    [20, 2, 0],
    [60, 6, 0],
  ]);
  const seen = rowsOf(await usageRows(loaded, first));
  if (seen !== expected)
    throw new SmokeError(`usage ${seen}, expected ${expected}`);
  // A recycle: the process ends, and the conversation opens a new session.
  stub.exitAll();
  await until(
    "the stopped process to be noticed",
    () => type.sessionControls.state(agent, place) !== "busy",
    STUB_TIMEOUT_MS,
  );
  await new Promise((done) => setTimeout(done, DOM_POLL_MS));
  await step(totals(30, 3), OTHER_MODEL);
  const second = history.find(agent.key, place).sessionId;
  if (second === first)
    throw new SmokeError("the new process did not open a new session");
  const after = await usageRows(loaded, second);
  if (rowsOf(after) !== "[[30,3,0]]" || after[0].model !== OTHER_MODEL)
    throw new SmokeError(`usage after a recycle: ${JSON.stringify(after)}`);
  if (rowsOf(await usageRows(loaded, first)) !== expected)
    throw new SmokeError("a recycle changed the old session's usage");
  log("stub-usage", `per-turn ${seen}; after a recycle ${rowsOf(after)}`);
}

/** The dialog's text, drawn by real React, with what its check found. */
async function providerDialog(app, provider) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = app.client.createRoot(container);
  root.render(
    app.react.createElement(provider.DialogBody, { onClose: () => {} }),
  );
  await new Promise((done) => setTimeout(done, DOM_POLL_MS));
  const again = [...container.querySelectorAll("button")].find((button) =>
    button.textContent.includes(CHECK_AGAIN),
  );
  return { text: container.textContent, again, close: () => root.unmount() };
}

/** The gateway's state file as Hermes writes it. */
const gatewayFile =
  (state, ageMs = 0) =>
  async (path) => {
    if (path !== GATEWAY_STATE_PATH)
      throw new SmokeError(`the plugin read another file: ${path}`);
    return new TextEncoder().encode(
      JSON.stringify({
        gateway_state: state,
        updated_at: new Date(Date.now() - ageMs).toISOString(),
      }),
    );
  };

/** One provider situation on a fresh load: the row's label and the dialog's words
 * for it, and that no session was opened where that could start a gateway. */
async function checkProviderCase(options, manifest, app, name, situation) {
  const { stub = new StubHermes(), readFile, label, says, session } = situation;
  const loaded = await loadPlugin(
    options,
    manifest,
    app,
    stub.spawn,
    `provider-${name}`,
    readFile,
  );
  try {
    const { provider } = loaded.type;
    await deadline(provider.check(), STUB_TIMEOUT_MS, `the ${name} check`);
    const { readiness, attentionLabel } = provider.snapshot();
    if (readiness !== "attention" || attentionLabel !== label)
      throw new SmokeError(`${name}: ${readiness}, label ${attentionLabel}`);
    const { text, close } = await providerDialog(app, provider);
    close();
    for (const words of says)
      if (!text.includes(words))
        throw new SmokeError(`${name}: the dialog lacks "${words}": ${text}`);
    if (stub.methods.includes("session/new") !== session)
      throw new SmokeError(`${name}: wrong session use: ${stub.methods}`);
    log("stub-provider", `${name}: "${attentionLabel}"`);
  } finally {
    await loaded.close();
    stub.exitAll();
  }
}

/** Every way the row can ask for attention, then the ready row: version, models
 * and gateway in the dialog, and a settled check that spawns nothing more until
 * "Check again" asks. */
async function checkStubProvider(options, manifest, app) {
  const check = (name, situation) =>
    checkProviderCase(options, manifest, app, name, situation);
  const gone = new StubHermes();
  gone.missing = true;
  await check("missing", {
    stub: gone,
    label: "Install Hermes",
    says: ["Installed: No"],
    session: false,
  });
  await check("gateway stopped", {
    readFile: gatewayFile("stopped"),
    label: "Start the Hermes gateway",
    says: ["No gateway answers", "hermes gateway start", "9.9.9+stub"],
    session: false,
  });
  await check("state file stale", {
    readFile: gatewayFile("running", STALE_STATE_MS),
    label: "Start the Hermes gateway",
    says: ["No gateway answers"],
    session: false,
  });
  await check("state file absent", {
    readFile: async () => {
      throw new Error("Could not find it");
    },
    label: "Check the Hermes gateway",
    says: ["Not known", "hermes gateway status"],
    session: false,
  });
  const refusing = new StubHermes();
  refusing.gatewayError = GATEWAY_REFUSAL;
  await check("gateway refuses", {
    stub: refusing,
    readFile: gatewayFile("running"),
    label: "Start the Hermes gateway",
    says: [GATEWAY_REFUSAL],
    session: true,
  });
  const stub = new StubHermes();
  const loaded = await loadPlugin(
    options,
    manifest,
    app,
    stub.spawn,
    "provider-ready",
    gatewayFile("running"),
  );
  try {
    const { provider } = loaded.type;
    const settled = provider.check();
    if (provider.snapshot().readiness !== "checking")
      throw new SmokeError("the check does not show that it runs");
    await settled;
    if (provider.snapshot().readiness !== "ready")
      throw new SmokeError(`not ready: ${provider.snapshot().readiness}`);
    const { text, again, close } = await providerDialog(app, provider);
    for (const words of [
      "version 9.9.9+stub",
      "Gateway: Running",
      `Default model: ${STUB_MODEL_NAME}`,
      "Models: 2",
    ])
      if (!text.includes(words))
        throw new SmokeError(`the dialog lacks "${words}": ${text}`);
    const spawned = stub.started;
    await provider.check();
    if (stub.started !== spawned)
      throw new SmokeError("a settled check started Hermes again");
    again.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await until("Check again", () => stub.started > spawned, STUB_TIMEOUT_MS);
    close();
    log("stub-provider", `ready; ${spawned} spawns, none for a settled check`);
  } finally {
    await loaded.close();
    stub.exitAll();
  }
}

/** The real Hermes and its gateway in the provider row and dialog: a look at them
 * that opens a session only because the gateway's state says that it runs. */
async function checkLiveProvider(app, type) {
  const { provider } = type;
  await deadline(provider.check(), TURN_TIMEOUT_MS, "the provider check");
  const { readiness, attentionLabel } = provider.snapshot();
  const { text, close } = await providerDialog(app, provider);
  close();
  if (readiness !== "ready")
    throw new SmokeError(`provider: ${attentionLabel}: ${text}`);
  // The dialog's rows run together in its text, so the state is named in full.
  const found =
    /version ([^\s]+?)Gateway: (Running|No gateway answers|Not known).*Models: (\d+)/.exec(
      text,
    );
  if (found?.[2] !== "Running" || !Number(found[3]))
    throw new SmokeError(`the dialog is incomplete: ${text}`);
  log(
    "provider",
    `version ${found[1]}, gateway ${found[2]}, ${found[3]} models`,
  );
}

/** A type that claims no boundary it cannot hold: Hermes' tools run in its
 * gateway, so a protected agent must stop, and say why. */
function checkStubProtection({ type }) {
  if (type.protection !== undefined || type.hooks !== undefined)
    throw new Error("The type claims protection or tool hooks");
  if (!/gateway/.test(type.protectionUnavailable ?? ""))
    throw new Error("A protected agent would stop with no Hermes reason");
  log("stub-protection", "none claimed; a protected agent stops with a reason");
}

/** The markup of the app's Settings row and details panel at the pinned
 * revision, which the build checks against the clone (ICON_SLOT_MARKS). */
function settingsSlot(id, attrs) {
  const element = document.createElement("div");
  element.setAttribute("id", id);
  for (const [name, value] of attrs) element.setAttribute(name, value);
  element.innerHTML =
    '<span aria-hidden="true" data-category="agents"><svg class="tabler-icon tabler-icon-layout-grid"></svg></span>';
  document.body.append(element);
  return element;
}

/** Passes when the plugin puts its artwork on its own Settings row and details
 * panel, on the app's tile, and leaves another plugin's row alone. */
async function checkSettingsIcon(pluginId) {
  const other = settingsSlot("plugin-description-other", [
    ["data-plugin-id", "other"],
  ]);
  const row = settingsSlot("row", [
    ["data-plugin-id", pluginId],
    ["aria-expanded", "true"],
  ]);
  const anchor = document.createElement("span");
  anchor.id = `plugin-description-${pluginId}`;
  row.append(anchor);
  const details = settingsSlot("plugin-details", []);
  const painted = (slot) => slot.querySelector("img")?.getAttribute("src");
  await until("the Settings icons", () => painted(row) && painted(details));
  for (const slot of [row, details]) {
    if (!painted(slot).startsWith(ICON_DATA_URL))
      throw new SmokeError(`not an inline icon: ${painted(slot).slice(0, 32)}`);
    if (!slot.querySelector("span").hasAttribute("data-branded"))
      throw new SmokeError("the icon is not on the app's tile");
    if (slot.querySelector("svg").style.display !== "none")
      throw new SmokeError("the generic icon still shows");
  }
  if (painted(other)) throw new SmokeError("painted another plugin's row");
  log("settings-icon", "on the row and the details panel, on the tile");
  return { row, details, other };
}

/** Passes when disabling the plugin puts the app's generic icon back. */
function checkSettingsIconRemoved({ row, details, other }) {
  for (const slot of [row, details]) {
    if (slot.querySelector("img"))
      throw new SmokeError("the icon stayed after the plugin stopped");
    if (slot.querySelector("span").hasAttribute("data-branded"))
      throw new SmokeError("the tile stayed after the plugin stopped");
    if (slot.querySelector("svg").style.display === "none")
      throw new SmokeError("the generic icon stayed hidden");
  }
  for (const slot of [row, details, other]) slot.remove();
  log("settings-icon-removed", "the generic icon is back");
}

/** The Settings icon on a plugin of its own, so its removal can be seen. */
async function stubIconChecks(options, manifest, app) {
  const stub = new StubHermes();
  const loaded = await loadPlugin(options, manifest, app, stub.spawn, "icon");
  let slots;
  try {
    slots = await checkSettingsIcon(manifest.id);
  } finally {
    await loaded.close();
    stub.exitAll();
  }
  checkSettingsIconRemoved(slots);
}

/** What only the stand-in can show. No Hermes, no model call. */
async function stubChecks(options, manifest, app) {
  await stubIconChecks(options, manifest, app);
  const stub = new StubHermes();
  const loaded = await loadPlugin(options, manifest, app, stub.spawn, "steer");
  try {
    checkStubProtection(loaded);
    await checkStubSteer(stub, loaded);
    await checkStubActivity(app, loaded);
    await checkStubHarnessRead(app, stub, loaded);
  } finally {
    await loaded.close();
    stub.exitAll();
  }
  const metered = new StubHermes();
  const usage = await loadPlugin(
    options,
    manifest,
    app,
    metered.spawn,
    "usage",
  );
  try {
    await checkStubUsage(metered, usage);
  } finally {
    await usage.close();
    metered.exitAll();
  }
  await checkStubProvider(options, manifest, app);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(
    readFileSync(join(options.plugin, "manifest.json"), "utf8"),
  );
  // Node's own localStorage needs a file flag and warns on each read; the
  // app's is per profile, so a fresh one in memory stands in for it.
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  checkLoadsWithoutDom(options);
  // Before the plugin loads: the stand-in checks draw its views in this window.
  const app = appRuntime();
  await stubChecks(options, manifest, app);
  if (options.stubOnly) return;
  const plugin = await import(
    pathToFileURL(join(options.plugin, "plugin.js")).href
  );
  const children = new Set();
  const methods = [];
  const prompts = [];
  const listeners = new Set();
  const servers = new Set();
  const cleanups = [];
  const workspace = mkdtempSync(join(tmpdir(), "hermes-smoke-"));
  const published = [];
  const types = [];
  const stdout = [];
  const agent = {
    key: undefined,
    type: `${manifest.id}/${plugin.TYPE_ID}`,
    name: AGENT_NAME,
    config: { workspace },
  };
  const handle = recordingHandle(published);
  agent.key = handle.key;
  const liveStorage = memoryStore();
  const ctx = {
    pluginOwner: { id: manifest.id },
    react: app.react,
    effect: (setup) => cleanups.push(setup()),
    host: {
      spawn: processHost(
        manifest,
        children,
        methods,
        stdout,
        prompts,
        options.route ? routeGuard(options.model) : undefined,
      ),
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
      storage: liveStorage,
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
    await checkNativeParity(type, agent, discovery);
    await checkLiveProvider(app, type);
    if (!options.turn) return;
    const listed = options.route ?? options.model;
    if (listed && !discovery.models.some((entry) => entry.id === listed))
      throw new SmokeError(`Hermes does not list the model ${listed}`);
    if (options.effort) checkEffort(options.model, options.effort);
    if (options.route)
      await checkRoute(
        manifest.host.processes.find((entry) => entry.id === HERMES_PROCESS),
        options.model,
        options.route,
      );
    const model = options.model ?? discovery.current ?? discovery.models[0].id;
    // A model is an agent setting, which the app hands the runtime as a
    // changed agent, as when the owner saves it.
    // One session per channel: this run's messages name no thread.
    agent.config = { ...agent.config, model, scope: "channel" };
    for (const listener of listeners) listener();
    const sent = await turn(type, agent, handle, published);
    log(
      "turn",
      `model ${model}: Hermes sent kind ${sent.kind}: ${JSON.stringify(sent.content)}`,
    );
    // A message's work ends once the agent has answered it in Buzz, which comes
    // before Hermes ends the turn and gives its counters.
    await until(
      "the turn to end",
      () =>
        type.sessionControls.state(agent, { channelId: sent.channel }) ===
        "idle",
    );
    const sessionId = checkLiveActivity(type, agent, liveStorage, sent);
    await checkLiveRead({ type, agent }, sent.channel, sent.nonce);
    await checkLiveUsage(
      type,
      agent,
      sessionId,
      model,
      stdout,
      Boolean(options.route),
    );
    if (options.controls)
      await controls(type, agent, handle, {
        published,
        prompts,
        stdout,
      });
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
