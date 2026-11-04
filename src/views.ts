// The Hermes agent type's views: the model and instructions fields of the New
// agent dialog, and the Settings tab. They use the app's React through
// `ctx.react` (an installed plugin must not bundle its own copy) and plain
// elements with the app's shared class names, because the app's design-system
// components are not part of the public plugin API.
import type * as ReactTypes from "react";
import {
  type Config,
  config,
  DEFAULT_CONFIG,
} from "@app/bundled/goose/runtime";
import type { Discovery, HermesSetup } from "./setup";

/** Where the default model goes in the picker: an empty model id. */
const DEFAULT_MODEL_VALUE = "";
/** A workspace is an absolute path or one in the home folder. */
const WORKSPACE_RE = /^(\/|~\/|~$)/;
const SCOPES = [
  { value: "thread", label: "One session per thread" },
  { value: "channel", label: "One session per channel" },
] as const;

type CreateProps = Readonly<{
  config: Config;
  onChange(config: Config): void;
  disabled: boolean;
}>;
type SettingsProps = Readonly<{
  agent: Readonly<{ config: unknown }>;
  save(config: Config): Promise<void>;
  settingsSection?: "identity" | "runtime";
}>;

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** A workspace to save, or an error for one Hermes cannot work in. */
export function workspaceOf(value: string): string {
  const workspace = value.trim() || DEFAULT_CONFIG.workspace;
  if (!WORKSPACE_RE.test(workspace))
    throw new Error("Enter an absolute or ~/… workspace path.");
  return workspace;
}

export function createViews(React: typeof ReactTypes, setup: HermesSetup) {
  const h = React.createElement;
  const { useEffect, useId, useState } = React;

  /** The models, read on first use; a failed read shows its error and a
   * retry. */
  function useModels() {
    const [state, setState] = useState<{
      discovery?: Discovery;
      error?: string;
      loading: boolean;
    }>({ loading: true });
    const load = (again: boolean) => {
      setState(({ discovery }) => ({
        ...(discovery ? { discovery } : {}),
        loading: true,
      }));
      setup.models(again).then(
        (discovery) => setState({ discovery, loading: false }),
        (reason) => setState({ error: message(reason), loading: false }),
      );
    };
    useEffect(() => load(false), []);
    return { ...state, reload: () => load(true) };
  }

  function ModelField(
    props: Readonly<{
      value: string;
      onChange(model: string): void;
      disabled: boolean;
    }>,
  ) {
    const id = useId();
    const { discovery, error, loading, reload } = useModels();
    const models = discovery?.models ?? [];
    const known = models.some((model) => model.id === props.value);
    const fallback = discovery?.current
      ? `Hermes default (${discovery.current})`
      : "Hermes default";
    return h(
      "div",
      { className: "grid gap-2" },
      h("label", { htmlFor: id, className: "text-label-sm" }, "Model"),
      h(
        "select",
        {
          id,
          value: props.value,
          disabled: props.disabled,
          onChange: (event: ReactTypes.ChangeEvent<HTMLSelectElement>) =>
            props.onChange(event.target.value),
        },
        h("option", { value: DEFAULT_MODEL_VALUE }, fallback),
        // A saved model Hermes no longer lists stays visible, to keep or change.
        props.value && !known
          ? h("option", { value: props.value }, `${props.value} (not listed)`)
          : null,
        ...models.map((model) =>
          h(
            "option",
            { key: model.id, value: model.id },
            model.label === model.id
              ? model.id
              : `${model.label} · ${model.id}`,
          ),
        ),
      ),
      loading
        ? h(
            "p",
            { className: "m-0 text-body-sm text-secondary" },
            "Reading Hermes models…",
          )
        : null,
      error
        ? h(
            "div",
            { className: "flex items-center gap-2" },
            h(
              "p",
              { role: "alert", className: "m-0 text-body-sm text-danger" },
              error,
            ),
            h("button", { type: "button", onClick: reload }, "Try again"),
          )
        : null,
    );
  }

  function InstructionsField(
    props: Readonly<{
      value: string;
      onChange(value: string): void;
      disabled: boolean;
    }>,
  ) {
    const id = useId();
    return h(
      "div",
      { className: "grid gap-2" },
      h("label", { htmlFor: id, className: "text-label-sm" }, "Instructions"),
      h("textarea", {
        id,
        rows: 6,
        value: props.value,
        disabled: props.disabled,
        onChange: (event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) =>
          props.onChange(event.target.value),
      }),
    );
  }

  function Create({ config: raw, onChange, disabled }: CreateProps) {
    const value = config(raw);
    return h(
      "div",
      { className: "grid gap-4" },
      h(ModelField, {
        value: value.model,
        disabled,
        onChange: (model: string) => onChange({ ...value, model }),
      }),
      h(InstructionsField, {
        value: value.instructions,
        disabled,
        onChange: (instructions: string) =>
          onChange({ ...value, instructions }),
      }),
    );
  }

  function CreateModel({ config: raw, onChange, disabled }: CreateProps) {
    const value = config(raw);
    return h(ModelField, {
      value: value.model,
      disabled,
      onChange: (model: string) => onChange({ ...value, model }),
    });
  }

  function SettingsTab({ agent, save, settingsSection }: SettingsProps) {
    const form = useId();
    const saved = config(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const changed = JSON.stringify(draft) !== JSON.stringify(saved);
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
    const identity = settingsSection !== "runtime";
    const runtime = settingsSection !== "identity";
    return h(
      "form",
      {
        id: form,
        className: "grid gap-4 [container-type:inline-size]",
        onSubmit: (event: ReactTypes.FormEvent) => {
          event.preventDefault();
          void submit();
        },
      },
      error
        ? h("p", { role: "alert", className: "buzz-field-error" }, error)
        : null,
      identity
        ? h(ModelField, {
            value: draft.model,
            disabled: saving,
            onChange: (model: string) => setDraft({ ...draft, model }),
          })
        : null,
      identity
        ? h(InstructionsField, {
            value: draft.instructions,
            disabled: saving,
            onChange: (instructions: string) =>
              setDraft({ ...draft, instructions }),
          })
        : null,
      runtime ? h(WorkspaceField, { draft, setDraft, disabled: saving }) : null,
      runtime ? h(ScopeField, { draft, setDraft, disabled: saving }) : null,
      h(
        "div",
        { className: "flex items-center gap-2" },
        h(
          "button",
          { type: "submit", disabled: saving || !changed },
          saving ? "Saving…" : "Save",
        ),
      ),
    );
  }

  type DraftProps = Readonly<{
    draft: Config;
    setDraft(config: Config): void;
    disabled: boolean;
  }>;

  function WorkspaceField({ draft, setDraft, disabled }: DraftProps) {
    const id = useId();
    return h(
      "div",
      { className: "grid gap-2" },
      h("label", { htmlFor: id, className: "text-label-sm" }, "Workspace"),
      h("input", {
        id,
        value: draft.workspace,
        disabled,
        onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
          setDraft({ ...draft, workspace: event.target.value }),
      }),
      h(
        "p",
        { className: "m-0 text-body-sm text-secondary" },
        "The folder Hermes works in. Use ~/ for your home folder.",
      ),
    );
  }

  function ScopeField({ draft, setDraft, disabled }: DraftProps) {
    const id = useId();
    return h(
      "div",
      { className: "grid gap-2" },
      h("label", { htmlFor: id, className: "text-label-sm" }, "Sessions"),
      h(
        "select",
        {
          id,
          value: draft.scope,
          disabled,
          onChange: (event: ReactTypes.ChangeEvent<HTMLSelectElement>) =>
            setDraft({
              ...draft,
              scope: event.target.value === "channel" ? "channel" : "thread",
            }),
        },
        ...SCOPES.map((scope) =>
          h("option", { key: scope.value, value: scope.value }, scope.label),
        ),
      ),
    );
  }

  return { Create, CreateModel, SettingsTab };
}
