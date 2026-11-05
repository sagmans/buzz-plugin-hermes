// An agent's sessions as the Activity tab shows them: read back from the harness
// over ACP `session/load` in a short-lived process, as buzz-app's Goose type reads
// goose's (src/bundled/goose/transcript.ts), with the local record (./recorder.ts)
// for what a replay cannot give. The harness keeps the sessions in its own store,
// so a transcript has no cut text and no cap on bytes; here only ids are kept.
//
// The record stays for three things: the session a turn is running in (it updates
// as the turn streams), a session the harness cannot read now (a failed read never
// hides what is on record), and the times, ends and steers a replay does not hold
// (./transcript.ts, `overlaid`).
//
// Why a log of sessions, and not only ACP `session/list`: Hermes lists only
// sessions of its own ACP source there, not those its gateway runs, and either
// list also names sessions the owner ran in the same workspace. The log names
// exactly the sessions Buzz opened for an agent. `discover` adds, where a harness
// allows it, those a listed session's first prompt proves are the agent's.
//
// Harness-neutral on purpose: the same module serves this project's other ACP
// plugin.
import type { AcpProcess } from "@app/features/agent-harness/acp/process";
import type { Spawn } from "@app/features/agent-harness/acp/types";
import type { TranscriptTurn } from "@app/features/agents/activity-transcript";
import {
  type Place,
  RECENT_LIMIT,
  type RecordedHistory,
  type SessionRow,
  TURN_LIMIT,
} from "./history";
import { promptPlace } from "./recorder";
import { abortable, absolute } from "./sessions";
import { acpTurns, overlaid, type Update } from "./transcript";

/** Sessions read for one conversation, newest first (as Goose reads). */
const SESSION_LIMIT = 10;
/** Sessions the log keeps per agent; the least recently used are forgotten. */
const LOG_LIMIT = 200;
/** One `session/load` or `session/list`, which replays or lists before it
 * answers. Past this the harness is stuck, and the record is shown instead. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Listed sessions checked per discovery: each check replays a whole session. */
const DISCOVER_LIMIT = 15;
/** Pages of `session/list` read per discovery. */
const LIST_PAGE_LIMIT = 3;
const NOT_FOUND = /not found|no such session|unknown session/i;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const keyOf = ({ channelId, root }: Place) =>
  root ? `${channelId}/${root}` : channelId;
const placeOf = (key: string): Place => {
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
};

/** A session the agent ran, in the conversation `key` (`channel` or
 * `channel/root`). */
export type LoggedSession = Readonly<{
  sessionId: string;
  key: string;
  at: number;
  /** The workspace setting it ran with. Hermes' `session/load` moves a session
   * to the cwd it is given, so a read passes this one, not the current setting. */
  workspace: string;
}>;
/** What one session's read gave. `absent`: the harness no longer has it. */
export type SessionRead =
  | Readonly<{ status: "read"; turns: readonly TranscriptTurn[] }>
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "failed"; error: string }>;
export type SessionReads = ReadonlyMap<string, SessionRead>;
/** What the tab shows of a conversation. `failed` names each read that failed,
 * whose session then shows as it is on record. */
export type ShownTranscript = Readonly<{
  turns: readonly TranscriptTurn[];
  more: boolean;
  failed: readonly string[];
}>;
/** A session in a conversation; only a logged one has a workspace to read in. */
type ConversationSession = Readonly<{
  sessionId: string;
  key: string;
  at: number;
  workspace?: string;
}>;
type HistoryHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;
/** Starts the harness with `spawn`, serving no Buzz tools and on no record. */
type Start = (spawn: Spawn, launch: { cwd: string }) => Promise<AcpProcess>;
/** What the log reads of the runtime. */
type LiveSessions = Readonly<{
  sessions(
    agent: string,
  ): readonly Readonly<{ key: string; sessionId?: string; at?: number }>[];
}>;

/** The fields of an ACP `session/list` answer that a discovery reads. */
type SessionList = Readonly<{
  sessions?: readonly Readonly<{ sessionId?: string; updatedAt?: string }>[];
  nextCursor?: string | null;
}>;

/** A harness read that failed, with what a log reader needs and no chat text. */
export class SessionReadError extends Error {
  constructor(
    readonly operation: string,
    readonly sessionId: string,
    readonly elapsedMs: number,
    options: ErrorOptions,
  ) {
    super(
      `${operation} of session ${sessionId} failed after ${elapsedMs} ms: ${message(options.cause)}`,
      options,
    );
    this.name = "SessionReadError";
  }
}

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
    this.add(
      agent,
      runtime.sessions(agent).flatMap(({ key, sessionId, at }) =>
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
      ),
    );
  }

  /** Puts `fresh` in the log, in place of the same sessions' rows. */
  add(agent: string, fresh: readonly LoggedSession[]) {
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

/** The text of a replay's first user message: what names the agent it ran for. */
function openingPrompt(updates: readonly Update[]) {
  const start = updates.findIndex(
    (update) => update.sessionUpdate === "user_message_chunk",
  );
  if (start < 0) return "";
  let text = "";
  for (const update of updates.slice(start)) {
    if (update.sessionUpdate !== "user_message_chunk") break;
    const content = update.content as { text?: unknown } | undefined;
    if (typeof content?.text === "string") text += content.text;
  }
  return text;
}

/** One short-lived harness process per read. */
export class HarnessReader {
  constructor(
    private readonly host: HistoryHost,
    private readonly start: Start,
  ) {}

  /** Each session's replay. One failed read says so and the others go on; a
   * process that does not start fails them all. ACP replays a session before it
   * answers `session/load`. */
  async read(
    sessions: readonly (LoggedSession & { workspace: string })[],
    signal: AbortSignal,
  ): Promise<SessionReads> {
    const reads = new Map<string, SessionRead>();
    if (!sessions.length) return reads;
    try {
      await this.with(signal, async (process, replays) => {
        for (const session of sessions) {
          signal.throwIfAborted();
          reads.set(
            session.sessionId,
            await this.one(process, replays, session, signal),
          );
        }
      });
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn("session read: no harness process", error);
      for (const { sessionId } of sessions)
        if (!reads.has(sessionId))
          reads.set(sessionId, { status: "failed", error: message(error) });
    }
    return reads;
  }

  private async one(
    process: AcpProcess,
    replays: Replays,
    { sessionId, key, workspace }: LoggedSession,
    signal: AbortSignal,
  ): Promise<SessionRead> {
    const startedAt = Date.now();
    try {
      await this.load(process, sessionId, workspace);
    } catch (error) {
      replays.take(sessionId);
      if (signal.aborted) throw error;
      if (NOT_FOUND.test(String(error))) return { status: "absent" };
      const failure = new SessionReadError(
        "session/load",
        sessionId,
        Date.now() - startedAt,
        { cause: error },
      );
      console.warn(failure.message);
      return { status: "failed", error: failure.message };
    }
    return {
      status: "read",
      turns: acpTurns(replays.take(sessionId), sessionId, placeOf(key)),
    };
  }

  private async load(
    process: AcpProcess,
    sessionId: string,
    workspace: string,
  ) {
    const cwd = await absolute(this.host.resolveDirectory, workspace);
    await process.request(
      "session/load",
      { sessionId, cwd, mcpServers: [] },
      REQUEST_TIMEOUT_MS,
    );
  }

  /** The sessions in `workspace` that `agent` ran and `known` does not hold, and
   * every other one checked, so a later discovery skips it: the first prompt of
   * each names its agent, as Goose's `recent` checks. Nothing of a session of
   * someone else's stays. */
  discover(
    agent: string,
    workspace: string,
    known: ReadonlySet<string>,
    signal: AbortSignal,
  ) {
    return this.with(signal, async (process, replays) => {
      const cwd = await absolute(this.host.resolveDirectory, workspace);
      const listed = await this.listed(process, cwd, known);
      const found: LoggedSession[] = [];
      const checked: string[] = [];
      for (const { sessionId, at } of listed.slice(0, DISCOVER_LIMIT)) {
        signal.throwIfAborted();
        await process.request(
          "session/load",
          { sessionId, cwd, mcpServers: [] },
          REQUEST_TIMEOUT_MS,
        );
        checked.push(sessionId);
        const place = promptPlace(openingPrompt(replays.take(sessionId)));
        if (place.agent === agent && place.channelId)
          found.push({
            sessionId,
            at,
            workspace,
            key: keyOf({
              channelId: place.channelId,
              ...(place.root ? { root: place.root } : {}),
            }),
          });
      }
      return { found, checked };
    });
  }

  /** The workspace's sessions outside `known`, newest first. */
  private async listed(
    process: AcpProcess,
    cwd: string,
    known: ReadonlySet<string>,
  ) {
    const rows: { sessionId: string; at: number }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGE_LIMIT; page += 1) {
      const answer = (await process.request(
        "session/list",
        { cwd, ...(cursor ? { cursor } : {}) },
        REQUEST_TIMEOUT_MS,
      )) as SessionList;
      for (const { sessionId, updatedAt } of answer.sessions ?? [])
        if (sessionId && !known.has(sessionId))
          rows.push({ sessionId, at: Date.parse(updatedAt ?? "") || 0 });
      cursor = answer.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return rows.sort((a, b) => b.at - a.at);
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

/** The tab's one source: the agent's sessions and what shows of them. */
export class ActivitySessions {
  /** Listed sessions found not to be each agent's, so a discovery does not
   * replay them again while the plugin runs. */
  private readonly foreign = new Map<string, Set<string>>();

  constructor(
    private readonly recorded: RecordedHistory,
    private readonly log: SessionLog,
    private readonly reader: HarnessReader,
    /** Whether `discover` may read sessions the log does not name. */
    private readonly discovers: boolean,
  ) {}

  /** Every session known, from the record and the log, newest first. Rows of one
   * session join, so the record's title stays beside the log's place. */
  private known(agent: string): SessionRow[] {
    const rows = new Map<string, SessionRow>();
    for (const row of [
      ...this.recorded.recent(agent),
      ...this.log.list(agent).map(({ sessionId, key, at }) => ({
        sessionId,
        title: "",
        at,
        ...placeOf(key),
      })),
    ]) {
      const seen = rows.get(row.sessionId);
      rows.set(
        row.sessionId,
        seen ? { ...row, ...seen, at: Math.max(seen.at, row.at) } : row,
      );
    }
    return [...rows.values()].sort((a, b) => b.at - a.at);
  }

  /** The agent's conversations, most recently active first. A conversation's
   * transcript joins its sessions, so its latest session stands for it. */
  recent(agent: string): SessionRow[] {
    const rows = new Map<string, SessionRow>();
    for (const row of this.known(agent)) {
      const key = row.channelId
        ? keyOf({ ...row, channelId: row.channelId })
        : row.sessionId;
      const seen = rows.get(key);
      if (!seen) rows.set(key, row);
      else if (!seen.title && row.title)
        rows.set(key, { ...seen, title: row.title });
    }
    return [...rows.values()].slice(0, RECENT_LIMIT);
  }

  /** The latest session of a conversation. */
  find(agent: string, place: Place): SessionRow | undefined {
    const key = keyOf(place);
    return this.known(agent).find(
      (row) =>
        row.channelId && keyOf({ ...row, channelId: row.channelId }) === key,
    );
  }

  /** The sessions a row's transcript joins, newest first: its conversation's, and
   * always its own. */
  conversation(
    agent: string,
    row: Readonly<{ sessionId: string; channelId?: string; root?: string }>,
  ): ConversationSession[] {
    const key = row.channelId
      ? keyOf({ ...row, channelId: row.channelId })
      : undefined;
    const logged = new Map(
      this.log.list(agent).map((session) => [session.sessionId, session]),
    );
    const all = this.known(agent).flatMap((item) => {
      const place = item.channelId
        ? keyOf({ ...item, channelId: item.channelId })
        : "";
      if (item.sessionId !== row.sessionId && (!key || place !== key))
        return [];
      const log = logged.get(item.sessionId);
      return [
        {
          sessionId: item.sessionId,
          key: place,
          at: item.at,
          ...(log ? { workspace: log.workspace } : {}),
        },
      ];
    });
    const shown = all.slice(0, SESSION_LIMIT);
    const own = all.find((item) => item.sessionId === row.sessionId);
    return own && !shown.includes(own) ? [...shown, own] : shown;
  }

  /** Reads `sessions` from the harness, except the one a turn is running in and
   * any whose workspace is not known: a read must not move a session. */
  read(
    sessions: readonly ConversationSession[],
    working: string | undefined,
    signal: AbortSignal,
  ) {
    return this.reader.read(
      sessions.flatMap((session) =>
        session.sessionId !== working && session.workspace !== undefined
          ? [{ ...session, workspace: session.workspace }]
          : [],
      ),
      signal,
    );
  }

  /** The conversation's latest turns, oldest first: each session as the harness
   * read it, with what the record adds, or as it is on record. */
  shown(
    agent: string,
    sessions: readonly ConversationSession[],
    reads: SessionReads,
    working?: string,
  ): ShownTranscript {
    const failed: string[] = [];
    let more = false;
    const oldestFirst = [...sessions].sort((a, b) => a.at - b.at);
    const turns = oldestFirst.flatMap(({ sessionId }) => {
      const onRecord = this.recorded.transcript(agent, sessionId);
      const read = sessionId === working ? undefined : reads.get(sessionId);
      if (read?.status === "failed") failed.push(read.error);
      if (read?.status === "read" && read.turns.length)
        return overlaid(read.turns, onRecord?.turns ?? []);
      more ||= onRecord?.more ?? false;
      return onRecord?.turns ?? [];
    });
    return {
      turns: turns.slice(-TURN_LIMIT),
      more: more || turns.length > TURN_LIMIT,
      failed,
    };
  }

  /** Adds to the log the listed sessions proved to be `agent`'s: those from before
   * the log, or that the plugin was not there to log. Does nothing for a harness
   * where a read could change a session it did not open. */
  async discover(agent: string, workspace: string, signal: AbortSignal) {
    if (!this.discovers) return false;
    const foreign = this.foreign.get(agent) ?? new Set<string>();
    this.foreign.set(agent, foreign);
    const known = new Set([
      ...foreign,
      ...this.known(agent).map((row) => row.sessionId),
    ]);
    const { found, checked } = await this.reader.discover(
      agent,
      workspace,
      known,
      signal,
    );
    const mine = new Set(found.map((row) => row.sessionId));
    for (const sessionId of checked)
      if (!mine.has(sessionId)) foreign.add(sessionId);
    this.log.add(agent, found);
    return found.length > 0;
  }
}
