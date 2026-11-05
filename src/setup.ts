// Reads what this computer's Hermes offers, for the create and settings views:
// the models of its ACP model picker. Hermes lists them on a new session, so
// discovery opens one throwaway session with no Buzz tools, in the home folder,
// in its own `hermes acp` process, and stops that process at once.
//
// It also tells the app's provider row and dialog how Hermes stands. `initialize`
// needs no gateway (acp_adapter/gateway_server.py), and gives the version. A new
// session does need one, and Hermes starts a gateway for it when none runs
// (hermes_cli/gateway_client.py, `connect_gateway`), which a look at the settings
// must not do. So the check reads the state file the gateway keeps, with the file
// grant the plugin already holds, and lists models only from a gateway that runs.
import {
  AcpProcess,
  REQUEST_TIMEOUT_MS,
} from "@app/features/agent-harness/acp/process";
import { errorMessage } from "@app/features/agent-harness/acp/steps";
import type {
  AgentProviderSnapshot,
  Models,
} from "@app/features/agents/service";
import { type GooseHost, HERMES, type HermesWire, hermesSpawn } from "./hermes";

/** One model Hermes offers: its exact id, kept whole (`provider:model`). */
export type HermesModel = Readonly<{ id: string; label: string }>;
export type Discovery = Readonly<{
  models: readonly HermesModel[];
  /** The model Hermes' own config picks, when it names one. */
  current?: string;
}>;

/** A bounded list: the picker shows at most this many models. */
const MODELS_LIMIT = 500;
/** The longest model id or label kept; Hermes ids are short. */
const TEXT_LIMIT = 200;
/** What the gateway writes on each housekeeping tick, at Hermes' default home.
 * A custom `HERMES_HOME` is not visible to a plugin, and reads as unknown. */
const GATEWAY_STATE_FILE = "~/.hermes/gateway_state.json";
const GATEWAY_RUNNING = "running";
/** How old that file's stamp may be and still say the gateway lives: the bound
 * Hermes itself uses (gateway/status.py, `_RUNTIME_STATUS_STALE_TTL_S`). */
const GATEWAY_STATE_STALE_MS = 120_000;
/** Hermes' words when a session finds no gateway, which `HermesWire` keeps
 * (hermes_cli/gateway_client.py, `connect_gateway`). */
const NO_GATEWAY_RE = /^Gateway (?:could not start|[a-z_]+:)/;
/** How long a finding stands, as the app checks each time its settings open and
 * each read starts processes. A problem stands for less, so what the owner fixed
 * soon shows. "Check again" always reads anew. */
const READY_TTL_MS = 5 * 60_000;
const ATTENTION_TTL_MS = 15_000;
/** A check stops waiting here: the row stays "Checking…" until it ends, and one
 * hung process must not hold that up. Its process is still stopped. */
const CHECK_WAIT_MS = 30_000;
/** Bounds the process output the dialog can show. */
const PROBLEM_LIMIT = 500;
/** The app's provider row shows these as the action to take. */
const LABEL_INSTALL = "Install Hermes";
const LABEL_GATEWAY = "Start the Hermes gateway";
const LABEL_GATEWAY_UNKNOWN = "Check the Hermes gateway";
const LABEL_CHECK = "Check Hermes setup";
const LABEL_SET_UP = "Set up Hermes";

/** Whether a gateway answers. `unknown`: its state file could not be read. */
export type GatewayState = "running" | "stopped" | "unknown";
/** What a check found. Never holds a key: the check reads none. */
export type HermesStatus = Readonly<{
  /** False only when the system could not find the program. */
  installed: boolean;
  version: string;
  gateway: GatewayState;
  /** The model Hermes' config picks, "" when none is known. */
  defaultModel: string;
  models: readonly HermesModel[];
  /** What to tell the owner, "" when all is well. */
  problem: string;
}>;

/** A check did not finish in time. */
export class SetupCheckError extends Error {
  constructor(
    readonly operation: string,
    readonly waitedMs: number,
  ) {
    super(
      `Hermes did not answer ${operation} within ${waitedMs / 1000} seconds`,
    );
    this.name = "SetupCheckError";
  }
}

/** Hermes opened no session to list models from. */
export class ModelListError extends Error {
  /** The cause's text was Hermes saying that no gateway answers. */
  readonly noGateway: boolean;
  constructor(cause: unknown, hermesSaid: string) {
    super(
      `Hermes could not list its models: ${hermesSaid || errorMessage(cause)}`,
      { cause },
    );
    this.name = "ModelListError";
    this.noGateway = NO_GATEWAY_RE.test(hermesSaid);
  }
}

/** `work`, or a `SetupCheckError` once `CHECK_WAIT_MS` have passed. */
function bounded<T>(operation: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SetupCheckError(operation, CHECK_WAIT_MS)),
      CHECK_WAIT_MS,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(
    0,
    PROBLEM_LIMIT,
  );

/** What the gateway's state file says, at `now`. Reads only two fields: the file
 * also lists the owner's messaging platforms, which are none of this view's
 * business. Any other shape says nothing. */
export function readGatewayState(bytes: Uint8Array, now: number): GatewayState {
  let state: { gateway_state?: unknown; updated_at?: unknown } | null;
  try {
    state = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return "unknown";
  }
  const stamp =
    typeof state?.updated_at === "string" ? Date.parse(state.updated_at) : NaN;
  if (typeof state?.gateway_state !== "string" || Number.isNaN(stamp))
    return "unknown";
  return state.gateway_state === GATEWAY_RUNNING &&
    now - stamp <= GATEWAY_STATE_STALE_MS
    ? "running"
    : "stopped";
}

/** The row's state for a check's findings. */
function readiness(status: HermesStatus): AgentProviderSnapshot {
  if (!status.installed)
    return { readiness: "attention", attentionLabel: LABEL_INSTALL };
  if (status.gateway === "stopped")
    return { readiness: "attention", attentionLabel: LABEL_GATEWAY };
  if (status.gateway === "unknown")
    return { readiness: "attention", attentionLabel: LABEL_GATEWAY_UNKNOWN };
  if (status.problem)
    return { readiness: "attention", attentionLabel: LABEL_CHECK };
  if (!status.models.length)
    return { readiness: "attention", attentionLabel: LABEL_SET_UP };
  return { readiness: "ready" };
}

/** Reads `session/new`'s model state (ACP `SessionModelState`). Bad entries
 * are dropped, not trusted. */
export function readModels(result: unknown): Discovery {
  const state = (result as { models?: unknown } | null)?.models as
    | { availableModels?: unknown; currentModelId?: unknown }
    | undefined;
  const list = Array.isArray(state?.availableModels)
    ? state.availableModels
    : [];
  const models: HermesModel[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const { modelId, name } = (entry ?? {}) as {
      modelId?: unknown;
      name?: unknown;
    };
    if (typeof modelId !== "string" || !modelId.trim()) continue;
    const id = modelId.trim().slice(0, TEXT_LIMIT);
    if (seen.has(id)) continue;
    seen.add(id);
    const label =
      typeof name === "string" && name.trim()
        ? name.trim().slice(0, TEXT_LIMIT)
        : id;
    models.push({ id, label });
    if (models.length >= MODELS_LIMIT) break;
  }
  const current =
    typeof state?.currentModelId === "string" && state.currentModelId.trim()
      ? state.currentModelId.trim().slice(0, TEXT_LIMIT)
      : undefined;
  return { models, ...(current ? { current } : {}) };
}

/** Model discovery, shared by every view, once per app start unless asked
 * again. */
export class HermesSetup {
  private discovery: Promise<Discovery> | undefined;
  /** The latest models read, which proves that a gateway answered then. */
  private discovered: Discovery | undefined;
  private state: AgentProviderSnapshot = { readiness: "checking" };
  private found: HermesStatus | undefined;
  private checkedAt = 0;
  private checking: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly host:
      | (GooseHost & Readonly<{ readFile(path: string): Promise<Uint8Array> }>)
      | undefined,
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** What the latest check found; undefined until one has ended. */
  status = () => this.found;
  /** A check, unless a recent finding still stands. Never rejects: the app reads
   * the outcome from the snapshot. It changes nothing in Hermes' setup. */
  check = (): Promise<void> => {
    const standing =
      this.state.readiness === "ready" ? READY_TTL_MS : ATTENTION_TTL_MS;
    return this.found && Date.now() - this.checkedAt < standing
      ? Promise.resolve()
      : this.recheck();
  };
  /** A check that reads anew, so an install or a gateway started since shows. */
  recheck = (): Promise<void> => {
    if (this.checking) return this.checking;
    this.update({ readiness: "checking" });
    this.checking = this.probe()
      .then((status) => {
        this.found = status;
        this.checkedAt = Date.now();
        this.update(readiness(status));
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  };

  private update(state: AgentProviderSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private async probe(): Promise<HermesStatus> {
    const started = Date.now();
    const none = { version: "", defaultModel: "", models: [], problem: "" };
    let version = "";
    try {
      version = await bounded("`hermes acp`", this.readVersion());
    } catch (error) {
      const problem = reason(error);
      return {
        ...none,
        installed: problem !== HERMES.missing,
        gateway: "unknown",
        problem,
      };
    }
    const gateway = await this.gateway();
    const installed = { ...none, installed: true, version };
    // No session unless a gateway runs: Hermes would start one for it. Models
    // already read prove that this computer's gateway answers even when its
    // state file is not at the default home.
    if (gateway === "stopped") return { ...installed, gateway };
    if (gateway === "unknown" && !this.discovered)
      return { ...installed, gateway };
    try {
      const { models, current } = await bounded(
        "`session/new`",
        gateway === "running" ? this.models(true) : this.models(),
      );
      return {
        ...installed,
        gateway: "running",
        models,
        defaultModel: current ?? "",
      };
    } catch (error) {
      // The text can hold Hermes' output: the dialog shows it to the owner, and
      // the log does not keep it.
      console.warn("Hermes' setup check found a problem", {
        operation: "provider check",
        gateway,
        elapsedMs: Date.now() - started,
      });
      return {
        ...installed,
        gateway:
          error instanceof ModelListError && error.noGateway
            ? "stopped"
            : gateway,
        problem: reason(error),
      };
    }
  }

  /** The version `hermes acp` reports at `initialize`, which needs no gateway. */
  private async readVersion(): Promise<string> {
    const { host } = this;
    if (!host) throw new Error("Hermes agents run only in the desktop app.");
    let wire: HermesWire | undefined;
    const hermes = await AcpProcess.start(
      hermesSpawn(host.spawn, (made) => {
        wire = made;
      }),
      HERMES,
      { cwd: await host.resolveDirectory("~") },
    );
    await hermes.kill();
    return (wire as HermesWire | undefined)?.version ?? "";
  }

  /** The gateway's state, from its file. A file not there is `unknown`: Hermes may
   * keep its home elsewhere. */
  private async gateway(): Promise<GatewayState> {
    try {
      const bytes = await bounded(
        "reading the gateway's state",
        this.host?.readFile(GATEWAY_STATE_FILE) ??
          Promise.reject(new Error("no host")),
      );
      return readGatewayState(bytes, Date.now());
    } catch {
      return "unknown";
    }
  }

  /** The models, read once; `again` reads them anew, after a Hermes setup
   * change. Rejects with a readable error. */
  models(again = false): Promise<Discovery> {
    if (again || !this.discovery) {
      const discovery = this.discover();
      this.discovery = discovery;
      void discovery.then(
        (found) => {
          this.discovered = found;
        },
        // A failed read is tried again next time.
        () => {
          if (this.discovery === discovery) this.discovery = undefined;
          this.discovered = undefined;
        },
      );
    }
    return this.discovery;
  }

  /** What an owner can pick for one message of an agent on `model`: the same
   * list the views show, and the model it runs on without a pick. Hermes has
   * no thinking levels in ACP, so no model offers any. A throw shows no
   * picker, which the app handles. */
  async picks({ model }: Readonly<{ model: string }>): Promise<Models> {
    const { models, current } = await this.models();
    const running = model.trim() || current || "";
    // A model Hermes does not list is still the one the agent runs on.
    const named =
      !running || models.some(({ id }) => id === running)
        ? models
        : [{ id: running, label: running }, ...models];
    return {
      current: running,
      models: named.map(({ id, label }) => ({ id, label, efforts: [] })),
    };
  }

  private async discover(): Promise<Discovery> {
    const { host } = this;
    if (!host) throw new Error("Hermes agents run only in the desktop app.");
    const cwd = await host.resolveDirectory("~");
    let wire: HermesWire | undefined;
    const hermes = await AcpProcess.start(
      hermesSpawn(host.spawn, (made) => {
        wire = made;
      }),
      HERMES,
      { cwd },
    );
    try {
      const opened = await hermes.request(
        "session/new",
        { cwd, mcpServers: [] },
        REQUEST_TIMEOUT_MS,
      );
      return readModels(opened);
    } catch (error) {
      throw new ModelListError(
        error,
        (wire as HermesWire | undefined)?.openError ?? "",
      );
    } finally {
      hermes.kill();
    }
  }
}
