// Hermes agents: an agent type whose agents are Hermes Agent on this computer,
// all in one `hermes acp` process. Each conversation an agent is in is one
// ACP session in it; Hermes answers with the Buzz tools that the app serves to
// it over loopback HTTP MCP, signed by the agent's key that the app keeps.
// The turn logic is buzz-app's Goose runtime, and `gooseRun` is how the native
// Goose type runs on it (turns, session controls, synced settings, resume),
// bundled unchanged; the build swaps its process adapter for `./hermes`
// (scripts/build-plugin.mjs).
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentType } from "@app/features/agents/service";
import {
  type Config,
  config,
  DEFAULT_CONFIG,
  GooseRuntime,
} from "@app/bundled/goose/runtime";
import { gooseRun } from "@app/bundled/goose/run";
import { repositoriesContext } from "@app/features/communities/repositories";
import { HermesLogoIcon } from "@app/shared/design-system/icons";
import { createActivity } from "./activity";
import { createProvider } from "./provider";
import { LABEL, recordWith, startReader } from "./hermes";
import { RecordedHistory } from "./history";
import { bindReact } from "./react-host";
import { ActivityRecorder } from "./recorder";
import { ActivitySessions, HarnessReader, SessionLog } from "./session-read";
import { HermesSetup } from "./setup";
import { recordedSpawn } from "./steer-record";
import { createViews } from "./views";

/** The agent type id. Saved agents match on it: never change it. */
export const TYPE_ID = "hermes";
/** The runtime name in shared and exported agents. */
const SHARED_RUNTIME = "hermes";
/** The manifest id, when the host does not say it. */
const PLUGIN_ID = "sagmans.hermes";
/** The host serves the Buzz tools to Hermes in one MCP session that every
 * client given the token joins (`sharedMcpHost`). */
const SHARED_MCP = { sharedSession: true } as const;
const NO_MCP = "This host serves no MCP";
/** The agent storage key of an agent's activity record, before its agent key.
 * A new shape needs a new version suffix: saved records read this one. */
const ACTIVITY_PREFIX = "sagmans.hermes.activity.v1:";
/** The local storage key of the sessions each agent ran. Saved logs read this
 * one, so sessions from before the record still show. */
const HISTORY_KEY = "sagmans.hermes.history.v1";
/** No discovery of sessions the log does not name: Hermes' `session/load` moves a
 * session whose cwd differs (acp_adapter/gateway_server.py, `_resume`), and its
 * `session/list` does not name the sessions the gateway runs. */
const DISCOVERS_SESSIONS = false;
/** Why the app stops a protected agent of this type. The app stops it anyway, as
 * the type does not claim `protection`, but its stock words point at no cause.
 * See README, "Limits", for the sources. */
const PROTECTION_UNAVAILABLE =
  "Hermes runs tools in its gateway, outside the process Buzz starts, so Buzz cannot enforce a protection policy on them.";

export const inject = ["react", "agents", "host"];

export function apply(ctx: Context) {
  const { agents, host, react } = ctx;
  // First: the bundled app components render with Buzz's React only.
  bindReact(react);
  // Only the desktop app can start `hermes acp`, serve MCP to it and read the
  // files its tools attach; no unusable type elsewhere.
  if (!host.spawn || !host.resolveDirectory || !host.readFile || !host.serveMcp)
    return;
  const typeKey = `${ctx.pluginOwner?.id ?? PLUGIN_ID}/${TYPE_ID}`;
  const recorder = new ActivityRecorder(agents.storage, ACTIVITY_PREFIX);
  recordWith((spawn) => recordedSpawn(recorder, spawn));
  const runtime = new GooseRuntime(
    sharedMcpHost(host),
    (key) => agents.relay(key),
    (key, signal) => agents.core(key, signal),
    globalThis.localStorage,
    () => agents.tools(),
    // The community's repositories folder, as the native Goose type passes
    // it: this module only reads the app's local storage.
    repositoriesContext,
    agents.storage,
  );
  const setup = new HermesSetup({
    spawn: host.spawn.bind(host),
    resolveDirectory: host.resolveDirectory.bind(host),
    readFile: host.readFile.bind(host),
  });
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(
      snapshot.running.filter((agent: Agent) => agent.type === typeKey),
    );
  };
  const unsubscribe = agents.subscribe(sync);
  sync();
  const log = new SessionLog(globalThis.localStorage, HISTORY_KEY);
  const stopLog = runtime.subscribe(() => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    for (const agent of snapshot.running)
      if ((agent as Agent).type === typeKey)
        log.record(
          (agent as Agent).key,
          runtime,
          config((agent as Agent).config).workspace,
        );
  });
  ctx.effect(() => () => {
    unsubscribe();
    stopLog();
    runtime.dispose();
    recordWith(undefined);
    void recorder.flush();
  });

  const history = new RecordedHistory(recorder);
  const sessions = new ActivitySessions(
    history,
    log,
    new HarnessReader(
      {
        spawn: host.spawn.bind(host),
        resolveDirectory: host.resolveDirectory.bind(host),
      },
      startReader,
    ),
    DISCOVERS_SESSIONS,
  );
  const { ActivityTab } = createActivity({
    runtime,
    history,
    recorder,
    sessions,
  });
  agents.register<Config>(hermesType(runtime, setup, ActivityTab, history));
}

/** The host the runtime serves Buzz tools through, with every MCP server in
 * a shared session.
 *
 * Why: the app's host lets one MCP client hold a server's token and stops
 * the server at a second `initialize`. The Hermes gateway (0.22.1) connects
 * at `session/new` to freeze the tool list, disconnects when no client views
 * the session yet, and connects again for each turn. So a second `initialize`
 * always comes, and without a shared session the first turn fails with
 * "another program used their token". Hermes keeps the server's address and
 * token only in memory: its durable session state holds a fingerprint and
 * the tool schemas (gateway/session_local_mcp.py). The token stays loopback
 * only, per session, and stops with the session. */
function sharedMcpHost(host: Context["host"]): Context["host"] {
  const serveMcp: NonNullable<Context["host"]["serveMcp"]> = (handler) =>
    host.serveMcp?.(handler, SHARED_MCP) ?? Promise.reject(new Error(NO_MCP));
  return Object.create(host, { serveMcp: { value: serveMcp } });
}

/** The Hermes agent type, on `runtime`, whose views and picks read `setup`. */
function hermesType(
  runtime: GooseRuntime,
  setup: HermesSetup,
  ActivityTab: ReturnType<typeof createActivity>["ActivityTab"],
  history: RecordedHistory,
): AgentType<Config> {
  const { Create, CreateModel, SettingsTab } = createViews(setup);
  return {
    id: TYPE_ID,
    title: LABEL,
    // The app's own Hermes mark, as its type menus and cards show it.
    icon: HermesLogoIcon,
    description:
      "Hermes Agent on this computer, with the provider and model Hermes is set up with. Each thread it is mentioned in is one continuing conversation.",
    protectionUnavailable: PROTECTION_UNAVAILABLE,
    defaults: () => ({ config: DEFAULT_CONFIG }),
    Create,
    CreateModel,
    importShared: (source) =>
      source.runtime === SHARED_RUNTIME
        ? { ...DEFAULT_CONFIG, model: source.model }
        : undefined,
    exportShared: (saved) => ({
      runtime: SHARED_RUNTIME,
      model: config(saved).model,
    }),
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      workspace: carry.workspace ?? saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
      };
    },
    summary: (agent) => config(agent.config).model || LABEL,
    sessions: {
      // The same list the bundled Goose type shows: saved conversations,
      // newest first, with the open ones' state.
      list: (key) => sessionsList(runtime, key),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: SettingsTab,
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: ActivityTab,
      },
    ],
    provider: createProvider(setup),
    // No cost: Hermes reports none over ACP (its `usage_update` has only the
    // context size), and this plugin invents none.
    usage: (agent, options) => history.usage(agent.key, options),
    // Per-message picks, as the native type offers them.
    models: (agent) => setup.picks(config(agent.config)),
    ...gooseRun(runtime),
  };
}

/** The same list the bundled Goose type shows: saved conversations, newest
 * first, with the open ones' state. */
function sessionsList(runtime: GooseRuntime, key: string) {
  const live = runtime.sessions(key);
  const busy = new Map(live.map((view) => [view.key, view.busy]));
  const used = new Map(
    runtime.conversations(key).map(({ key, at }) => [key, at]),
  );
  // Open ones are listed even when saving them failed. A one-off turn
  // joins no conversation.
  for (const { key, at } of live) if (at !== undefined) used.set(key, at);
  return [...used]
    .sort(([, a], [, b]) => b - a)
    .map(([key, at]) => {
      const [channelId = key, root] = key.split("/");
      const working = busy.get(key);
      return {
        channelId,
        ...(root && { root }),
        at,
        ...(working !== undefined && {
          status: working ? "Working" : "Idle",
        }),
      };
    });
}
