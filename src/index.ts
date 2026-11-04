// Hermes agents: an agent type whose agents are Hermes Agent on this computer,
// all in one `hermes acp` process. Each conversation an agent is in is one
// ACP session in it; Hermes answers with the Buzz tools that the app serves to
// it over loopback HTTP MCP, signed by the agent's key that the app keeps.
// The turn logic is buzz-app's Goose runtime, bundled unchanged; the build
// swaps its process adapter for `./hermes` (scripts/build-plugin.mjs).
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentType } from "@app/features/agents/service";
import {
  type Config,
  config,
  DEFAULT_CONFIG,
  GooseRuntime,
} from "@app/bundled/goose/runtime";
import { LABEL } from "./hermes";
import { HermesSetup } from "./setup";
import { createViews } from "./views";

/** The agent type id. Saved agents match on it: never change it. */
export const TYPE_ID = "hermes";
/** The runtime name in shared and exported agents. */
const SHARED_RUNTIME = "hermes";
/** The manifest id, when the host does not say it. */
const PLUGIN_ID = "sagmans.hermes";
/** A turn's run returns once Hermes has it, so this bounds only the
 * hand-over, which includes the first `hermes acp` start. */
const HANDOVER_MS = 2 * 60_000;

export const inject = ["react", "agents", "host"];

export function apply(ctx: Context) {
  const { agents, host, react } = ctx;
  // Only the desktop app can start `hermes acp`, serve MCP to it and read the
  // files its tools attach; no unusable type elsewhere.
  if (!host.spawn || !host.resolveDirectory || !host.readFile || !host.serveMcp)
    return;
  const typeKey = `${ctx.pluginOwner?.id ?? PLUGIN_ID}/${TYPE_ID}`;
  const runtime = new GooseRuntime(
    host,
    (key) => agents.relay(key),
    (key, signal) => agents.core(key, signal),
    globalThis.localStorage,
    () => agents.tools(),
    // Desktop's repository instructions are an app module, not plugin API.
    () => "",
    agents.storage,
  );
  const setup = new HermesSetup({
    spawn: host.spawn.bind(host),
    resolveDirectory: host.resolveDirectory.bind(host),
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
  ctx.effect(() => () => {
    unsubscribe();
    runtime.dispose();
  });

  agents.register<Config>(hermesType(runtime, createViews(react, setup)));
}

type Views = ReturnType<typeof createViews>;

/** The Hermes agent type, on `runtime` and with `views`. */
function hermesType(
  runtime: GooseRuntime,
  { Create, CreateModel, SettingsTab }: Views,
): AgentType<Config> {
  return {
    id: TYPE_ID,
    title: LABEL,
    description:
      "Hermes Agent on this computer, with the provider and model Hermes is set up with. Each thread it is mentioned in is one continuing conversation.",
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
    ],
    sessionControls: {
      scope: (agent) => config(agent.config).scope,
      state: (agent, place) => runtime.sessionState(agent, place),
      run: (agent, place, action) => runtime.session(agent, place, action),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    timeoutMs: HANDOVER_MS,
    // Closing or reloading the app stops its turns; each resumed one carries
    // on in a new session shown what it already did in the conversation.
    resumes: true,
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
