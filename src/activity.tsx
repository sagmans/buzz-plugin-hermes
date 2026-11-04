// The Activity tab of the agent panel: the session of the conversation the
// panel was opened from, the agent's recent sessions, and their transcripts.
// It is laid out as buzz-app's Goose type lays out its own (ActivityTab in
// src/bundled/goose/tabs.tsx), from the app's own components bundled unchanged.
// One difference: the app opens a transcript in its own panel tab through a
// React context that a plugin cannot reach, so here it replaces the tab's content
// and has a back button, as the app's subview does in a panel without tabs.
// (The same module as buzz-plugin-opencode's src/activity.tsx.)
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
  type AcpHistory,
  type HistoryTranscript,
  type SessionLog,
  TURN_LIMIT,
} from "./history";
import type { Place } from "./transcript";

/** How many characters of an id name a conversation with no name. */
const SHORT_ID = 8;
/** The agent's recent sessions listed. */
const RECENT_LIMIT = 30;
const BACK_LABEL = "Back to profile";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** The log already holds every session the agent ran from this plugin. */
const noSearch = async () => undefined;

/** A session the profile can show. */
type Row = Readonly<{
  key: string;
  sessionId: string;
  channelId: string;
  root?: string;
  at?: number;
}>;
/** What the tab needs of the runtime. */
type LiveSessions = Readonly<{
  sessions(
    agent: string,
  ): readonly Readonly<{ key: string; sessionId?: string; busy: boolean }>[];
  subscribe(listener: () => void): () => void;
}>;

const placeOf = (key: string): Place => {
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
};

type Read<T> =
  | { status: "loading"; value?: T }
  | { status: "ready"; value: T }
  | { status: "error"; error: string; value?: T };

/** `read()` as it settles, read again when `key` changes or on `retry`. A
 * value already shown stays while it is read again. */
function useRead<T>(read: (signal: AbortSignal) => Promise<T>, key: string) {
  const [state, setState] = useState<Read<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const kept = (prior: Read<T>) =>
      prior.value === undefined ? {} : { value: prior.value };
    setState((prior) => ({ status: "loading", ...kept(prior) }));
    read(abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setState({ status: "ready", value });
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setState((prior) => ({
          status: "error",
          error: message(error),
          ...kept(prior),
        }));
      },
    );
    return () => abort.abort();
  }, [key, round]);
  return [state, () => setRound((value) => value + 1)] as const;
}

export function createActivity(
  harness: string,
  runtime: LiveSessions,
  history: AcpHistory,
  log: SessionLog,
  workspaceOf: (config: unknown) => string,
) {
  /** A conversation's turns across its sessions, or one session's, read on
   * open and on Refresh. A refresh keeps the last result until the new one
   * arrives; a turn ending rereads, so its last steps show. */
  function TranscriptView({
    agent,
    row,
    working,
    openConversation,
  }: Readonly<{
    agent: AgentViewProps<unknown>["agent"];
    row: Row;
    working?: string | undefined;
    openConversation: AgentViewProps<unknown>["openConversation"];
  }>) {
    const workspace = workspaceOf(agent.config);
    const [read, retry] = useRead<HistoryTranscript | undefined>(
      (signal) => {
        const logged = log
          .list(agent.key)
          .filter((session) => session.key === row.key);
        const opened = logged.some((s) => s.sessionId === row.sessionId)
          ? []
          : [
              {
                sessionId: row.sessionId,
                key: row.key,
                at: row.at ?? Date.now(),
                workspace,
              },
            ];
        return history.transcript(
          [...opened, ...logged],
          placeOf(row.key),
          signal,
        );
      },
      `${row.key}\u0000${workspace}\u0000${working ?? ""}`,
    );
    return (
      <div className="grid gap-4">
        <div>
          <Button
            type="button"
            variant="ghost"
            loading={read.status === "loading"}
            onClick={retry}
          >
            Refresh
          </Button>
        </div>
        {read.status === "error" && (
          <p role="alert" className="m-0">
            Could not read the {harness} session: {read.error}
          </p>
        )}
        {read.status === "loading" && !read.value && (
          <p role="status" className="m-0">
            Reading the {harness} session…
          </p>
        )}
        {read.status === "ready" && !read.value && (
          <p className="m-0 text-body-sm text-subtle">
            {harness} has no session for this conversation on this computer. It
            may have been deleted, or it ran in a different workspace.
          </p>
        )}
        {read.value && (
          <ActivityTranscript
            transcript={read.value}
            agentName={agent.name}
            openConversation={openConversation}
            // Only the newest turn can be running: a replay has no turn ends.
            state={(turnId) =>
              working && turnId === read.value?.turns.at(-1)?.turnId
                ? "working"
                : undefined
            }
            before={
              read.value.more && (
                <p className="m-0 text-body-sm text-subtle">
                  Showing the latest {TURN_LIMIT} turns.
                </p>
              )
            }
          />
        )}
      </div>
    );
  }

  /** The agent's sessions: the one it was opened from, recent ones, and their
   * transcripts. */
  function ActivityTab({
    agent,
    conversation,
    initialTranscript,
    close,
    openConversation,
  }: AgentViewProps<unknown>) {
    const [round, setRound] = useState(0);
    const live = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.key),
    );
    const saved = useMemo(() => {
      const rows = new Map<string, Row>();
      // Newest first; a conversation's latest session stands for it.
      for (const { sessionId, key, at } of [
        ...live.flatMap((session) =>
          session.sessionId
            ? [
                {
                  sessionId: session.sessionId,
                  key: session.key,
                  at: Date.now(),
                },
              ]
            : [],
        ),
        ...log.list(agent.key),
      ])
        if (!rows.has(key))
          rows.set(key, { key, sessionId, at, ...placeOf(key) });
      return [...rows.values()];
    }, [live, round, agent.key]);
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession<Row>(saved, conversation, noSearch);
    const busy = (sessionId: string) =>
      live.find((session) => session.sessionId === sessionId)?.busy;
    const status = (sessionId: string) => {
      const working = busy(sessionId);
      return working === undefined ? undefined : working ? "Working" : "Idle";
    };
    const label = (row: Row) =>
      `${row.channelId.slice(0, SHORT_ID)} · ${
        row.root ? `thread ${row.root.slice(0, SHORT_ID)}` : "channel"
      }`;
    const { open, show, back } = useOpenTranscript<Row>(
      conversation,
      label,
      initialTranscript && { initial: here, searching, ...initialTranscript },
      close,
    );
    const rows = saved
      .filter((row) => row.sessionId !== here?.sessionId)
      .slice(0, RECENT_LIMIT);
    if (open)
      return (
        <PanelSubview title={label(open)} backLabel={BACK_LABEL} onBack={back}>
          <TranscriptView
            key={open.key}
            agent={agent}
            row={open}
            working={busy(open.sessionId) ? open.sessionId : undefined}
            openConversation={openConversation}
          />
        </PanelSubview>
      );
    return (
      <div className={activityStyles.activity}>
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness={harness}
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
                onClick={() => setRound((value) => value + 1)}
              >
                Refresh
              </Button>
            }
          />
          {rows.length > 0 ? (
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
  return ActivityTab;
}
