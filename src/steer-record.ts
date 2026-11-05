// Puts a steer Hermes took on the Activity record, as the steer it is.
//
// Why here: `recorder.ts` is a shared copy, with the same code as the other
// ACP plugin's, and a harness that steers with a second `session/prompt` is not
// what it models. It takes every `session/prompt` for a new turn, and that would
// leave the running turn open for good, so the steer hook writes its own method
// (hermes.ts, `STEER_METHOD`), which the recorder leaves out. This tap beside it
// files that request in the running turn, in the frame the app's transcript shows
// as a steer (activity-transcript.ts, `PROMPT_METHODS`).
//
// A refused steer is not filed: the shared client runs its text as the next
// turn, which the recorder records as a prompt.
import type { Spawn } from "@app/features/agent-harness/acp/types";
import {
  type ActivityRecorder,
  object,
  promptPlace,
  promptText,
  str,
  tapSpawn,
  type Wire,
  type WireTap,
} from "./recorder";
import { STEER_METHOD } from "./hermes";

const PROMPT_METHOD = "session/prompt";
/** Sessions tracked per process, as a session no prompt names again must not
 * grow this without bound; the same bound the recorder keeps. */
const SESSIONS_TRACKED = 200;
/** A steer's text is cut to this many characters, as the recorder cuts a prompt. */
const STEER_TEXT_LIMIT = 64_000;
/** The recorder's bound on one turn's frames: steers stay within it too. */
const TURN_BUDGET_BYTES = 400_000;
/** The marker the app's transcript reads as cut text (activity-transcript.ts). */
const ELIDED = "…[elided ";

/** `text`, cut and marked as the recorder cuts it. */
const clipped = (text: string) =>
  text.length > STEER_TEXT_LIMIT
    ? `${text.slice(0, STEER_TEXT_LIMIT)}${ELIDED}${text.length - STEER_TEXT_LIMIT} characters]`
    : text;

/** One process's steers on their way to Hermes. */
class SteerRecord implements WireTap {
  /** Which agent each session serves, from its first prompt that names one, as
   * the recorder binds them. */
  private readonly agents = new Map<string, string>();
  /** Steers not answered yet, by request id. */
  private readonly steers = new Map<string, Wire>();

  constructor(private readonly recorder: ActivityRecorder) {}

  written(message: Wire) {
    const sessionId = str(object(message.params)?.sessionId);
    if (message.method === PROMPT_METHOD) {
      const { agent } = promptPlace(promptText(message));
      if (agent && !this.agents.has(sessionId)) this.bind(sessionId, agent);
    } else if (message.method === STEER_METHOD && message.id !== undefined)
      this.steers.set(JSON.stringify(message.id), message);
  }

  read(message: Wire): undefined {
    if (message.method !== undefined || message.id === undefined)
      return undefined;
    const key = JSON.stringify(message.id);
    const steer = this.steers.get(key);
    if (!steer) return undefined;
    this.steers.delete(key);
    if (!message.error) this.file(steer);
    return undefined;
  }

  private bind(sessionId: string, agent: string) {
    if (this.agents.size >= SESSIONS_TRACKED) {
      const [oldest] = this.agents.keys();
      if (oldest !== undefined) this.agents.delete(oldest);
    }
    this.agents.set(sessionId, agent);
  }

  /** Files `steer` in its session's latest turn: the one it steered. */
  private file(steer: Wire) {
    const params = object(steer.params);
    const sessionId = str(params?.sessionId);
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    const turn = this.recorder
      .turns(agent)
      .findLast((item) => item.sessionId === sessionId);
    if (!turn) return;
    const frame = {
      turnId: turn.id,
      kind: "acp_write",
      ...(turn.channelId ? { channelId: turn.channelId } : {}),
      sessionId,
      timestamp: new Date().toISOString(),
      agentIndex: turn.frames[0]?.agentIndex ?? 0,
      payload: {
        jsonrpc: "2.0",
        id: steer.id,
        method: STEER_METHOD,
        params: {
          sessionId,
          prompt: [{ type: "text", text: clipped(promptText(steer)) }],
        },
      },
    };
    const size = JSON.stringify(frame).length;
    if ((turn.size ?? 0) + size > TURN_BUDGET_BYTES)
      turn.dropped = (turn.dropped ?? 0) + 1;
    else {
      turn.size = (turn.size ?? 0) + size;
      turn.frames.push(frame);
    }
    this.recorder.changed(agent, false);
  }
}

/** `spawn`, with every process it starts on `recorder`'s record, steers too. */
export function recordedSpawn(recorder: ActivityRecorder, spawn: Spawn): Spawn {
  return tapSpawn(recorder.tap(spawn), () => new SteerRecord(recorder));
}
