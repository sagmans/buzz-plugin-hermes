// A stand-in for `hermes acp` that answers ACP in this process, for what the real
// one cannot show on demand or free of charge: chosen token counters, a steer
// Hermes runs as a queued turn, a gateway that does not answer, a missing
// program. It speaks only what the plugin's wire reads, in Hermes' shapes
// (acp_adapter/gateway_server.py, gateway_commands.py). No model runs.

export const STUB_MODEL = "stub:model";
export const STUB_MODEL_NAME = "Stub Model";
export const OTHER_MODEL = "stub:other";
/** What the host's spawn says for a program it cannot find (host_process.rs). */
const NOT_FOUND = "No such file or directory (os error 2)";
const STEER_COMMAND = "/steer ";
/** The manifest's id of `hermes sessions export`. */
const USAGE_PROCESS = "hermes-usage";
/** What Hermes writes when it has no session to export (sessions_cmd.py). */
const NO_SESSIONS = "No sessions found.\n";
/** Cuts an export's output here, so a line reaches the plugin in two pieces, as
 * a pipe gives a long line. */
const EXPORT_PIECE_CHARS = 64;
const COMPRESS_COMMAND = "/compress";
/** Hermes' first line for a compress that made the session smaller. */
export const COMPRESSED = "Compressed: 20 → 10 messages";
/** Hermes' first line for one that had nothing to remove. */
export const COMPRESS_NOOP = "No changes from compression: 20 messages";
export const STEER_ECHO =
  "⏩ Steer queued - arriving after the next tool call.";
const INTERNAL_ERROR = -32603;
const NO_METHOD = -32601;

const chunk = (sessionId, text) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  },
});

export class StubHermes {
  /** How many processes were started. */
  started = 0;
  /** How many sessions were opened, over all processes. */
  opened = 0;
  /** Every prompt's text Hermes got. */
  prompts = [];
  /** Every request method Hermes got. */
  methods = [];
  /** What each coming turn does: `{usage, text, hold}`. `hold` is a promise the
   * turn waits for, so a test can steer it. */
  plans = [];
  /** Turns running now. */
  running = 0;
  /** Set: the program is not there. */
  missing = false;
  /** Set: every `session/new` fails as Hermes fails without a gateway. */
  gatewayError = undefined;
  /** What Hermes writes for a compress. */
  compressText = COMPRESSED;
  /** Set: the next steer finds the turn over, so Hermes runs it as a queued turn
   * and answers with these counters when it ends. */
  queuedSteerUsage = undefined;
  /** Each running process's way to end, as a process that dies. */
  processes = new Set();
  /** What `session/load` replays, per session: ACP updates, or `{ error }` for a
   * read that fails. A session not here is one Hermes no longer has. */
  replays = new Map();
  /** Every session a `session/load` asked for. */
  loads = [];

  /** The rows `hermes sessions export` gives. */
  store = [];
  /** Set: what it writes in place of rows, with exit code 0, as Hermes does for
   * "Error: …". */
  storeAnswer = undefined;
  /** How many exports ran. */
  exports = 0;

  /** One `hermes sessions export`: its output in pieces, then its exit. */
  export(options) {
    if (options.args)
      throw new Error(`arguments beyond the grant: ${options.args}`);
    this.exports += 1;
    const answer =
      this.storeAnswer ??
      (this.store.length
        ? this.store.map((row) => `${JSON.stringify(row)}\n`).join("")
        : NO_SESSIONS);
    const pieces = [];
    for (let at = 0; at < answer.length; at += EXPORT_PIECE_CHARS)
      pieces.push(answer.slice(at, at + EXPORT_PIECE_CHARS));
    const exited = (async () => {
      for (const piece of pieces) {
        await new Promise((done) => setImmediate(done));
        options.onStdout?.(piece);
      }
      return 0;
    })();
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited,
    };
  }

  spawn = async (id, options = {}) => {
    if (this.missing) throw new Error(NOT_FOUND);
    if (id === USAGE_PROCESS) return this.export(options);
    this.started += 1;
    let finish;
    const exited = new Promise((done) => {
      finish = done;
    });
    const end = () => {
      this.processes.delete(end);
      finish(0);
    };
    this.processes.add(end);
    const out = (message) =>
      setImmediate(() => options.onStdout?.(`${JSON.stringify(message)}\n`));
    return {
      write: async (data) => {
        for (const line of String(data).split("\n"))
          if (line.trim()) this.handle(JSON.parse(line), out);
      },
      end: async () => end(),
      kill: async () => end(),
      exited,
    };
  };

  /** Ends every process, as when Hermes dies or the plugin recycles it. */
  exitAll() {
    for (const end of [...this.processes]) end();
  }

  handle(message, out) {
    const { id, method, params } = message;
    if (!method) return;
    this.methods.push(method);
    const answer = (result) => out({ jsonrpc: "2.0", id, result });
    if (method === "initialize")
      answer({
        protocolVersion: 1,
        agentInfo: { name: "hermes-agent", version: "9.9.9+stub" },
        agentCapabilities: {},
      });
    else if (method === "session/new") this.open(id, out);
    else if (method === "session/prompt") void this.prompt(id, params, out);
    else if (method === "session/set_model") answer({});
    else if (method === "session/load") this.load(id, params, out);
    else if (id !== undefined)
      out({
        jsonrpc: "2.0",
        id,
        error: { code: NO_METHOD, message: `No ${method}` },
      });
  }

  open(id, out) {
    if (this.gatewayError) {
      out({
        jsonrpc: "2.0",
        id,
        error: {
          code: INTERNAL_ERROR,
          message: "Internal error",
          data: { details: this.gatewayError },
        },
      });
      return;
    }
    this.opened += 1;
    out({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: `stub-session-${this.opened}`,
        models: {
          currentModelId: STUB_MODEL,
          availableModels: [
            { modelId: STUB_MODEL, name: STUB_MODEL_NAME },
            { modelId: OTHER_MODEL, name: "Other Model" },
          ],
        },
      },
    });
  }

  /** Replays a session before it answers, as ACP does. */
  load(id, { sessionId }, out) {
    this.loads.push(sessionId);
    const replay = this.replays.get(sessionId);
    if (!replay || replay.error) {
      const message = replay?.error ?? `Session ${sessionId} not found`;
      out({ jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message } });
      return;
    }
    for (const update of replay)
      out({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update },
      });
    out({ jsonrpc: "2.0", id, result: {} });
  }

  async prompt(id, params, out) {
    const { sessionId } = params;
    const text = params.prompt?.[0]?.text ?? "";
    this.prompts.push(text);
    const answer = (usage) =>
      out({
        jsonrpc: "2.0",
        id,
        result: { stopReason: "end_turn", ...(usage ? { usage } : {}) },
      });
    if (text.startsWith(STEER_COMMAND)) {
      if (this.queuedSteerUsage) {
        const usage = this.queuedSteerUsage;
        this.queuedSteerUsage = undefined;
        answer(usage);
        return;
      }
      out(chunk(sessionId, STEER_ECHO));
      answer();
      return;
    }
    if (text === COMPRESS_COMMAND) {
      out(chunk(sessionId, this.compressText));
      answer();
      return;
    }
    const plan = this.plans.shift() ?? {};
    this.running += 1;
    // The turn shows that it runs, which is when the wire gives it a run id.
    out(chunk(sessionId, "Working. "));
    await plan.hold;
    out(chunk(sessionId, plan.text ?? "Done."));
    this.running -= 1;
    answer(plan.usage);
  }
}
