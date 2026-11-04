// An agent's sessions: the log of which ones it ran, and their transcripts,
// read back over ACP `session/load` in a short-lived process, as buzz-app's
// Goose type reads goose's (src/bundled/goose/transcript.ts). The harness keeps
// the sessions in its own store; only their ids are kept here.
//
// Why a log and not ACP `session/list`: Hermes lists only sessions of its own
// ACP source there, not those its gateway runs, and either list also names
// sessions the owner ran in the same workspace. The log names exactly the
// sessions Buzz opened for an agent, so a session it did not open is never read.
// (The same module as buzz-plugin-opencode's src/history.ts.)
import type { AcpProcess } from "@app/features/agent-harness/acp/process";
import type { Spawn } from "@app/features/agent-harness/acp/types";
import type { TranscriptTurn } from "@app/features/agents/activity-transcript";
import { abortable, absolute } from "./sessions";
import { acpTurns, type Place, type Update } from "./transcript";

/** The latest turns shown; the harness keeps the rest. */
export const TURN_LIMIT = 50;
/** Sessions read for one conversation, newest first. */
const SESSION_LIMIT = 10;
/** Sessions the log keeps per agent; the least recently used are forgotten. */
const LOG_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 60_000;
const NOT_FOUND = /not found|no such session|unknown session/i;

/** A session the agent ran, in the conversation `key` (`channel` or
 * `channel/root`). */
export type LoggedSession = Readonly<{
  sessionId: string;
  key: string;
  at: number;
  /** The workspace setting it ran with. Hermes' `session/load` re-points a
   * session at the cwd it is given, so a read passes this one, not the current
   * setting. */
  workspace: string;
}>;
export type HistoryTranscript = Readonly<{
  turns: readonly TranscriptTurn[];
  more: boolean;
}>;
type HistoryHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;
/** Starts the harness with `spawn`, serving no Buzz tools. */
type Start = (spawn: Spawn, launch: { cwd: string }) => Promise<AcpProcess>;
/** What the log reads of the runtime. */
type LiveSessions = Readonly<{
  sessions(
    agent: string,
  ): readonly Readonly<{ key: string; sessionId?: string; at?: number }>[];
}>;

/** The sessions each agent ran, in local storage, newest first. */
export class SessionLog {
  constructor(
    private readonly storage: Storage,
    private readonly name: string,
  ) {}

  private all(): Record<string, LoggedSession[]> {
    try {
      const value = JSON.parse(this.storage.getItem(this.name) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  list(agent: string): readonly LoggedSession[] {
    const rows = this.all()[agent];
    return Array.isArray(rows) ? rows : [];
  }

  /** Adds the agent's open sessions. A session already logged keeps the
   * workspace it opened with. */
  record(agent: string, runtime: LiveSessions, workspace: string) {
    const logged = new Map(this.list(agent).map((row) => [row.sessionId, row]));
    const fresh = runtime.sessions(agent).flatMap(({ key, sessionId, at }) =>
      sessionId
        ? [
            {
              sessionId,
              key,
              at: at ?? Date.now(),
              workspace: logged.get(sessionId)?.workspace ?? workspace,
            },
          ]
        : [],
    );
    if (!fresh.length) return;
    const all = this.all();
    const ids = new Set(fresh.map((row) => row.sessionId));
    const rows = [
      ...fresh,
      ...this.list(agent).filter((row) => !ids.has(row.sessionId)),
    ];
    all[agent] = rows.sort((a, b) => b.at - a.at).slice(0, LOG_LIMIT);
    try {
      this.storage.setItem(this.name, JSON.stringify(all));
    } catch (error) {
      // A full store loses the log's newest row, not the agent's turn.
      console.warn(`${this.name}: could not save a session`, error);
    }
  }
}

/** The running process's replays: what `session/update` said per session. */
class Replays {
  private readonly updates = new Map<string, Update[]>();
  private pending = "";

  /** One piece of the process's stdout. */
  read(data: string) {
    const lines = (this.pending + data).split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string) {
    let message: { method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line);
    } catch {
      return; // A line that is not JSON-RPC is the harness's own output.
    }
    if (message.method !== "session/update") return;
    const sessionId = String(message.params?.sessionId);
    const update = message.params?.update as Update | undefined;
    if (!update) return;
    const known = this.updates.get(sessionId);
    if (known) known.push(update);
    else this.updates.set(sessionId, [update]);
  }

  /** Forgets and gives what a session's replay said. */
  take(sessionId: string) {
    const known = this.updates.get(sessionId) ?? [];
    this.updates.delete(sessionId);
    return known;
  }
}

export class AcpHistory {
  constructor(
    private readonly host: HistoryHost,
    private readonly start: Start,
  ) {}

  /** The latest turns of `sessions`, oldest first, or undefined when the
   * harness has none of them. ACP replays a session before it answers
   * `session/load`. */
  transcript(
    sessions: readonly LoggedSession[],
    place: Place,
    signal: AbortSignal,
  ): Promise<HistoryTranscript | undefined> {
    return this.with(signal, async (process, replays) => {
      const newest = [...sessions].sort((a, b) => b.at - a.at);
      const read: TranscriptTurn[][] = [];
      for (const { sessionId, workspace } of newest.slice(0, SESSION_LIMIT)) {
        signal.throwIfAborted();
        try {
          const cwd = await absolute(this.host.resolveDirectory, workspace);
          await process.request(
            "session/load",
            { sessionId, cwd, mcpServers: [] },
            REQUEST_TIMEOUT_MS,
          );
        } catch (error) {
          replays.take(sessionId);
          if (NOT_FOUND.test(String(error))) continue;
          throw error;
        }
        read.unshift(acpTurns(replays.take(sessionId), sessionId, place));
      }
      if (!read.length) return undefined;
      const turns = read.flat();
      return {
        turns: turns.slice(-TURN_LIMIT),
        more: turns.length > TURN_LIMIT,
      };
    });
  }

  /** Runs `run` against a process started for it in the home folder, and stops
   * it after. Cancelling rejects at once. */
  private async with<T>(
    signal: AbortSignal,
    run: (process: AcpProcess, replays: Replays) => Promise<T>,
  ) {
    const { host } = this;
    const replays = new Replays();
    // The process object gives updates only to the sessions it opened itself.
    const spawn: Spawn = (id, options) =>
      host.spawn(id, {
        ...options,
        onStdout: (data) => {
          replays.read(data);
          options?.onStdout?.(data);
        },
      });
    const process = await this.start(spawn, {
      cwd: await host.resolveDirectory("~"),
    });
    try {
      return await abortable(run(process, replays), signal);
    } finally {
      await process.kill();
    }
  }
}
