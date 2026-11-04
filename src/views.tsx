// The Hermes agent type's parts of the app's screens: the New agent dialog
// and the Settings tab. They are built from the app's own components
// (ModelPicker, AgentInstructions, the design system), bundled unchanged from
// the pinned buzz-app clone, and laid out as buzz-app's Goose type lays out
// its own (src/bundled/goose/tabs.tsx), so a Hermes agent looks like the
// app's own agents. `src/react-host.ts` makes them render with Buzz's React.
import { useEffect, useId, useRef, useState } from "react";
import {
  type Config,
  config as readConfig,
  DEFAULT_CONFIG,
} from "@app/bundled/goose/runtime";
import { AgentInstructions } from "@app/features/agents/AgentInstructions";
import { AgentSaveButton } from "@app/features/agents/AgentSaveButton";
import { ModelDiscoveryRecovery } from "@app/features/agents/ModelDiscoveryRecovery";
import {
  type ModelChoice,
  ModelPicker,
} from "@app/features/agents/ModelPicker";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "@app/features/agents/service";
import { HermesLogoIcon } from "@app/shared/design-system/icons";
import { Field } from "@app/shared/design-system/ui/Field";
import { Input } from "@app/shared/design-system/ui/Input";
import { Select } from "@app/shared/design-system/ui/Select";
import { SettingsGroup } from "@app/shared/design-system/ui/SettingsGroup";
import { PanelSaveFooter } from "./save-footer";
import type { Discovery, HermesSetup } from "./setup";

/** The empty model choice: Hermes' own config picks the model. */
const DEFAULT_MODEL_LABEL = "Hermes default";
const RESET_LABEL = "Use Hermes default";
const CREATE_MODEL_LABEL = "Hermes model";
/** The harness mark beside the model on a library card, as Goose sizes it. */
const CARD_ICON_SIZE = 18;
/** A workspace is an absolute path or one in the home folder. */
const WORKSPACE_RE = /^(\/|~\/|~$)/;
const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One session per thread" },
      { value: "channel", label: "One session per channel" },
    ],
  },
];
const WORKSPACE_HELP =
  "The folder Hermes works in. Use ~/ for your home folder.";
const WORKSPACE_ERROR = "Enter an absolute or ~/… workspace path.";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** A workspace to save, or an error for one Hermes cannot work in. */
export function workspaceOf(value: string): string {
  const workspace = value.trim() || DEFAULT_CONFIG.workspace;
  if (!WORKSPACE_RE.test(workspace)) throw new Error(WORKSPACE_ERROR);
  return workspace;
}

/** The model Hermes' config picks, so the default choice shows that
 * model's name and mark, as the app's Goose type shows its provider's. */
const defaultModel = (discovery: Discovery | undefined) =>
  discovery?.current ? { defaultModel: discovery.current } : {};

type Read =
  | { status: "loading"; value?: Discovery }
  | { status: "ready"; value: Discovery }
  | { status: "error"; error: string; value?: Discovery };

export function createViews(setup: HermesSetup) {
  /** Hermes' models as the picker lists them, read on first use; `retry`
   * reads them anew, after a Hermes setup change. A shown list stays while
   * it is read again. (As buzz-app's Goose tabs read goose's lists.) */
  function useChoices() {
    const [list, setList] = useState<Read>({ status: "loading" });
    const [round, setRound] = useState(0);
    useEffect(() => {
      let live = true;
      const kept = (prior: Read) =>
        prior.value === undefined ? {} : { value: prior.value };
      setList((prior) => ({ status: "loading", ...kept(prior) }));
      setup.models(round > 0).then(
        (value) => live && setList({ status: "ready", value }),
        (reason: unknown) =>
          live &&
          setList((prior) => ({
            status: "error",
            error: message(reason),
            ...kept(prior),
          })),
      );
      return () => {
        live = false;
      };
    }, [round]);
    const choices: ModelChoice[] = (list.value?.models ?? []).map(
      ({ id, label }) => ({ id, label }),
    );
    return { list, retry: () => setRound((value) => value + 1), choices };
  }

  /** The instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    return (
      <AgentInstructions
        creation
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...current, instructions })}
      />
    );
  }

  /** The model row of the New agent dialog and of a library card. */
  function CreateModel({
    config,
    onChange,
    disabled,
    modelAppearance,
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const { list, retry, choices } = useChoices();
    return (
      <ModelDiscoveryRecovery
        error={list.status === "error" ? list.error : undefined}
        loading={list.status === "loading"}
        retry={retry}
        disabled={disabled}
      >
        <ModelPicker
          compact
          groupByFamily
          includeDefault={false}
          resetLabel={RESET_LABEL}
          label={CREATE_MODEL_LABEL}
          appearance={modelAppearance ?? "outlined"}
          // A card names its harness before the model, as Goose's does.
          {...(modelAppearance && {
            leading: <HermesLogoIcon size={CARD_ICON_SIZE} />,
          })}
          models={choices}
          value={current.model}
          defaultLabel={DEFAULT_MODEL_LABEL}
          {...defaultModel(list.value)}
          disabled={disabled}
          loading={list.status === "loading"}
          onChange={(model) => onChange({ ...current, model })}
        />
      </ModelDiscoveryRecovery>
    );
  }

  /** The model row of the Settings tab. A saved model that Hermes no longer
   * lists stays shown, to keep or change. */
  function ModelField({
    value,
    onChange,
  }: Readonly<{ value: string; onChange(model: string): void }>) {
    const { list, choices } = useChoices();
    return (
      <ModelPicker
        groupByFamily
        label="Model"
        models={choices}
        loading={list.status === "loading"}
        value={value}
        defaultLabel={DEFAULT_MODEL_LABEL}
        {...defaultModel(list.value)}
        {...(list.status === "error"
          ? { description: `Could not list models: ${list.error}` }
          : {})}
        onChange={onChange}
      />
    );
  }

  /** Where and how a Hermes agent works: the Settings tab's runtime part. */
  function RuntimeFields({
    draft,
    setDraft,
  }: Readonly<{ draft: Config; setDraft(config: Config): void }>) {
    return (
      <>
        <Field label="Workspace" description={WORKSPACE_HELP}>
          <Input
            value={draft.workspace}
            onValueChange={(workspace) => setDraft({ ...draft, workspace })}
          />
        </Field>
        <Select
          label="Sessions"
          variant="preference"
          value={draft.scope}
          groups={SCOPES}
          onValueChange={(value) =>
            setDraft({
              ...draft,
              scope: value === "channel" ? "channel" : "thread",
            })
          }
        />
      </>
    );
  }

  /** Every setting of a Hermes agent, saved together. */
  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsSection,
    settingsContent,
  }: AgentViewProps<Config>) {
    const form = useId();
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
          // Hermes ids carry their provider; these stay Hermes' own.
          provider: "",
          effort: "",
          model: draft.model.trim(),
          workspace: workspaceOf(draft.workspace),
        });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    return (
      <PanelSaveFooter form={form}>
        <form
          id={form}
          className="grid gap-4 [container-type:inline-size]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && (
            <p
              ref={saveErrorRef}
              tabIndex={-1}
              role="alert"
              className="buzz-field-error"
            >
              {error}
            </p>
          )}
          {settingsSection !== "runtime" && (
            <>
              <SettingsGroup>
                {settingsHost?.typeControl?.(configChanged)}
                <ModelField
                  value={draft.model}
                  onChange={(model) => setDraft({ ...draft, model })}
                />
              </SettingsGroup>
              <AgentInstructions
                value={draft.instructions}
                disabled={false}
                onChange={(instructions) =>
                  setDraft({ ...draft, instructions })
                }
              />
            </>
          )}
          {settingsSection !== "identity" && (
            <RuntimeFields draft={draft} setDraft={setDraft} />
          )}
          <AgentSaveButton form={form} saving={saving} disabled={!changed} />
          {settingsSection !== "identity" && settingsContent}
        </form>
      </PanelSaveFooter>
    );
  }

  return { Create, CreateModel, SettingsTab };
}
