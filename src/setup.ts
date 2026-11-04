// Reads what this computer's Hermes offers, for the create and settings views:
// the models of its ACP model picker. Hermes lists them on a new session, so
// discovery opens one throwaway session with no Buzz tools, in the home folder,
// in its own `hermes acp` process, and stops that process at once.
import {
  AcpProcess,
  REQUEST_TIMEOUT_MS,
} from "@app/features/agent-harness/acp/process";
import { errorMessage } from "@app/features/agent-harness/acp/steps";
import { HERMES, hermesSpawn, type GooseHost } from "./hermes";

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
  constructor(private readonly host: GooseHost | undefined) {}

  /** The models, read once; `again` reads them anew, after a Hermes setup
   * change. Rejects with a readable error. */
  models(again = false): Promise<Discovery> {
    if (again || !this.discovery) {
      const discovery = this.discover();
      this.discovery = discovery;
      // A failed read is tried again next time.
      void discovery.catch(() => {
        if (this.discovery === discovery) this.discovery = undefined;
      });
    }
    return this.discovery;
  }

  private async discover(): Promise<Discovery> {
    const { host } = this;
    if (!host) throw new Error("Hermes agents run only in the desktop app.");
    const cwd = await host.resolveDirectory("~");
    const hermes = await AcpProcess.start(hermesSpawn(host.spawn), HERMES, {
      cwd,
    });
    try {
      const opened = await hermes.request(
        "session/new",
        { cwd, mcpServers: [] },
        REQUEST_TIMEOUT_MS,
      );
      return readModels(opened);
    } catch (error) {
      throw new Error(
        `Hermes could not list its models: ${errorMessage(error)}`,
      );
    } finally {
      hermes.kill();
    }
  }
}
