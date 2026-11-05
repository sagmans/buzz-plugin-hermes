// The Hermes row of the app's agent settings, and its dialog: whether Hermes is
// installed, its version, whether a gateway answers, and its models. Laid out as
// buzz-app's Goose type lays out its own (src/bundled/goose/tabs.tsx, Apache-2.0,
// see NOTICE), but read-only: Hermes keeps its logins, default model and gateway
// itself, and this plugin neither holds, writes nor starts them.
import { useEffect, useSyncExternalStore } from "react";
import { ProviderDialogActions } from "@app/features/agents/ProviderDialogActions";
import type { AgentProvider } from "@app/features/agents/service";
import { Button } from "@app/shared/design-system/ui/Button";
import type { GatewayState, HermesSetup, HermesStatus } from "./setup";

/** What the row shows when no default model is known. */
const DEFAULT_MODEL_LABEL = "Hermes default";
/** A catalog can list hundreds of models: the dialog scrolls them. As an inline
 * style, as the app's stylesheet has only the classes the app itself uses. */
const MODEL_LIST_STYLE = {
  maxHeight: 240,
  overflow: "auto",
  margin: 0,
} as const;
/** The dialog's words for each gateway state. */
const GATEWAY_LABELS: Readonly<Record<GatewayState, string>> = {
  running: "Running",
  stopped: "No gateway answers",
  unknown: "Not known",
};

/** The default model's name when Hermes lists it, else its id. */
const defaultName = (status: HermesStatus | undefined) =>
  status?.models.find(({ id }) => id === status.defaultModel)?.label ||
  status?.defaultModel ||
  DEFAULT_MODEL_LABEL;

export function createProvider(setup: HermesSetup): AgentProvider {
  /** Follows the check's state, so a new finding shows at once. */
  const useCheck = () =>
    useSyncExternalStore(setup.subscribe, setup.snapshot, setup.snapshot);

  /** Read-only: a button, as the app returns focus to the row's button. */
  function DefaultControl({ onConfigure }: { onConfigure(): void }) {
    useCheck();
    return (
      <Button size="sm" onClick={onConfigure}>
        {defaultName(setup.status())}
      </Button>
    );
  }

  /** What to do about the gateway, for the states that need something. */
  function GatewayHelp({ gateway }: { gateway: GatewayState }) {
    if (gateway === "stopped")
      return (
        <p className="m-0 text-body-sm">
          Hermes agents work through the Hermes gateway. Start it with{" "}
          <code>hermes gateway start</code>. This check does not start it.
        </p>
      );
    if (gateway === "unknown")
      return (
        <p className="m-0 text-body-sm">
          Buzz cannot read the gateway's state, for example when Hermes keeps its
          home in a custom folder. To check it, run{" "}
          <code>hermes gateway status</code>.
        </p>
      );
    return null;
  }

  function DialogBody({ onClose }: { onClose(): void }) {
    const { readiness } = useCheck();
    const status = setup.status();
    const checking = readiness === "checking";
    // The app checks when its settings open; a dialog routed to directly may
    // open with no check started.
    useEffect(() => {
      if (!setup.status()) void setup.check();
    }, []);
    return (
      <div className="grid gap-4">
        {status ? (
          <>
            <p className="m-0 text-body-sm">
              Installed:{" "}
              {status.installed
                ? `Yes${status.version ? `, version ${status.version}` : ""}`
                : "No"}
            </p>
            {status.installed && (
              <p className="m-0 text-body-sm">
                Gateway: {GATEWAY_LABELS[status.gateway]}
              </p>
            )}
            {status.installed && <GatewayHelp gateway={status.gateway} />}
            {status.defaultModel && (
              <p className="m-0 text-body-sm">
                Default model: {defaultName(status)}
              </p>
            )}
            {status.problem && <p role="alert">{status.problem}</p>}
            {status.models.length > 0 && (
              <div className="grid gap-2">
                <p className="m-0 text-body-sm">
                  Models: {status.models.length}
                </p>
                <ul className="text-body-sm" style={MODEL_LIST_STYLE}>
                  {status.models.map(({ id, label }) => (
                    <li key={id}>{label}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p role="status">Checking Hermes…</p>
        )}
        <p className="m-0 text-body-sm text-subtle">
          Hermes keeps its own logins and default model. Change them with{" "}
          <code>hermes setup</code> and Hermes' config.
        </p>
        <ProviderDialogActions>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={checking}
            loading={checking}
            onClick={() => void setup.recheck()}
          >
            Check again
          </Button>
        </ProviderDialogActions>
      </div>
    );
  }

  return {
    snapshot: setup.snapshot,
    subscribe: setup.subscribe,
    check: setup.check,
    DialogBody,
    DefaultControl,
  };
}
