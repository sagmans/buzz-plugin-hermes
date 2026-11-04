// A session as ACP `session/load` replays it, in the app's turn-transcript
// model, so the app's own ActivityTranscript shows it as it shows a Goose
// session. A replay carries no times and no turn ends: its turns have no dates
// and their status stays unknown, except for the one still working.
// (The same module as buzz-plugin-opencode's src/transcript.ts.)
import {
  promptMessage,
  promptSections,
  type ToolDiff,
  type ToolItem,
  type TranscriptTurn,
} from "@app/features/agents/activity-transcript";

type Json = Record<string, unknown>;
/** One `session/update` of a replay. */
export type Update = Json;
export type Place = Readonly<{ channelId: string; root?: string }>;

const STEER = "new-message-arrived-while-you-were-working";
/** The time of an item in a replay: `ActivityTranscript` hides an unknown one. */
const NO_TIME = 0;
/** A Buzz message tool as a harness names it: `buzz_send`, `mcp__…__send`,
 * or Hermes' `Editor Buzz 8e2485e8 · send`. */
const SEND_TOOL = /(?:^|[_.·\s])send$/i;
/** What a message tool returns when the relay did not take the message. */
const SEND_ERROR = /^\s*\{\s*"error"\s*:/m;
const COMPACTED = "Earlier turns were compacted.";

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) =>
  Array.isArray(value) ? (value as unknown[]) : [];
const chunkText = (update: Update) => str(object(update.content)?.text);

/** The text blocks of a tool update's content. */
const contentText = (update: Update) =>
  list(update.content)
    .map((entry) => str(object(object(entry)?.content)?.text))
    .filter(Boolean)
    .join("\n");

/** The file edits of a tool update's content. */
const diffsOf = (update: Update): ToolDiff[] =>
  list(update.content).flatMap((entry) => {
    const diff = object(entry);
    if (diff?.type !== "diff") return [];
    const oldText = str(diff.oldText);
    return [
      {
        path: str(diff.path),
        newText: str(diff.newText),
        ...(oldText && { oldText }),
      },
    ];
  });

const pathsOf = (update: Update) =>
  list(update.locations)
    .map((entry) => str(object(entry)?.path))
    .filter(Boolean);

const hasCompaction = (update: Update) =>
  object(object(update._meta)?.hermes)?.containsCompactionSummary === true;

/** The text a message tool call posts, or "" for any other call. Hermes wraps
 * its calls in a batch, as `calls`. */
function postedText(update: Update) {
  const input = object(update.rawInput);
  const batched = object(list(input?.calls)[0]);
  const args = object(batched?.arguments) ?? input;
  const name = str(batched?.name) || str(update.title);
  return SEND_TOOL.test(name) ? str(args?.text).trim() : "";
}

/** A Buzz prompt, or a steer wrapping one, as a turn's opening item. */
function promptItem(id: string, raw: string) {
  let sections = promptSections(raw);
  const steer = sections.find((section) => section.tag === STEER);
  if (steer) sections = promptSections(steer.body);
  const { text, author } = promptMessage(sections);
  return {
    id,
    at: NO_TIME,
    type: "prompt" as const,
    text: text || raw,
    ...(author ? { author } : {}),
    sections,
    steer: !!steer,
  };
}

/** Folds a replay's updates into turns, in order. */
class Turns {
  readonly turns: TranscriptTurn[] = [];
  private readonly tools = new Map<string, ToolItem>();
  private readonly sends = new Map<string, { posted?: boolean }>();
  private count = 0;
  /** The prompt, message or thought whose chunks are still arriving. */
  private open: { kind: string; text: string } | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly place: Place,
  ) {}

  private id() {
    this.count += 1;
    return `${this.sessionId}:${this.count}`;
  }

  private turn(partial: boolean) {
    const next: TranscriptTurn = {
      turnId: this.id(),
      channelId: this.place.channelId || null,
      threadRootId: this.place.channelId
        ? (this.place.root ?? null)
        : undefined,
      triggeringEventIds: [],
      sessionId: this.sessionId,
      newSession: false,
      config: [],
      startedAt: NO_TIME,
      partial,
      items: [],
    };
    this.turns.push(next);
    return next;
  }

  private current() {
    return this.turns.at(-1) ?? this.turn(true);
  }

  /** Ends the open chunks as one item. */
  flush() {
    const open = this.open;
    this.open = undefined;
    if (!open?.text.trim()) return;
    if (open.kind === "prompt") {
      const item = promptItem(this.id(), open.text);
      (item.steer ? this.current() : this.turn(false)).items.push(item);
      return;
    }
    this.current().items.push({
      id: this.id(),
      at: NO_TIME,
      type: open.kind === "thought" ? "thought" : "message",
      text: open.text,
    });
  }

  private chunk(kind: string, update: Update) {
    if (hasCompaction(update)) {
      this.flush();
      this.current().items.push({
        id: this.id(),
        at: NO_TIME,
        type: "status",
        text: COMPACTED,
      });
      return;
    }
    if (this.open?.kind !== kind) {
      this.flush();
      this.open = { kind, text: "" };
    }
    if (this.open) this.open.text += chunkText(update);
  }

  private toolCall(update: Update) {
    this.flush();
    const callId = str(update.toolCallId);
    const text = postedText(update);
    if (text) {
      const message: {
        id: string;
        at: number;
        type: "message";
        text: string;
        posted?: boolean;
      } = {
        id: this.id(),
        at: NO_TIME,
        type: "message",
        text,
      };
      this.current().items.push(message);
      this.sends.set(callId, message);
      return;
    }
    const tool: ToolItem = {
      id: this.id(),
      at: NO_TIME,
      type: "tool",
      toolCallId: callId,
      title: str(update.title) || "Tool",
      kind: str(update.kind) || "other",
      status: str(update.status) || "in_progress",
      // Hermes shows the call as its content, not as raw input.
      input: update.rawInput
        ? JSON.stringify(update.rawInput, null, 2)
        : contentText(update),
      output: "",
      diffs: diffsOf(update),
      paths: pathsOf(update),
      truncated: false,
    };
    this.tools.set(callId, tool);
    this.current().items.push(tool);
  }

  private toolUpdate(update: Update) {
    const callId = str(update.toolCallId);
    const text =
      contentText(update) ||
      (update.rawOutput ? JSON.stringify(update.rawOutput, null, 2) : "");
    const status = str(update.status);
    const sent = this.sends.get(callId);
    if (sent) {
      if (status === "failed" || SEND_ERROR.test(text))
        this.current().items.push({
          id: this.id(),
          at: NO_TIME,
          type: "status",
          text: `The message above was not posted: ${text}`,
        });
      else if (status === "completed") sent.posted = true;
      return;
    }
    const tool = this.tools.get(callId);
    if (!tool) return;
    if (status) tool.status = status;
    if (str(update.title)) tool.title = str(update.title);
    if (text) tool.output = text;
    tool.diffs.push(...diffsOf(update));
    tool.paths = [...new Set([...tool.paths, ...pathsOf(update)])];
  }

  private plan(update: Update) {
    this.flush();
    this.current().items.push({
      id: this.id(),
      at: NO_TIME,
      type: "plan",
      entries: list(update.entries).map((entry) => ({
        content: str(object(entry)?.content),
        status: str(object(entry)?.status),
      })),
    });
  }

  add(update: Update) {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return this.chunk("prompt", update);
      case "agent_message_chunk":
        return this.chunk("message", update);
      case "agent_thought_chunk":
        return this.chunk("thought", update);
      case "tool_call":
        return this.toolCall(update);
      case "tool_call_update":
        return this.toolUpdate(update);
      case "plan":
        return this.plan(update);
      default:
        // What a replay also says that is not history, such as its commands.
        return undefined;
    }
  }
}

/** A session's updates as turns; the first one opens the session. */
export function acpTurns(
  updates: readonly Update[],
  sessionId: string,
  place: Place,
): TranscriptTurn[] {
  const fold = new Turns(sessionId, place);
  for (const update of updates) fold.add(update);
  fold.flush();
  const [first] = fold.turns;
  if (first && !first.partial) first.newSession = true;
  return fold.turns;
}
