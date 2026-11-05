// The build puts this module in place of buzz-app's `bundled/goose/sessions.ts`
// for the Goose runtime. It keeps that module's code and changes two things.
// Hermes agents save their conversations under their own local storage key,
// so a Hermes agent never reads or trims the saved sessions of a Goose agent.
// And the shared process stops when it is idle or full (`SharedProcess`).
// The original module's `./goose` import already resolves to `./hermes`.
import type { AcpProcess } from "@app/features/agent-harness/acp/process";
import { localSessions as gooseLocalSessions } from "@app/bundled/goose/sessions";
import {
  GooseProcess,
  type GooseHost,
  type HermesWire,
  type ServeMcp,
} from "./hermes";

export {
  abortable,
  absolute,
  AgentSessions,
  IDLE_MS,
  POOL_LIMIT,
  ServerPool,
  type Launch,
  type SavedConversation,
  type SessionsOptions,
  type SessionStore,
} from "@app/bundled/goose/sessions";

/** This plugin's local storage key for saved conversations. A new shape
 * needs a new version suffix: saved agents read this one. */
export const SESSIONS_KEY = "sagmans.hermes.sessions.v1";

/** When the shared process stops. `sessions`: above the app's pool of open
 * sessions (`POOL_LIMIT`, 48), so a full pool alone never stops it; what it
 * counts past that are sessions the client has closed and Hermes still holds.
 * `quietMs`: the traffic-free wait that also stops it when it is over that
 * number. It covers the short time between handing the process to a session
 * that opens and that session's first request. `idleMs`: longer than the app's
 * own 15-minute close of a quiet session, so an idle stop finds none open. */
export const RECYCLE_LIMITS: RecycleLimits = {
  idleMs: 30 * 60_000,
  sessions: 64,
  quietMs: 60_000,
  checkMs: 30_000,
};
export type RecycleLimits = Readonly<{
  idleMs: number;
  sessions: number;
  quietMs: number;
  checkMs: number;
}>;

/** Why the process should stop now, or undefined. Never while a turn runs or
 * a request waits for its answer. */
function recycleReason(
  hermes: AcpProcess,
  wire: HermesWire,
  limits: RecycleLimits,
) {
  if (!hermes.running || hermes.busy || wire.waiting) return undefined;
  const quiet = Date.now() - wire.lastActive;
  if (quiet >= limits.idleMs) return "idle";
  return wire.sessions > limits.sessions && quiet >= limits.quietMs
    ? "sessions"
    : undefined;
}

/** The one `hermes acp` every Hermes agent's sessions open in. It repeats
 * Goose's `SharedProcess`: started in the home folder when a session first
 * needs it, and again after it exits.
 *
 * Why it also stops by itself: Hermes frees a session, with the MCP servers
 * bound to it, only when the socket of its `hermes acp` closes; `session/close`
 * does nothing (acp_adapter/gateway_server.py, gateway/session_acp_lifecycle.py).
 * A process that lives as long as the app would hold every session it ever
 * opened. The shared client drops a stopped process's sessions, and the next
 * message of each conversation opens a new one that is shown the conversation
 * again (acp/agent-sessions.ts, `deliver` and `open`). */
export class SharedProcess {
  private ready: Promise<AcpProcess> | undefined;
  private wire: HermesWire | undefined;
  private watching: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly host: GooseHost,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
    private readonly limits: RecycleLimits = RECYCLE_LIMITS,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call. */
  get(): Promise<AcpProcess> {
    if (this.ready) {
      // The caller opens a session in it next, with no traffic until then.
      this.wire?.touch();
      return this.ready;
    }
    let wire: HermesWire | undefined;
    const ready = (async () =>
      GooseProcess.start(
        this.host.spawn,
        {
          cwd: await this.host.resolveDirectory("~"),
          serve: this.serve,
        },
        (made) => {
          wire = made;
        },
      ))();
    const forget = () => {
      if (this.ready !== ready) return;
      this.ready = undefined;
      this.unwatch();
    };
    void ready.then((hermes) => {
      if (this.ready === ready && wire) this.watch(hermes, wire);
      return hermes.exited.then(forget);
    }, forget);
    this.ready = ready;
    return ready;
  }

  /** Stops it, failing every session in it. */
  stop() {
    const ready = this.ready;
    this.ready = undefined;
    this.unwatch();
    void ready
      ?.then((hermes) => hermes.kill())
      .catch((error: unknown) =>
        console.warn("Hermes did not stop", { operation: "stop", error }),
      );
  }

  private watch(hermes: AcpProcess, wire: HermesWire) {
    this.wire = wire;
    this.watching = setInterval(() => {
      const reason = recycleReason(hermes, wire, this.limits);
      if (!reason) return;
      console.info("Stopping the idle Hermes process", {
        operation: "recycle",
        reason,
        sessions: wire.sessions,
        quietMs: Date.now() - wire.lastActive,
      });
      this.stop();
    }, this.limits.checkMs);
  }
  private unwatch() {
    clearInterval(this.watching);
    this.watching = undefined;
    this.wire = undefined;
  }
}

/** Saved conversations per agent, under this plugin's key by default. */
export function localSessions(
  storage: Storage,
  agent: string,
  name = SESSIONS_KEY,
) {
  return gooseLocalSessions(storage, agent, name);
}
