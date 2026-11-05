// The Hermes agent type's Activity tab: its sessions and their transcripts,
// laid out as buzz-app's Goose type lays out its own (src/bundled/goose/
// tabs.tsx, Apache-2.0, see NOTICE), from the app's own components. As Goose's tab
// reads goose's sessions, this one reads the harness's (./session-read.ts); the
// local record (./recorder.ts) shows the turn that is running, as it streams, and
// any session the harness cannot give.
// One layout difference: the app opens a transcript in its own panel tab through
// a React context that a plugin cannot reach, so here it replaces the tab's
// content and has a back button, as the app's subview does in a panel without
// tabs. Rendered under the list, it would leave the list above a long transcript.
import { useEffect, useState, useSyncExternalStore } from "react";
import activityStyles from "@app/features/agents/ActivityLayout.module.css";
import { ActivityTranscript } from "@app/features/agents/ActivityTranscript";
import {
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "@app/features/agents/OpenedConversation";
import type { AgentViewProps } from "@app/features/agents/service";
import { PanelSubview } from "@app/features/panels/PanelSubview";
import { formatItemTimestamp } from "@app/shared/datetime";
import { Button } from "@app/shared/design-system/ui/Button";
import { InlineHeader } from "@app/shared/design-system/ui/Header";
import { SettingsGroup } from "@app/shared/design-system/ui/SettingsGroup";
import {
  type Config,
  config,
  type GooseRuntime,
} from "@app/bundled/goose/runtime";
import { type Place, type RecordedHistory, TURN_LIMIT } from "./history";
import type { ActivityRecorder } from "./recorder";
import type { ActivitySessions, SessionReads } from "./session-read";

/** The type's name for its sessions, in the app's sentences. */
const HARNESS = "Hermes";
/** The characters of an id that name it in a row without a title. */
const SHORT_ID = 8;
const BACK_LABEL = "Back to profile";

type Row = Readonly<{
  key: string;
  sessionId: string;
  title: string;
  channelId: string;
  root?: string;
  at?: number;
}>;
const placeOf = (key: string): Place => {
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
};

const NO_READS: SessionReads = new Map();
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createActivity({
  runtime,
  history,
  recorder,
  sessions,
}: Readonly<{
  runtime: GooseRuntime;
  history: RecordedHistory;
  recorder: ActivityRecorder;
  sessions: ActivitySessions;
}>) {
  /** Re-renders with each recorded change. Each store read also serves a paint
   * with no DOM, which is how the smoke run sees this tab. */
  const useRecord = () => {
    const revision = () => recorder.revision;
    return useSyncExternalStore(recorder.subscribe, revision, revision);
  };

  /** What the harness gave for these sessions, read on open, on Refresh and when
   * the working session changes, so a turn's end brings its whole text. What was
   * read stays shown while it is read again. */
  const useSessionReads = (
    from: ReturnType<ActivitySessions["conversation"]>,
    working: string | undefined,
    round: number,
  ) => {
    const [state, setState] = useState<{
      reads: SessionReads;
      loading: boolean;
      error?: string;
    }>({ reads: NO_READS, loading: true });
    const ids = from.map((session) => session.sessionId).join();
    useEffect(() => {
      const abort = new AbortController();
      setState((prior) => ({ reads: prior.reads, loading: true }));
      sessions.read(from, working, abort.signal).then(
        (reads) => {
          if (!abort.signal.aborted) setState({ reads, loading: false });
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          setState((prior) => ({
            reads: prior.reads,
            loading: false,
            error: messageOf(error),
          }));
        },
      );
      return () => abort.abort();
    }, [ids, working, round]);
    return state;
  };

  /** A conversation's transcript: what the harness read, and what is on record of
   * the running session and of any session it could not read. */
  function TranscriptView({
    agent,
    row,
    isBusy,
    openConversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    row: Row;
    isBusy?: ((sessionId: string) => boolean | undefined) | undefined;
    openConversation: AgentViewProps<Config>["openConversation"];
  }) {
    useRecord();
    const [round, refresh] = useState(0);
    const from = sessions.conversation(agent.key, row);
    const working = from.find((session) =>
      isBusy?.(session.sessionId),
    )?.sessionId;
    const { reads, loading, error } = useSessionReads(from, working, round);
    const transcript = sessions.shown(agent.key, from, reads, working);
    const lastTurn = transcript.turns.at(-1)?.turnId;
    const problem = error ?? transcript.failed[0];
    return (
      <div className="grid gap-4">
        <div>
          <Button
            type="button"
            variant="ghost"
            loading={loading}
            onClick={() => refresh((value) => value + 1)}
          >
            Refresh
          </Button>
        </div>
        {problem && (
          <p role="alert" className="m-0">
            Could not read the {HARNESS} session: {problem}. What is on this
            computer's record shows instead.
          </p>
        )}
        {transcript.turns.length ? (
          <ActivityTranscript
            transcript={{
              ...transcript,
              turns: runtime.prompts(agent.key).shown(transcript.turns),
            }}
            agentName={agent.name}
            openConversation={openConversation}
            state={(turnId) =>
              working && turnId === lastTurn ? "working" : undefined
            }
            before={
              transcript.more && (
                <p className="m-0 text-body-sm text-subtle">
                  Showing the latest {TURN_LIMIT} turns.
                </p>
              )
            }
          />
        ) : (
          <p role="status" className="m-0 text-body-sm text-subtle">
            {loading
              ? `Reading the ${HARNESS} session…`
              : `${HARNESS} has no session for this conversation on this computer, and neither has the record. It may have been deleted.`}
          </p>
        )}
      </div>
    );
  }

  /** Adds the sessions only the harness knows of, on open and on Refresh. A list
   * that fails leaves the known sessions as they are. */
  const useDiscovery = (
    agent: AgentViewProps<Config>["agent"],
    round: number,
    found: () => void,
  ) => {
    const workspace = config(agent.config).workspace;
    useEffect(() => {
      const abort = new AbortController();
      sessions.discover(agent.key, workspace, abort.signal).then(
        (any) => {
          if (any && !abort.signal.aborted) found();
        },
        (error: unknown) => {
          if (!abort.signal.aborted)
            console.warn(`${HARNESS} session discovery failed`, error);
        },
      );
      return () => abort.abort();
    }, [agent.key, workspace, round]);
  };

  /** The agent's sessions: the one it was opened from, recent ones, and their
   * transcripts. */
  function ActivityTab({
    agent,
    conversation,
    initialTranscript,
    close,
    openConversation,
  }: AgentViewProps<Config>) {
    useRecord();
    const openSessions = () => runtime.sessions(agent.key);
    const live = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      openSessions,
      openSessions,
    );
    const running = live.map(
      (session): Row => ({
        key: session.key,
        sessionId: session.sessionId ?? "",
        title: "",
        ...placeOf(session.key),
      }),
    );
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(
      running.filter((row) => row.sessionId),
      conversation,
      async (place) => {
        const found = sessions.find(agent.key, place);
        return (
          found && {
            ...found,
            ...place,
            key: place.root
              ? `${place.channelId}/${place.root}`
              : place.channelId,
          }
        );
      },
    );
    const busy = (sessionId: string) =>
      live.find((session) => session.sessionId === sessionId)?.busy;
    const status = (sessionId: string) => {
      const working = busy(sessionId);
      return working === undefined ? undefined : working ? "Working" : "Idle";
    };
    const label = (row: Row) =>
      row.title ||
      `${row.channelId.slice(0, SHORT_ID)} · ${
        row.root ? `thread ${row.root.slice(0, SHORT_ID)}` : "channel"
      }`;
    const { open, show, back } = useOpenTranscript(
      conversation,
      label,
      initialTranscript && { initial: here, searching, ...initialTranscript },
      close,
    );
    const rows = sessions
      .recent(agent.key)
      .filter((row) => row.sessionId !== here?.sessionId)
      .map((row): Row => ({ channelId: "", ...row, key: row.sessionId }));
    const [round, refresh] = useState(0);
    useDiscovery(agent, round, () => refresh((value) => value + 1));
    if (open)
      return (
        <PanelSubview title={label(open)} backLabel={BACK_LABEL} onBack={back}>
          <TranscriptView
            key={open.key}
            agent={agent}
            row={open}
            isBusy={busy}
            openConversation={openConversation}
          />
        </PanelSubview>
      );
    return (
      <div className={activityStyles.activity}>
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness={HARNESS}
            session={here}
            searching={searching}
            error={lookupError}
            status={here && status(here.sessionId)}
            onView={() => here && show(here)}
          />
        )}
        <section className={activityStyles.section}>
          <InlineHeader
            title="Recent sessions"
            actions={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => refresh((value) => value + 1)}
              >
                Refresh
              </Button>
            }
          />
          {rows.length ? (
            <SettingsGroup layout="form">
              <ul className={activityStyles.list}>
                {rows.map((row) => (
                  <li key={row.sessionId} className={activityStyles.entry}>
                    <div className={activityStyles.row}>
                      <span className={activityStyles.copy}>
                        <span
                          className="block truncate text-label-sm"
                          title={label(row)}
                        >
                          {label(row)}
                        </span>
                        <span className="block text-body-sm text-subtle">
                          {[
                            status(row.sessionId),
                            row.at &&
                              formatItemTimestamp(row.at / 1000, {
                                withTime: true,
                              }),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="subtle"
                        size="sm"
                        aria-label={`View transcript: ${label(row)}`}
                        onClick={() => show(row)}
                      >
                        View transcript
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </SettingsGroup>
          ) : (
            <p className="m-0 text-body-sm text-subtle">
              None. A conversation's session starts when the agent is mentioned.
            </p>
          )}
        </section>
      </div>
    );
  }

  // The smoke run reads the record and the harness through the tab, so what it
  // proves is what the tab shows.
  return { ActivityTab: Object.assign(ActivityTab, { history, sessions }) };
}
