// Hermes on buzz-app's shared ACP client. The build puts this module in place
// of buzz-app's `bundled/goose/goose.ts`, so the Goose runtime and sessions
// code run unchanged against one `hermes acp` process instead of `goose-acp`.
// It exports the same names that code imports. Only what Hermes does
// differently from plain ACP is here: the program, its environment and the
// model switch, and the HTTP MCP capability Hermes leaves out (`advertised`).
// Hermes has no system-prompt or steer extension, so the shared client puts
// the Buzz prompt at the head of a session's first prompt, and a message sent
// mid-turn runs as the next turn.
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
 * over MCP, so the MCP servers in the owner's Hermes config do not start in
 * a Buzz agent (buzz-acp sets the same variable for Hermes). The shared
 * client always removes the Buzz identity from the environment. */
export const ENV: Readonly<Record<string, string | null>> = {
  HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
};

/** The `agentInfo.name` of Hermes' ACP adapter. */
const AGENT_NAME = "hermes-agent";

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

/** `spawn`, with Hermes' `initialize` answer completed (`advertised`).
 *
 * Why: Hermes' ACP adapter takes HTTP MCP servers in `session/new` and
 * connects to them, but its `initialize` answer has no `mcpCapabilities`
 * (checked against Hermes 0.22.1). The shared client refuses a harness that
 * does not advertise HTTP MCP, because Buzz tools reach it only that way.
 * Only the lines before the `initialize` answer are read; the rest of the
 * output passes through as it comes. The smoke run (README, "Checks") proves
 * that Hermes calls the Buzz tools. */
export function hermesSpawn(spawn: Spawn): Spawn {
  return (id, options) => {
    const onStdout = options?.onStdout;
    if (!onStdout) return spawn(id, options);
    let pending = "";
    let done = false;
    return spawn(id, {
      ...options,
      onStdout: (data) => {
        if (done) return onStdout(data);
        pending += data;
        const end = pending.lastIndexOf("\n");
        if (end < 0) return;
        const lines = pending.slice(0, end).split("\n");
        pending = pending.slice(end + 1);
        const out = lines.map((line) => {
          const next = done ? line : advertised(line);
          if (next !== line || /"agentCapabilities"/.test(line)) done = true;
          return next;
        });
        onStdout(`${out.join("\n")}\n${done ? pending : ""}`);
        if (done) pending = "";
      },
    });
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
  // provider field of the shared choice stays empty. An empty model keeps the
  // model that Hermes' own config picks. A config change reopens idle
  // sessions, so a session never has to go back to that default.
  select: async (hermes, session, want) => {
    if (!want.model || want.model === session.chosen.model) return;
    try {
      await hermes.request(
        "session/set_model",
        { sessionId: session.id, modelId: want.model },
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      throw new Error(
        `Hermes could not switch to the model ${want.model}: ${errorMessage(error)}`,
      );
    }
    session.chosen = { ...session.chosen, model: want.model };
  },
};

/** Starts `hermes acp`. The name is the one the Goose sessions code imports. */
export const GooseProcess = {
  start: (
    spawn: Spawn,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
    }>,
  ) => AcpProcess.start(hermesSpawn(spawn), HERMES, launch),
};
