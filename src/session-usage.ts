// An agent's token use as Hermes stored it, so the app's usage view covers what
// the local record (./recorder.ts) never saw: sessions from before the plugin, and
// turns that reported no usage over ACP.
//
// Hermes keeps one running total per session, not one per request: its messages
// hold no counts. So what the record measured stays as it is, with its times, and
// the part of the total it did not measure becomes one observation. That one has
// the session's last activity as its time, because nothing says when it was used.
//
// The read is `hermes sessions export`, the owner's grant in the manifest. Its
// answer holds whole transcripts, so each line is parsed alone and only numbers and
// the first prompt's place are kept. Each read starts Hermes and serves every agent.
import type { Spawn } from "@app/features/agent-harness/acp/types";
import type {
  SessionUsage,
  UsageObservation,
} from "@app/features/agents/service";
import { withRevision } from "@app/features/agents/session-usage";
import type { HostProcess } from "@app/features/host/service";
import { promptPlace } from "./recorder";

/** The manifest's grant. Its arguments are fixed there: a host grant takes no
 * others, and this file passes none. */
const USAGE_PROCESS_ID = "hermes-usage";
/** Past this Hermes is stuck, and the read counts as failed. */
const READ_TIMEOUT_MS = 120_000;
/** One session's line. Past this the read fails: it never keeps part of a line,
 * because that would report a session with numbers missing. */
const LINE_LIMIT_CHARS = 256 * 1024 * 1024;
const STDERR_LIMIT_CHARS = 4096;
/** How long one read's answer serves. The app reads each agent in turn, and each
 * read starts a process that loads every transcript. */
const ANSWER_TTL_MS = 60_000;
/** What Hermes writes in place of rows when it has none (`sessions_cmd.py`). Any
 * other text fails the read, also Hermes' "Error: …" with exit code 0. */
const NO_SESSIONS = "No sessions found.";
/** How a compression ends a session row: the next row goes on with its chat. Other
 * children (a reset fork) are conversations of their own. */
const COMPRESSED = "compression";
/** Hermes writes these when it knows a figure; "unknown" comes with a 0. */
const KNOWN_COST = new Set(["actual", "estimated", "included"]);
/** The model of a session that names none. */
const UNKNOWN_MODEL = "unknown";
const COST_SOURCE = "harness";
const MS_PER_SECOND = 1000;
/** The suffix of an observation's id: the record's turns have ids of their own. */
const REST_SUFFIX = ":rest";
/** Marks a session the record shows while this read failed. */
const UNREAD_STORE = "Hermes' session store could not be read";
/** Hermes' names of its counts. Output includes reasoning
 * (`agent/usage_pricing.py`), so `reasoning_tokens` is not added again. */
const COUNTS = {
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_tokens",
  cacheWrite: "cache_write_tokens",
} as const;
type Count = keyof typeof COUNTS;
type Tokens = Readonly<Record<Count, number>>;
const COUNT_NAMES = Object.keys(COUNTS) as readonly Count[];

/** One session row: what stays of an export's line. */
type Row = Readonly<{
  id: string;
  parent?: string;
  ended?: string;
  startedAt: number;
  lastAt: number;
  model: string;
  tokens: Tokens;
  usd?: number;
  place: ReturnType<typeof promptPlace>;
}>;
type UsageHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;

/** A read that failed, with what a log reader needs and no chat text. */
export class HermesUsageError extends Error {
  constructor(
    readonly context: Readonly<{
      operation: string;
      exitCode?: number | null | undefined;
      elapsedMs: number;
      stderr?: string;
      reason?: string;
    }>,
    options?: ErrorOptions,
  ) {
    super(`Hermes usage read failed: ${JSON.stringify(context)}`, options);
    this.name = "HermesUsageError";
  }
}

const object = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const stop = (child: HostProcess) => child.kill().catch(() => undefined);

/** A message's words: Hermes keeps a prompt as text or as content blocks. */
function wordsOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => text(object(block)?.text) ?? "").join("");
}

/** The harness's cost, only when Hermes says it knows one: it writes 0.0 also for
 * a model it has no price for, which is not a free request. */
function costOf(row: Readonly<Record<string, unknown>>) {
  if (!KNOWN_COST.has(String(row.cost_status))) return undefined;
  return count(row.actual_cost_usd) ?? count(row.estimated_cost_usd);
}

/** The numbers of one export line, and the first prompt's place. The first prompt
 * names the session's agent, as it does for a discovery (./session-read.ts). */
function rowOf(value: unknown): Row | undefined {
  const row = object(value);
  const id = text(row?.id);
  if (!row || !id) return undefined;
  const messages = Array.isArray(row.messages) ? row.messages : [];
  const opening = messages.find((item) => object(item)?.role === "user");
  const parent = text(row.parent_session_id);
  const ended = text(row.end_reason);
  const usd = costOf(row);
  const startedAt = (count(row.started_at) ?? 0) * MS_PER_SECOND;
  return {
    id,
    ...(parent ? { parent } : {}),
    ...(ended ? { ended } : {}),
    startedAt,
    lastAt:
      Math.max(count(row.last_activity_at) ?? 0, count(row.ended_at) ?? 0) *
        MS_PER_SECOND || startedAt,
    model: text(row.model) ?? UNKNOWN_MODEL,
    tokens: Object.fromEntries(
      COUNT_NAMES.map((name) => [name, count(row[COUNTS[name]]) ?? 0]),
    ) as Tokens,
    ...(usd !== undefined ? { usd } : {}),
    place: promptPlace(wordsOf(object(opening)?.content)),
  };
}

/** Cuts output into lines and hands each on, keeping no more than the current one,
 * so whole transcripts never pile up in memory. */
class Lines {
  private parts: string[] = [];
  private length = 0;

  constructor(
    private readonly line: (line: string) => void,
    private readonly tooLong: () => void,
  ) {}

  read(data: string) {
    let start = 0;
    for (;;) {
      const end = data.indexOf("\n", start);
      if (end < 0) break;
      this.keep(data.slice(start, end));
      this.flush();
      start = end + 1;
    }
    this.keep(data.slice(start));
  }

  flush() {
    const line = this.parts.join("");
    this.parts = [];
    this.length = 0;
    if (line.trim()) this.line(line);
  }

  private keep(piece: string) {
    this.length += piece.length;
    if (this.length > LINE_LIMIT_CHARS) {
      this.parts = [];
      this.length = 0;
      this.tooLong();
    } else this.parts.push(piece);
  }
}

/** Each conversation's rows, oldest first, under the row its chat started in: the
 * one a session's ACP id names. Compression gives a chat a new row each time. */
function families(rows: readonly Row[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const rootOf = (row: Row) => {
    const seen = new Set([row.id]);
    let at = row;
    for (;;) {
      const parent = at.parent ? byId.get(at.parent) : undefined;
      if (!parent || parent.ended !== COMPRESSED || seen.has(parent.id))
        return at;
      seen.add(parent.id);
      at = parent;
    }
  };
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const { id } = rootOf(row);
    const list = grouped.get(id);
    if (list) list.push(row);
    else grouped.set(id, [row]);
  }
  for (const list of grouped.values())
    list.sort((a, b) => a.startedAt - b.startedAt);
  return grouped;
}

/** What the record measured of a session, which each row then takes away from. */
function measuredBy(session: SessionUsage | undefined) {
  const left = new Map<Count, number>();
  for (const seen of session?.observations ?? [])
    for (const name of COUNT_NAMES)
      left.set(name, (left.get(name) ?? 0) + (seen.tokens[name] ?? 0));
  return left;
}

/** The part of `rows` that `recorded` did not measure, per row. A row's cost goes
 * only on a session with nothing recorded: there it covers exactly these counts,
 * and beside recorded turns, which the app prices itself, it would count twice. */
function restOf(
  rows: readonly Row[],
  recorded: SessionUsage | undefined,
): UsageObservation[] {
  const left = measuredBy(recorded);
  const alone = !recorded?.observations.length;
  return rows.flatMap((row) => {
    const tokens = Object.fromEntries(
      COUNT_NAMES.map((name) => {
        const taken = Math.min(left.get(name) ?? 0, row.tokens[name]);
        left.set(name, (left.get(name) ?? 0) - taken);
        return [name, row.tokens[name] - taken];
      }),
    ) as Tokens;
    if (!COUNT_NAMES.some((name) => tokens[name] > 0)) return [];
    return [
      {
        requestId: `${row.id}${REST_SUFFIX}`,
        at: row.lastAt,
        model: row.model,
        tokens,
        ...(alone && row.usd !== undefined
          ? { cost: { usd: row.usd, source: COST_SOURCE } }
          : {}),
      },
    ];
  });
}

/** One conversation's snapshot: the record's turns and the rest. It has no gaps:
 * the store's totals hold what the record lost, too. */
async function sessionOf(
  root: Row,
  rows: readonly Row[],
  recorded: SessionUsage | undefined,
): Promise<SessionUsage> {
  const channelId = recorded?.channelId ?? root.place.channelId;
  const place = recorded?.root ?? root.place.root;
  const title = recorded?.title ?? root.place.title;
  return withRevision({
    id: root.id,
    gaps: [],
    ...(channelId ? { channelId } : {}),
    ...(place ? { root: place } : {}),
    ...(title ? { title } : {}),
    startedAt: Math.min(root.startedAt, recorded?.startedAt ?? root.startedAt),
    lastAt: Math.max(...rows.map((row) => row.lastAt), recorded?.lastAt ?? 0),
    observations: [
      ...(recorded?.observations ?? []),
      ...restOf(rows, recorded),
    ],
  });
}

/** Reads Hermes' session store. Reads only: `hermes sessions export` writes to no
 * session, and it never starts a model request. */
export class StoreUsage {
  /** The read under way, or the latest one while it still serves. */
  private answer:
    | Readonly<{ at: number; rows: Promise<readonly Row[]> }>
    | undefined;

  constructor(private readonly host: UsageHost) {}

  private async export(): Promise<readonly Row[]> {
    const operation = USAGE_PROCESS_ID;
    const started = Date.now();
    const rows: Row[] = [];
    let stderr = "";
    let failure: { reason: string; cause?: unknown } | undefined;
    let child: HostProcess | undefined;
    const fail = (reason: string, cause?: unknown) => {
      failure ??= { reason, ...(cause === undefined ? {} : { cause }) };
      if (child) void stop(child);
    };
    const lines = new Lines(
      (line) => {
        if (failure || line.trim() === NO_SESSIONS) return;
        try {
          const row = rowOf(JSON.parse(line));
          if (row) rows.push(row);
          else fail("a line holds no session");
        } catch (cause) {
          // A line that is not a row: the cause holds no text of the line.
          fail("a line is not JSON", (cause as Error).name);
        }
      },
      () => fail("a session's line is too long"),
    );
    child = await this.host.spawn(USAGE_PROCESS_ID, {
      cwd: await this.host.resolveDirectory("~"),
      onStdout: (data) => lines.read(data),
      onStderr: (data) => {
        stderr = (stderr + data).slice(-STDERR_LIMIT_CHARS);
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), READ_TIMEOUT_MS);
    });
    try {
      const exitCode = await Promise.race([child.exited, deadline]);
      if (exitCode === undefined) {
        fail("no answer before the deadline");
        await stop(child);
      }
      lines.flush();
      if (exitCode !== 0 || failure)
        throw new HermesUsageError(
          {
            operation,
            exitCode,
            elapsedMs: Date.now() - started,
            stderr,
            ...(failure ? { reason: failure.reason } : {}),
          },
          failure?.cause === undefined ? undefined : { cause: failure.cause },
        );
      return rows;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The store's rows. Agents reading meanwhile share one read, which goes on
   * when one of them is cancelled. A failed read is not kept. */
  private rows() {
    const now = Date.now();
    if (this.answer && now - this.answer.at < ANSWER_TTL_MS)
      return this.answer.rows;
    const rows = this.export();
    const answer = { at: now, rows };
    this.answer = answer;
    rows.catch(() => {
      if (this.answer === answer) this.answer = undefined;
    });
    return rows;
  }

  /** The agent's sessions: those with its record, and those whose first prompt
   * names it. A failed read leaves what the record has, marked incomplete. With
   * nothing to show, it throws, so the app marks the harness unread. */
  async usage(
    agent: string,
    recorded: readonly SessionUsage[],
    { since, signal }: Readonly<{ since: number; signal: AbortSignal }>,
  ): Promise<readonly SessionUsage[]> {
    const onRecord = new Map(recorded.map((session) => [session.id, session]));
    let rows: readonly Row[];
    try {
      rows = await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        signal.addEventListener("abort", abort, { once: true });
        this.rows()
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!recorded.length) throw error;
      console.warn("Hermes usage read failed; the record stays", error);
      return Promise.all(
        recorded.map(({ revision: _, ...session }) =>
          withRevision({ ...session, gaps: [...session.gaps, UNREAD_STORE] }),
        ),
      );
    }
    signal.throwIfAborted();
    const seen = new Set<string>();
    const stored = await Promise.all(
      [...families(rows)].flatMap(([id, list]) => {
        const root = list.find((row) => row.id === id);
        const session = onRecord.get(id);
        if (!root || !(session || root.place.agent === agent)) return [];
        if (Math.max(...list.map((row) => row.lastAt)) < since) return [];
        seen.add(id);
        return [sessionOf(root, list, session)];
      }),
    );
    return [
      ...stored.filter((session) => session.observations.length),
      ...recorded.filter((session) => !seen.has(session.id)),
    ];
  }
}
