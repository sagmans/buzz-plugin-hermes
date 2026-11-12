// Hermes on buzz-app's shared ACP client. The build puts this module in place
// of buzz-app's `bundled/goose/goose.ts`, so the Goose runtime and sessions
// code run unchanged against one `hermes acp` process instead of `goose-acp`.
// It exports the same names that code imports. Only what Hermes does
// differently from plain ACP is here: the program, its environment and the
// model switch, the HTTP MCP capability Hermes leaves out (`advertised`),
// steering through Hermes' `/steer` command and compaction through its
// `/compress` command (`HermesWire`). Hermes has no system-prompt extension,
// so the shared client puts the Buzz prompt at the head of a session's first
// prompt.
import {
  AcpProcess,
  REQUEST_TIMEOUT_MS,
} from "@app/features/agent-harness/acp/process";
import type { AcpSession } from "@app/features/agent-harness/acp/session";
import { errorMessage } from "@app/features/agent-harness/acp/steps";
import type {
  AcpHooks,
  ServeMcp,
  Spawn,
} from "@app/features/agent-harness/acp/types";

export {
  REQUEST_TIMEOUT_MS,
  TOOL_SERVER,
} from "@app/features/agent-harness/acp/process";
export { stepLabel } from "@app/features/agent-harness/acp/steps";
export type {
  ActivityReceipt,
  Choice,
  ServeMcp,
  Settled,
  Spawn,
  ToolServer,
} from "@app/features/agent-harness/acp/types";

export type GooseProcess = AcpProcess;
export type GooseSession = AcpSession;
/** The desktop host's `spawn` and `resolveDirectory`, which Hermes starts with. */
export type GooseHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;

/** The manifest process id (plugin/manifest.json): `hermes acp`. */
export const PROCESS_ID = "hermes";
export const LABEL = "Hermes";

/** What every `hermes acp` runs with. Buzz gives each session its own tools
 * over MCP; buzz-acp sets the same variable for Hermes. Since Hermes 0.22.1
 * the gateway owns MCP and ignores it, so it only matters to an older
 * Hermes. The shared client always removes the Buzz identity from the
 * environment. */
export const ENV: Readonly<Record<string, string | null>> = {
  HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
};

/** The `agentInfo.name` of Hermes' ACP adapter. */
const AGENT_NAME = "hermes-agent";
/** This plugin's `_meta` key. Only the adapter writes it, on the run ids it
 * gives the client. */
export const META_KEY = "sagmans.hermes";
/** Prefix of the run ids the adapter makes up: Hermes sends none. */
const RUN_PREFIX = "hermes-prompt-";
/** What the steer hook writes, which `HermesWire` always turns into Hermes'
 * command. A method of its own, not `session/prompt`, so the Activity record
 * above the wire takes no new turn from it (recorder.ts), and the one the app's
 * transcript shows as a steer (activity-transcript.ts, `PROMPT_METHODS`). */
export const STEER_METHOD = "_session/steering";
/** Hermes' prompt command that adds guidance to the running turn
 * (acp_adapter/gateway_commands.py, `_steer`). */
const STEER_COMMAND = "/steer";
/** How Hermes' reply to a taken steer starts. It is the adapter's business,
 * not the agent's answer, so the client never sees it. */
export const STEER_ECHO = "⏩ Steer queued";
/** Updates that show Hermes runs a prompt's turn, not only holds it in its
 * queue: a steer must only name a turn that runs. */
const TURN_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);
/** The prompt the shared client compacts a session with
 * (acp/agent-sessions.ts, `reset`). Hermes would pass it to the model as text. */
const COMPACT_COMMAND = "/compact";
/** Hermes' prompt command for the same work. */
const COMPRESS_COMMAND = "/compress";
/** The only text the shared client takes as a compaction that worked. */
const COMPACT_DONE = "Compaction complete";
/** Hermes' first line when the session is compact afterwards
 * (agent/manual_compression_feedback.py, acp_adapter/gateway_commands.py).
 * "No changes" means that it had nothing to remove, which is no failure. The
 * other lines ("Compression aborted", "refused", "Compressed with fallback")
 * say that the summary failed: the owner must read them. */
const COMPRESSED_RE =
  /^(?:Compressed: |No changes from compression|Context compressed\.)/;
/** That first line when the session stayed as it was. Hermes evicts its agent,
 * and so zeroes the session's counters, only for a compress that changed it
 * (gateway/session_mutations.py). */
const COMPRESS_KEPT_RE = /^No changes from compression/;
/** The counters of Hermes' `PromptResponse.usage`, which hold the session's
 * running totals and not one turn's (acp_adapter/gateway_session_meta.py,
 * `turn_usage`; agent/turn_usage.py). `thoughtTokens` is left out: Hermes
 * counts reasoning inside its output (agent/usage_pricing.py), while ACP and the
 * Activity record count it apart, so it would count twice. */
const USAGE_COUNTERS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedReadTokens",
] as const;
type Totals = Readonly<Record<(typeof USAGE_COUNTERS)[number], number>>;
/** A new session's counters, and those of a session whose agent was evicted. */
const NOTHING_USED: Totals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedReadTokens: 0,
};
/** The ACP call that moves a session to another model. */
const SET_MODEL_METHOD = "session/set_model";
/** The config option `HermesWire` names a session's model with. */
const MODEL_OPTION = "model";
const MODEL_OPTION_NAME = "Model";
/** JSON-RPC "server error" code of the adapter's own refusal. */
const ADAPTER_ERROR = -32000;
const NO_RUN = "Hermes runs no turn of that id to steer";
/** A version the provider dialog shows. The answer is process output, so anything
 * else in that field is not shown. */
const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** The model each open session started on, by session id: what its
 * `session/new` answer named, which is Hermes' config's pick. ACP has no value
 * for "the default", so a session that a per-message pick moved goes back to
 * this id. `HermesWire` fills it and removes its entries when its process ends. */
const startModels = new Map<string, string>();

/** A Hermes call that failed, with the operation and session it was for. */
export class HermesError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly sessionId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HermesError";
  }
}

/** One `initialize` answer with HTTP MCP added, when it is Hermes' and says
 * nothing about it; any other line is returned as it came. */
export function advertised(line: string): string {
  let message: {
    result?: {
      agentInfo?: { name?: unknown };
      agentCapabilities?: { mcpCapabilities?: unknown };
    };
  };
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  const result = message?.result;
  if (
    result?.agentInfo?.name !== AGENT_NAME ||
    !result.agentCapabilities ||
    result.agentCapabilities.mcpCapabilities !== undefined
  )
    return line;
  result.agentCapabilities.mcpCapabilities = { http: true };
  return JSON.stringify(message);
}

type Message = {
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
type Prompt = Readonly<{
  sessionId: string;
  kind: "turn" | "steer" | "compress";
}>;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const parse = (line: string): Message | undefined => {
  try {
    return record(JSON.parse(line)) as Message | undefined;
  } catch {
    return undefined;
  }
};
const chunkText = (update: Record<string, unknown>) => {
  const text = record(update.content)?.text;
  return typeof text === "string" ? text : "";
};
/** The adapter's `session_info_update` that tells the client which run is
 * active in a session; `null` says none is. */
const runLine = (sessionId: string, runId: string | null) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { [META_KEY]: { activeRunId: runId } },
      },
    },
  });

/** The text the shared client gets for what Hermes wrote about a compress. */
const compactResult = (written: string) => {
  const text = written.trim();
  return COMPRESSED_RE.test(text)
    ? COMPACT_DONE
    : `Hermes could not compress the session: ${text || "it gave no answer"}`;
};
/** Whether a compress changed the session, by what Hermes wrote about it. */
const compressedAnew = (written: string) => {
  const text = written.trim();
  return COMPRESSED_RE.test(text) && !COMPRESS_KEPT_RE.test(text);
};
/** One `agent_message_chunk` of the adapter's own text. */
const textLine = (sessionId: string, text: string) =>
  JSON.stringify({
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
/** The text of a prompt that is one text block and nothing else. */
const onlyText = (params: Record<string, unknown>) => {
  const blocks = params.prompt;
  if (!Array.isArray(blocks) || blocks.length !== 1) return undefined;
  const block = record(blocks[0]);
  return block?.type === "text" ? block : undefined;
};

/** Hermes' counters from its usage object; one it leaves out is zero, as it
 * leaves out zero counts. */
const totalsOf = (usage: Record<string, unknown>) =>
  Object.fromEntries(
    USAGE_COUNTERS.map((name) => {
      const value = usage[name];
      return [
        name,
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : 0,
      ];
    }),
  ) as Totals;

/** What was used between two reads of the counters, or undefined for nothing.
 * A counter that went down means Hermes started counting again, as after it
 * evicts an idle agent, so all that it holds now came since. */
function usedSince(now: Totals, before: Totals) {
  const from = USAGE_COUNTERS.some((name) => now[name] < before[name])
    ? NOTHING_USED
    : before;
  const used = USAGE_COUNTERS.flatMap((name) =>
    now[name] > from[name] ? [[name, now[name] - from[name]] as const] : [],
  );
  return used.length ? Object.fromEntries(used) : undefined;
}

/** The adapter between the shared client and `hermes acp`: it reads both
 * directions of one process's JSON-RPC lines.
 *
 * Why: the shared client steers only with a run id from `session/update`,
 * and Hermes sends none (gateway_server.py). Hermes steers when a second
 * `session/prompt` of the same session carries `/steer <guidance>` while
 * the first one's turn runs. So the adapter tracks the client's own turn
 * prompts and gives each one a run id once Hermes shows that its turn runs,
 * and clears it when the prompt is answered. It checks the run id of a
 * steer before Hermes sees it, and it drops Hermes' "Steer queued" echo,
 * which would otherwise reach Buzz as text that no one answered.
 *
 * The client also compacts with a command that only Goose knows, and it
 * judges the result by Goose's text. So the adapter sends that one prompt as
 * Hermes' command, holds what Hermes writes about it, and gives the client
 * the text it reads as success, or Hermes' own words as the error.
 *
 * Hermes answers each turn with the session's running totals, and ACP and the
 * Activity record read that field as the turn's own use. So the adapter gives
 * the client what each turn added. A steer that Hermes runs as a queued turn
 * also answers with totals; those stay uncounted until the next turn's answer,
 * whose difference holds them, so they are neither lost nor doubled.
 *
 * It forwards only whole lines to the client, so each line it adds starts
 * on a line of its own. */
export class HermesWire {
  private pending = "";
  private initialized = false;
  /** The client's prompts that Hermes has not answered, by request id. */
  private readonly prompts = new Map<number, Prompt>();
  /** Each session's running turn prompt, and its run id once it runs. */
  private readonly turns = new Map<string, { id: number; runId?: string }>();
  /** Sessions with a steer prompt in flight. The client sends one at a time. */
  private readonly steering = new Set<string>();
  /** What Hermes has written about each session's compress in flight. */
  private readonly compressing = new Map<string, string>();
  /** The client's `session/new` requests that Hermes has not answered. */
  private readonly opening = new Set<number>();
  /** Sessions this process opened, whose `startModels` entries it owns. */
  private readonly opened = new Set<string>();
  /** Each open session's counters at its latest answered turn. */
  private readonly totals = new Map<string, Totals>();
  /** The client's model switches that Hermes has not answered, by request id. */
  private readonly switching = new Map<
    number,
    Readonly<{ sessionId: string; model: string }>
  >();
  /** The names of the models Hermes listed, for the model it reports as a
   * config option. */
  private readonly modelNames = new Map<string, string>();
  /** The client's requests that Hermes has not answered. A turn may still
   * run with none of its messages pending: after a final Buzz `send` the
   * client counts it as done, and Hermes ends it with one more model call. */
  private readonly inFlight = new Set<number>();
  private active = Date.now();
  /** The version `initialize` reported, "" when it named none to show. */
  version = "";
  /** Hermes' words for the latest `session/new` it refused, for the setup check.
   * Its error's message says only "Internal error", with what went wrong in
   * `error.data.details` (the Python ACP library, connection.py), which the
   * shared client drops. Kept here and not passed on: that text can hold a
   * startup report, and a turn's error may travel further than the owner. */
  openError = "";

  constructor(private readonly deliver: (data: string) => void) {}

  /** What the client writes, as Hermes must get it. */
  outgoing(data: string): string {
    return data
      .split("\n")
      .map((line) => this.write(line))
      .filter((line) => line !== undefined)
      .join("\n");
  }

  /** What Hermes writes, handed to the client in whole lines. */
  incoming(data: string) {
    this.touch();
    this.pending += data;
    const end = this.pending.lastIndexOf("\n");
    if (end < 0) return;
    const lines = this.pending.slice(0, end).split("\n");
    this.pending = this.pending.slice(end + 1);
    const out = lines.flatMap((line) => (line.trim() ? this.read(line) : []));
    if (out.length) this.deliver(`${out.join("\n")}\n`);
  }

  /** Sessions Hermes holds for this process. It frees them only when the
   * process ends, whatever the client has closed. */
  get sessions() {
    return this.opened.size;
  }
  /** Whether the client waits for an answer from Hermes. */
  get waiting() {
    return this.inFlight.size > 0;
  }
  /** When a request or any output last passed. */
  get lastActive() {
    return this.active;
  }
  /** Counts as use: the process is about to get work. */
  touch() {
    this.active = Date.now();
  }

  /** The process ended: its sessions are gone, with what is kept for them. */
  dispose() {
    for (const sessionId of this.opened) startModels.delete(sessionId);
    this.opened.clear();
    this.totals.clear();
  }

  private write(line: string): string | undefined {
    const message = line.trim() ? parse(line) : undefined;
    const { id, params } = message ?? {};
    // A notification (`session/cancel`) or an answer is no new work.
    if (typeof message?.method === "string" && typeof id === "number") {
      this.inFlight.add(id);
      this.touch();
    }
    if (message?.method === "session/new" && typeof id === "number")
      this.opening.add(id);
    const sessionId = params?.sessionId;
    if (typeof id !== "number" || typeof sessionId !== "string" || !params)
      return line;
    if (message?.method === STEER_METHOD)
      return this.steer(id, sessionId, params);
    if (message?.method === SET_MODEL_METHOD) {
      if (typeof params.modelId === "string")
        this.switching.set(id, { sessionId, model: params.modelId });
      return line;
    }
    if (message?.method !== "session/prompt") return line;
    const block = onlyText(params);
    if (block?.text === COMPACT_COMMAND) {
      block.text = COMPRESS_COMMAND;
      this.prompts.set(id, { sessionId, kind: "compress" });
      this.compressing.set(sessionId, "");
      return JSON.stringify(message);
    }
    this.prompts.set(id, { sessionId, kind: "turn" });
    this.turns.set(sessionId, { id });
    return line;
  }

  /** The prompt Hermes steers with, for the steer the hook wrote, when it names
   * the turn that runs and is one text block. Hermes must never get the hook's
   * method itself: it takes an unknown `_` method without doing anything. */
  private steer(
    id: number,
    sessionId: string,
    params: Record<string, unknown>,
  ): string | undefined {
    const block = onlyText(params);
    const runId = this.turns.get(sessionId)?.runId;
    if (!block || typeof params.runId !== "string" || params.runId !== runId) {
      this.refuse(id, NO_RUN);
      return undefined;
    }
    this.prompts.set(id, { sessionId, kind: "steer" });
    this.steering.add(sessionId);
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: `${STEER_COMMAND} ${block.text}` }],
      },
    });
  }

  /** Answers request `id` with an error, without Hermes; after the write
   * that sent it returns, as an answer read from Hermes would come. */
  private refuse(id: number, error: string) {
    this.inFlight.delete(id);
    queueMicrotask(() =>
      this.deliver(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: ADAPTER_ERROR, message: error },
        })}\n`,
      ),
    );
  }

  private read(line: string): string[] {
    if (!this.initialized) {
      const next = advertised(line);
      if (next !== line || /"agentCapabilities"/.test(line))
        this.initialized = true;
      line = next;
    }
    const message = parse(line);
    if (!message) return [line];
    if (message.method === undefined) return this.answered(message, line);
    if (message.method === "session/update") return this.updated(message, line);
    return [line];
  }

  /** Keeps the model a new session starts on (`startModels`), and returns the
   * answer naming that model as a config option, when Hermes named none. Hermes
   * reports its model only in ACP's `models`; the Activity record and transcript
   * read a turn's model from config options, and the shared client reads no
   * option of this category. */
  private openedSession(message: Message, line: string): string {
    const result = record(message.result);
    const { sessionId, models, configOptions } = result ?? {};
    if (typeof sessionId !== "string" || !result) return line;
    this.opened.add(sessionId);
    this.totals.set(sessionId, NOTHING_USED);
    const state = record(models);
    for (const entry of Array.isArray(state?.availableModels)
      ? state.availableModels
      : []) {
      const { modelId, name } = record(entry) ?? {};
      if (typeof modelId === "string" && typeof name === "string")
        this.modelNames.set(modelId, name);
    }
    const model = state?.currentModelId;
    if (typeof model !== "string" || !model) return line;
    startModels.set(sessionId, model);
    if (configOptions !== undefined) return line;
    result.configOptions = this.modelOptions(model);
    return JSON.stringify(message);
  }

  /** The current model as ACP's config options. Only its own row: the record
   * keeps this for every turn, and Hermes lists hundreds of models. */
  private modelOptions(model: string) {
    return [
      {
        id: MODEL_OPTION,
        name: MODEL_OPTION_NAME,
        category: MODEL_OPTION,
        type: "select",
        currentValue: model,
        options: [{ value: model, name: this.modelNames.get(model) ?? model }],
      },
    ];
  }

  /** Tells the record of a session's model switch, which Hermes reports nowhere
   * else, ahead of its answer and so ahead of the turn it is for. */
  private switched(id: number, failed: boolean): string[] {
    const switching = this.switching.get(id);
    this.switching.delete(id);
    if (!switching || failed) return [];
    const { sessionId, model } = switching;
    return [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: this.modelOptions(model),
          },
        },
      }),
    ];
  }

  private answered(message: Message, line: string): string[] {
    const { id, error } = message;
    if (typeof id !== "number") return [line];
    this.noteVersion(message);
    this.inFlight.delete(id);
    if (this.opening.delete(id)) line = this.openAnswered(message, line);
    if (this.switching.has(id)) return [...this.switched(id, !!error), line];
    const prompt = this.prompts.get(id);
    if (!prompt) return [line];
    this.prompts.delete(id);
    const { sessionId } = prompt;
    if (prompt.kind === "steer") {
      this.steering.delete(sessionId);
      return [line];
    }
    if (prompt.kind === "compress")
      return this.compressAnswered(sessionId, !!error, line);
    return this.turnAnswered(message, line, sessionId, id);
  }

  /** Remembers the agent version an initialize answer reports, but only a
   * well-formed one: it later reaches the app's UI. */
  private noteVersion(message: Message) {
    const version = record(record(message.result)?.agentInfo)?.version;
    if (typeof version === "string" && VERSION_SHAPE.test(version))
      this.version = version;
  }

  /** Keeps the reason a session open failed, so the app can show it, and
   * rewrites the answer as the open's own. */
  private openAnswered(message: Message, line: string): string {
    const details = record(record(message.error)?.data)?.details;
    if (typeof details === "string") this.openError = details;
    return this.openedSession(message, line);
  }

  /**
   * A compress answer carries no usage of its own, so the client would keep a
   * stale total and never see what was compacted without this step.
   */
  private compressAnswered(
    sessionId: string,
    failed: boolean,
    line: string,
  ): string[] {
    const written = this.compressing.get(sessionId) ?? "";
    this.compressing.delete(sessionId);
    // The next turn counts from zero, and could still end above the old total.
    if (!failed && compressedAnew(written))
      this.totals.set(sessionId, NOTHING_USED);
    // An error answer reaches the client as an error by itself.
    return failed
      ? [line]
      : [textLine(sessionId, compactResult(written)), line];
  }

  /**
   * The client shows usage and a steerable run from these lines, so a finished
   * turn must report its usage and close its run before anything else reads it.
   */
  private turnAnswered(
    message: Message,
    line: string,
    sessionId: string,
    id: number,
  ): string[] {
    line = this.turnUsage(message, line, sessionId);
    const turn = this.turns.get(sessionId);
    if (!turn || turn.id !== id) return [line];
    this.turns.delete(sessionId);
    // Cleared before the answer, so the client never steers a turn that ended.
    return turn.runId ? [runLine(sessionId, null), line] : [line];
  }

  /** A turn's answer, with what that turn used in place of Hermes' totals. A
   * session this process did not open gives no way to tell, so it reports none
   * rather than all it ever used. */
  private turnUsage(message: Message, line: string, sessionId: string): string {
    const result = record(message.result);
    const usage = record(result?.usage);
    if (!result || !usage) return line;
    const now = totalsOf(usage);
    const before = this.totals.get(sessionId);
    this.totals.set(sessionId, now);
    const used = before && usedSince(now, before);
    if (used) result.usage = used;
    else delete result.usage;
    return JSON.stringify(message);
  }

  private updated(message: Message, line: string): string[] {
    const sessionId = message.params?.sessionId;
    const update = record(message.params?.update);
    if (typeof sessionId !== "string" || !update) return [line];
    const kind = update.sessionUpdate;
    const meta = record(update._meta);
    if (meta && META_KEY in meta) {
      // Only the adapter may name a run: Hermes' own key would be a spoof.
      delete meta[META_KEY];
      line = JSON.stringify(message);
    }
    const written = this.compressing.get(sessionId);
    if (kind === "agent_message_chunk" && written !== undefined) {
      this.compressing.set(sessionId, written + chunkText(update));
      return [];
    }
    if (
      kind === "agent_message_chunk" &&
      this.steering.has(sessionId) &&
      chunkText(update).startsWith(STEER_ECHO)
    )
      return [];
    const turn = this.turns.get(sessionId);
    if (!turn || turn.runId || !TURN_UPDATES.has(String(kind))) return [line];
    turn.runId = `${RUN_PREFIX}${turn.id}`;
    return [runLine(sessionId, turn.runId), line];
  }
}

/** `spawn`, with `hermes acp`'s JSON-RPC lines going through a `HermesWire`.
 *
 * Why: Hermes' ACP adapter takes HTTP MCP servers in `session/new` and
 * connects to them, but its `initialize` answer has no `mcpCapabilities`
 * (checked against Hermes 0.22.1). The shared client refuses a harness that
 * does not advertise HTTP MCP, because Buzz tools reach it only that way.
 * The smoke run (README, "Checks") proves that Hermes calls the Buzz tools.
 * The same wire gives the client the run ids Hermes does not send, for
 * steering (`HermesWire`). `watch` gets the wire of each process started. */
export function hermesSpawn(
  spawn: Spawn,
  watch?: (wire: HermesWire) => void,
): Spawn {
  return async (id, options) => {
    const onStdout = options?.onStdout;
    if (!onStdout) return spawn(id, options);
    const wire = new HermesWire(onStdout);
    watch?.(wire);
    const child = await spawn(id, {
      ...options,
      onStdout: (data) => wire.incoming(data),
    });
    void child.exited.then(
      () => wire.dispose(),
      () => wire.dispose(),
    );
    return {
      ...child,
      // A refused steer leaves nothing to write.
      write: (data) => {
        const out = wire.outgoing(data);
        return out.trim() ? child.write(out) : Promise.resolve();
      },
      end: (data) =>
        child.end(data === undefined ? undefined : wire.outgoing(data)),
    };
  };
}

export const HERMES: AcpHooks = {
  label: LABEL,
  program: PROCESS_ID,
  missing:
    "Hermes is not installed or cannot start. Install Hermes Agent with its ACP extra, then run `hermes acp --check`.",
  // `hermes` is found on PATH; exit 126 or 127 means it is missing.
  diagnoseStartup: true,
  env: ENV,
  // Hermes model ids are whole strings such as `provider:model`; the
  // provider field of the shared choice stays empty. An empty model is the
  // one Hermes' own config picks: a new session is on it already, and a
  // session that a per-message pick moved goes back to it, so the pick holds
  // for its own turn only, as on the app's own agents.
  select: async (hermes, session, want) => {
    if (want.model === session.chosen.model) return;
    const start = startModels.get(session.id);
    const model = want.model || start;
    // A session still on its start model must not switch to that same model:
    // Hermes rebuilds the agent on a switch, and the rebuilt agent gives its
    // summary call a provider-prefixed model id that a plugin provider can
    // refuse, which breaks Compact on a model the user never changed.
    if (
      model === start &&
      (!session.chosen.model || session.chosen.model === start)
    ) {
      session.chosen = { ...session.chosen, model: want.model };
      return;
    }
    if (!model)
      throw new HermesError(
        "session/set_model",
        "Hermes could not go back to its default model: its new session named none",
        session.id,
      );
    try {
      await hermes.request(
        "session/set_model",
        { sessionId: session.id, modelId: model },
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      throw new HermesError(
        "session/set_model",
        `Hermes could not switch to the model ${model}: ${errorMessage(error)}`,
        session.id,
        { cause: error },
      );
    }
    session.chosen = { ...session.chosen, model: want.model };
  },
  // The same shape as Goose's hook (buzz-app bundled/goose/goose.ts), with the
  // run ids and their `_meta` key from `HermesWire` instead of Goose's.
  steering: {
    runId: (update) => {
      if (update.sessionUpdate !== "session_info_update") return null;
      const mine = record(record(update._meta)?.[META_KEY]);
      if (!mine || !("activeRunId" in mine)) return null;
      return typeof mine.activeRunId === "string"
        ? mine.activeRunId
        : undefined;
    },
    // A throw makes the client run the text as the next turn. Hermes answers
    // a taken steer at once. One it cannot take (the turn just ended) it runs
    // as its own queued turn and answers when that turn ends, so this request
    // has no timeout, as no turn prompt of the client has: a timeout would
    // stop the whole process. The text stays plain: `HermesWire` adds Hermes'
    // command, and the Activity record shows the guidance without it.
    steer: async (hermes, sessionId, runId, text) => {
      if (!text.trim())
        throw new HermesError("steer", "Nothing to steer", sessionId);
      try {
        await hermes.request(STEER_METHOD, {
          sessionId,
          runId,
          prompt: [{ type: "text", text }],
        });
      } catch (error) {
        throw new HermesError(
          "steer",
          `Hermes did not take the steer for run ${runId}: ${errorMessage(error)}`,
          sessionId,
          { cause: error },
        );
      }
    },
  },
};

/** What wraps each shared process's `spawn` for the Activity record, or nothing
 * when no agent type is loaded. Module state, as the Goose runtime builds its
 * process host inline and passes on nothing but `spawn`; `apply` sets it. */
let recording: ((spawn: Spawn) => Spawn) | undefined;
/** Sets `recording`; `undefined` ends it when the plugin unloads. */
export const recordWith = (record: ((spawn: Spawn) => Spawn) | undefined) => {
  recording = record;
};

/** Starts `hermes acp`. The name is the one the Goose sessions code imports.
 * The record sits above the wire, so it holds what the client saw: without the
 * steer echo, with `/compact` and its result rather than Hermes' words. */
export const GooseProcess = {
  start: (
    spawn: Spawn,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
    }>,
    watch?: (wire: HermesWire) => void,
  ) => {
    const wired = hermesSpawn(spawn, watch);
    return AcpProcess.start(
      recording ? recording(wired) : wired,
      HERMES,
      launch,
    );
  },
};

/** Starts a `hermes acp` that only reads a session back. Off the record: a replay
 * is not a turn, and the record must not file old updates as new. */
export const startReader = (spawn: Spawn, launch: Readonly<{ cwd: string }>) =>
  AcpProcess.start(hermesSpawn(spawn), HERMES, launch);
