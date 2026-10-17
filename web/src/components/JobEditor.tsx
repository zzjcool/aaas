import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, errorMessage, http } from "../api.ts";
import { formatRelativeFuture, formatTime, formatZoneLabel, LOCAL_TIMEZONE } from "../format.ts";
import { useDebounced } from "../hooks/usePolling.ts";
import type {
  AgentConfig,
  AgentInfo,
  CronPreviewRequest,
  CronPreviewResponse,
  FieldOptionSource,
  FieldSchema,
  JobSpec,
  JobView,
  TriggerConfig,
  TriggerInfo,
} from "../types.ts";
import { CronFieldEditor } from "./CronFieldEditor.tsx";
import { Field, initialValueFor, type FieldValue } from "./Field.tsx";
import { OptionControl, useAgentOptions } from "./OptionControl.tsx";
import { TimezoneField } from "./TimezoneField.tsx";
import { Modal } from "./Modal.tsx";

/**
 * The `/api/schedule/preview` endpoint accepts these keys (contract §5). They are
 * the only field names this file knows about; everything else comes from the
 * plugin descriptor, so adding a trigger plugin needs no UI change.
 */
const PREVIEW_KEYS = ["cron", "every", "timezone"] as const;
type PreviewKey = (typeof PREVIEW_KEYS)[number];

/** Seed for a required, empty cron field in create mode: every day at 09:00. */
const DEFAULT_CRON = "0 9 * * *";

const PREVIEW_DEBOUNCE_MS = 400;
const PREVIEW_COUNT = 5;

export interface JobEditorProps {
  /** `null` opens the editor in create mode. */
  job: JobView | null;
  triggers: TriggerInfo[];
  agents: AgentInfo[];
  defaultTimezone: string;
  onClose: () => void;
  onSaved: (job: JobView) => void;
  onDeleted: (id: string) => void;
  notify: (tone: "success" | "warn" | "danger" | "info", message: string, detail?: string) => void;
}

interface FormState {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  triggerType: string;
  triggerConfig: Record<string, FieldValue>;
  /** Plugin config keys that have no scalar control (e.g. `env` records). */
  triggerPassthrough: Record<string, unknown>;
  agentType: string;
  agentConfig: Record<string, FieldValue>;
  agentPassthrough: Record<string, unknown>;
  prompt: string;
  timeoutMs: string;
  retries: string;
  retryBackoffMs: string;
  allowOverlap: boolean;
  tags: string;
}

/* ------------------------------------------------------------------ */
/* Form <-> spec mapping                                               */
/* ------------------------------------------------------------------ */

function emptyForm(triggers: TriggerInfo[], agents: AgentInfo[]): FormState {
  const trigger = triggers[0];
  const agent = agents[0];
  return {
    id: "",
    name: "",
    description: "",
    enabled: true,
    triggerType: trigger?.type ?? "",
    triggerConfig: defaultConfigFor(trigger),
    triggerPassthrough: {},
    agentType: agent?.type ?? "",
    agentConfig: defaultConfigFor(agent),
    agentPassthrough: {},
    prompt: "",
    timeoutMs: "",
    retries: "",
    retryBackoffMs: "",
    allowOverlap: false,
    tags: "",
  };
}

function defaultConfigFor(plugin: { fields: FieldSchema[] } | undefined): Record<string, FieldValue> {
  const config: Record<string, FieldValue> = {};
  for (const field of plugin?.fields ?? []) {
    const value = initialValueFor(field);
    if (value !== undefined) {
      config[field.key] = value;
      continue;
    }
    // A brand-new job with an empty cron field shows nothing but a warning,
    // which is the least helpful possible starting point. Seed a benign
    // schedule so the builder opens fully populated and every control is live.
    if (field.format === "cron") {
      config[field.key] = DEFAULT_CRON;
    }
    // A required free-text field (e.g. the agent's working directory) is the
    // other guaranteed stumble. Prefill the most plausible value so "Create"
    // does not fail on the very first try.
    if (field.format === undefined && field.required === true && field.type === "string" && field.default === undefined) {
      const guess = guessRequiredString(field);
      if (guess !== undefined) config[field.key] = guess;
    }
  }
  return config;
}

interface AgentOptionArgs {
  options: Record<string, FieldOptionSource>;
  modelProviders: Record<string, string>;
  value: FieldValue | undefined;
  disabled: boolean;
  onChange: (next: string | string[] | undefined) => void;
  onDerive: (patch: Record<string, string>) => void;
}

/**
 * Turn a config field into a picker when the adapter reported choices for its
 * key. Everything else keeps the generic control, so an adapter without
 * `discoverOptions` is unaffected.
 */
function agentOptionProps(
  schema: FieldSchema,
  args: AgentOptionArgs,
): { renderCustom?: () => React.ReactNode } {
  const source = args.options[schema.key];
  if (!source) return {};
  return {
    renderCustom: () => (
      <OptionControl
        id={`agent-${schema.key}`}
        source={source}
        modelProviders={args.modelProviders}
        value={args.value}
        onChange={args.onChange}
        disabled={args.disabled}
        onDerive={args.onDerive}
      />
    ),
  };
}

/** First required-but-empty field, phrased for a toast. */
function missingRequired(
  fields: FieldSchema[],
  config: Record<string, FieldValue>,
  section: "trigger" | "agent",
): string | null {
  for (const field of fields) {
    if (field.required !== true) continue;
    const value = config[field.key];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);
    if (empty) return `${section} · ${field.label || field.key} is required.`;
  }
  return null;
}

/**
 * Plausible initial value for a required string field, keyed by what the field
 * means rather than by which plugin declared it.
 */
function guessRequiredString(field: FieldSchema): string | undefined {
  const key = field.key.toLowerCase();
  if (key === "cwd" || key === "workdir" || key === "dir" || key === "directory") {
    return "/tmp";
  }
  if (key === "path" || key === "file" || key === "script") {
    return "/tmp";
  }
  return undefined;
}

function formFromJob(job: JobView): FormState {
  const { spec } = job;
  const trigger = toFieldMap(configRecord(spec.trigger));
  const agent = toFieldMap(configRecord(spec.agent));
  return {
    id: spec.id,
    name: spec.name ?? "",
    description: spec.description ?? "",
    enabled: spec.enabled !== false,
    triggerType: typeof spec.trigger?.type === "string" ? spec.trigger.type : "",
    triggerConfig: trigger.fields,
    triggerPassthrough: trigger.passthrough,
    agentType: typeof spec.agent?.type === "string" ? spec.agent.type : "",
    agentConfig: agent.fields,
    agentPassthrough: agent.passthrough,
    prompt: spec.prompt,
    timeoutMs: spec.timeoutMs === undefined ? "" : String(spec.timeoutMs),
    retries: spec.retries === undefined ? "" : String(spec.retries),
    retryBackoffMs: spec.retryBackoffMs === undefined ? "" : String(spec.retryBackoffMs),
    allowOverlap: spec.allowOverlap === true,
    tags: (spec.tags ?? []).join(", "),
  };
}

/**
 * Reads a plugin payload as a plain JSON bag.
 *
 * `JobSpec.trigger` / `JobSpec.agent` are typed as the frozen plugin unions,
 * but at runtime they are always `{ type, ...declaredFields }` (contract §3/§4)
 * and the descriptor-driven form is inherently key-agnostic.
 */
function configRecord(config: TriggerConfig | AgentConfig): Record<string, unknown> {
  // SAFETY: plugin configs are open JSON bags — every key is declared by the
  // plugin's own `descriptor.fields` and re-validated server side, so widening
  // to an indexable record loses nothing the UI relies on.
  const record = config as unknown as Record<string, unknown>;
  return record;
}

/**
 * Rebuilds `{ type, ...declaredFields }` for a plugin payload (contract §3/§4).
 * TypeScript cannot verify the plugin invariant; `TriggerPlugin.validate` /
 * `AgentAdapter.validate` do, server side, on every save.
 */
function pluginPayload<T>(type: string, fields: Record<string, unknown>): T {
  // SAFETY: the emitted keys are exactly the plugin's declared `fields`, and
  // the server re-validates the payload with that plugin's `validate()`.
  const payload = { type, ...fields } as unknown as T;
  return payload;
}

/** Config object → per-field form values (drops `type`, which is its own control). */
/**
 * Config object → form state.
 *
 * Scalar / string[] values become real form values. Anything structured (for
 * example `agent.env`, a `Record<string, string>`) has no scalar control, so it
 * is carried in a passthrough bag and merged back verbatim on save — stringifying
 * it would corrupt the payload and the server would reject it (contract §4).
 */
function toFieldMap(config: Record<string, unknown>): {
  fields: Record<string, FieldValue>;
  passthrough: Record<string, unknown>;
} {
  const fields: Record<string, FieldValue> = {};
  const passthrough: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(config)) {
    if (key === "type") continue;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      fields[key] = raw;
    } else if (Array.isArray(raw) && raw.every((item): item is string => typeof item === "string")) {
      fields[key] = raw;
    } else if (raw !== null && raw !== undefined) {
      passthrough[key] = raw;
    }
  }
  return { fields, passthrough };
}

function cleanConfig(
  fields: FieldSchema[],
  config: Record<string, FieldValue>,
  passthrough: Record<string, unknown>,
): Record<string, unknown> {
  // Structured values first, then declared scalar fields win on key collision.
  const out: Record<string, unknown> = { ...passthrough };
  for (const field of fields) {
    const value = config[field.key];
    if (value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[field.key] = value;
  }
  return out;
}

function parseNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function splitTags(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function buildSpec(form: FormState, triggerFields: FieldSchema[], agentFields: FieldSchema[]): JobSpec {
  const trigger = cleanConfig(triggerFields, form.triggerConfig, form.triggerPassthrough);
  const agent = cleanConfig(agentFields, form.agentConfig, form.agentPassthrough);

  const spec: JobSpec = {
    id: form.id.trim(),
    trigger: pluginPayload<TriggerConfig>(form.triggerType, trigger),
    agent: pluginPayload<JobSpec["agent"]>(form.agentType, agent),
    prompt: form.prompt,
    enabled: form.enabled,
    allowOverlap: form.allowOverlap,
  };

  const name = form.name.trim();
  if (name !== "") spec.name = name;
  const description = form.description.trim();
  if (description !== "") spec.description = description;

  const timeoutMs = parseNumber(form.timeoutMs);
  if (timeoutMs !== undefined) spec.timeoutMs = timeoutMs;
  const retries = parseNumber(form.retries);
  if (retries !== undefined) spec.retries = retries;
  const retryBackoffMs = parseNumber(form.retryBackoffMs);
  if (retryBackoffMs !== undefined) spec.retryBackoffMs = retryBackoffMs;

  const tags = splitTags(form.tags);
  if (tags.length > 0) spec.tags = tags;

  return spec;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function JobEditor({
  job,
  triggers,
  agents,
  defaultTimezone,
  onClose,
  onSaved,
  onDeleted,
  notify,
}: JobEditorProps) {
  const isEdit = job !== null;
  const [form, setForm] = useState<FormState>(() => (job ? formFromJob(job) : emptyForm(triggers, agents)));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [specOpen, setSpecOpen] = useState(false);

  const triggerPlugin = useMemo(
    () => triggers.find((t) => t.type === form.triggerType),
    [triggers, form.triggerType],
  );
  const agentPlugin = useMemo(
    () => agents.find((a) => a.type === form.agentType),
    [agents, form.agentType],
  );

  const triggerFields = triggerPlugin?.fields ?? [];
  const agentFields = agentPlugin?.fields ?? [];

  // Real choices from the agent itself (models, thinking levels, default tools).
  const {
    options: agentOptions,
    modelProviders,
    loading: optionsLoading,
    error: optionsError,
    refresh: refreshOptions,
  } = useAgentOptions(form.agentType);
  const agentOptionsState = { loading: optionsLoading, error: optionsError, refresh: refreshOptions };

  const patch = useCallback((next: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...next }));
  }, []);

  const setTriggerField = useCallback((key: string, value: FieldValue) => {
    setForm((prev) => ({ ...prev, triggerConfig: { ...prev.triggerConfig, [key]: value } }));
  }, []);

  const setAgentField = useCallback((key: string, value: FieldValue) => {
    setForm((prev) => ({ ...prev, agentConfig: { ...prev.agentConfig, [key]: value } }));
  }, []);

  /* Switching plugin type swaps the whole config block for that plugin's defaults. */
  const onTriggerTypeChange = useCallback(
    (type: string) => {
      const plugin = triggers.find((t) => t.type === type);
      setForm((prev) => ({ ...prev, triggerType: type, triggerConfig: defaultConfigFor(plugin) }));
    },
    [triggers],
  );

  const onAgentTypeChange = useCallback(
    (type: string) => {
      const plugin = agents.find((a) => a.type === type);
      setForm((prev) => ({ ...prev, agentType: type, agentConfig: defaultConfigFor(plugin) }));
    },
    [agents],
  );

  const spec = useMemo(() => buildSpec(form, triggerFields, agentFields), [form, triggerFields, agentFields]);

  /* ---------------- schedule preview (debounced) ---------------- */

  const previewRequest = useMemo(
    () => buildPreviewRequest(triggerFields, form.triggerConfig),
    [triggerFields, form.triggerConfig],
  );
  const debouncedPreview = useDebounced(previewRequest, PREVIEW_DEBOUNCE_MS);

  const [preview, setPreview] = useState<CronPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSeq = useRef(0);

  useEffect(() => {
    if (!debouncedPreview) {
      setPreview(null);
      return;
    }
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        const response = await http.post<CronPreviewResponse>("/api/schedule/preview", debouncedPreview);
        if (!cancelled && seq === previewSeq.current) setPreview(response);
      } catch (err) {
        if (!cancelled && seq === previewSeq.current) {
          setPreview({ fires: [], scheduleText: "", error: errorMessage(err) });
        }
      } finally {
        if (!cancelled && seq === previewSeq.current) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedPreview]);

  const jobTimezone = useMemo(
    () => previewTimezone(triggerFields, form.triggerConfig, defaultTimezone),
    [triggerFields, form.triggerConfig, defaultTimezone],
  );

  /* ---------------- validation error routing ---------------- */

  // Every path the form can display inline; anything else floats to the banner.
  const claimedPaths = useMemo(() => {
    const paths = [
      "id",
      "name",
      "description",
      "enabled",
      "prompt",
      "timeoutMs",
      "retries",
      "retryBackoffMs",
      "allowOverlap",
      "tags",
      "trigger",
      "trigger.type",
      "agent",
      "agent.type",
    ];
    for (const field of triggerFields) paths.push(`trigger.${field.key}`);
    for (const field of agentFields) paths.push(`agent.${field.key}`);
    return paths;
  }, [triggerFields, agentFields]);

  const bannerErrors = useMemo(() => {
    if (!error) return [];
    const unclaimed = error.unclaimedPaths(claimedPaths);
    // Root-level errors (`(root)`, empty path) plus anything we cannot attach.
    return unclaimed.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message));
  }, [error, claimedPaths]);

  const errorsFor = useCallback(
    (path: string): string[] => (error ? error.detailsFor(path).filter((m) => m.length > 0) : []),
    [error],
  );

  /* ---------------- actions ---------------- */

  /** Client-side pre-flight: fail loudly on the obvious gap instead of a 422. */
  const blockedReason = useMemo(() => {
    if (spec.id.trim() === "") return "ID is required.";
    if (form.prompt.trim() === "") return "Prompt is required — the agent needs instructions.";
    const missing = missingRequired(triggerFields, form.triggerConfig, "trigger");
    if (missing) return missing;
    return missingRequired(agentFields, form.agentConfig, "agent");
  }, [agentFields, form.agentConfig, form.prompt, spec.id, triggerFields, form.triggerConfig]);

  const onSave = useCallback(async () => {
    if (blockedReason) {
      notify("warn", blockedReason);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = isEdit
        ? await http.put<{ job: JobView }>(`/api/jobs/${encodeURIComponent(job.spec.id)}`, spec)
        : await http.post<{ job: JobView }>("/api/jobs", spec);
      notify("success", isEdit ? `Saved ${response.job.spec.id}` : `Created ${response.job.spec.id}`);
      onSaved(response.job);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err);
        notify("danger", `Save failed: ${err.message}`);
      } else {
        notify("danger", `Save failed: ${errorMessage(err)}`);
      }
    } finally {
      setSaving(false);
    }
  }, [blockedReason, isEdit, job, spec, notify, onSaved]);

  const onDelete = useCallback(async () => {
    if (!job) return;
    const id = job.spec.id;
    if (!window.confirm(`Delete job "${id}"? The YAML file is removed from disk.`)) return;
    setDeleting(true);
    try {
      await http.del(`/api/jobs/${encodeURIComponent(id)}`);
      notify("success", `Deleted ${id}`);
      onDeleted(id);
    } catch (err) {
      notify("danger", `Delete failed: ${errorMessage(err)}`);
    } finally {
      setDeleting(false);
    }
  }, [job, notify, onDeleted]);

  const busy = saving || deleting;

  return (
    <Modal
      title={isEdit ? `Edit job · ${job.spec.id}` : "New job"}
      subtitle={
        isEdit
          ? job.sourcePath
          : "Creates a YAML declaration and registers it with the scheduler immediately."
      }
      onClose={onClose}
      variant="panel"
      className="modal--editor"
      footer={
        <>
          {isEdit ? (
            <button type="button" className="btn btn--danger" onClick={() => void onDelete()} disabled={busy}>
              {deleting ? "Deleting…" : "Delete job"}
            </button>
          ) : null}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void onSave()} disabled={busy}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create job"}
          </button>
        </>
      }
    >
      {bannerErrors.length > 0 ? (
        <div className="banner banner--danger" role="alert">
          <strong>{error?.status === 422 ? "Validation failed" : error?.message}</strong>
          <ul className="banner__list">
            {bannerErrors.map((message, index) => (
              <li key={`${message}-${index}`}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="form-section">
        <h3 className="form-section__title">Basics</h3>
        <div className="form-grid form-grid--2">
          <div className="field">
            <label className="field__label" htmlFor="job-id">
              <span>ID</span>
              <span className="field__required" title="Required">*</span>
              <code className="field__key">id</code>
            </label>
            <input
              id="job-id"
              className="input input--mono"
              value={form.id}
              disabled={isEdit || busy}
              placeholder="nightly-repo-audit"
              onChange={(event) => patch({ id: event.currentTarget.value })}
              aria-invalid={errorsFor("id").length > 0 || undefined}
            />
            {isEdit ? (
              <p className="field__help">The id is the YAML file name and cannot be renamed here.</p>
            ) : (
              <p className="field__help">Lowercase slug: a-z, 0-9, dash, underscore (max 64).</p>
            )}
            <FieldErrors messages={errorsFor("id")} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="job-name">
              <span>Name</span>
              <code className="field__key">name</code>
            </label>
            <input
              id="job-name"
              className="input"
              value={form.name}
              disabled={busy}
              placeholder="Nightly repo audit"
              onChange={(event) => patch({ name: event.currentTarget.value })}
              aria-invalid={errorsFor("name").length > 0 || undefined}
            />
            <FieldErrors messages={errorsFor("name")} />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="job-description">
            <span>Description</span>
            <code className="field__key">description</code>
          </label>
          <input
            id="job-description"
            className="input"
            value={form.description}
            disabled={busy}
            placeholder="What this job is for"
            onChange={(event) => patch({ description: event.currentTarget.value })}
            aria-invalid={errorsFor("description").length > 0 || undefined}
          />
          <FieldErrors messages={errorsFor("description")} />
        </div>

        <div className="field field--inline">
          <label className="field__label" htmlFor="job-enabled">
            <span>Enabled</span>
            <code className="field__key">enabled</code>
          </label>
          <div className="field__switch">
            <input
              id="job-enabled"
              type="checkbox"
              checked={form.enabled}
              disabled={busy}
              onChange={(event) => patch({ enabled: event.currentTarget.checked })}
            />
            <span className="field__switch-text">{form.enabled ? "scheduled" : "paused"}</span>
          </div>
          <FieldErrors messages={errorsFor("enabled")} />
        </div>
      </section>

      {/* ---------------- trigger (plugin-driven) ---------------- */}
      <section className="form-section">
        <h3 className="form-section__title">Trigger</h3>
        <div className="field">
          <label className="field__label" htmlFor="job-trigger-type">
            <span>Type</span>
            <span className="field__required" title="Required">*</span>
            <code className="field__key">trigger.type</code>
          </label>
          <select
            id="job-trigger-type"
            className="input input--select"
            value={form.triggerType}
            disabled={busy}
            onChange={(event) => onTriggerTypeChange(event.currentTarget.value)}
          >
            {triggers.length === 0 ? <option value="">(no trigger plugins loaded)</option> : null}
            {triggers.map((plugin) => (
              <option key={plugin.type} value={plugin.type}>
                {plugin.displayName} — {plugin.type}
              </option>
            ))}
          </select>
          {triggerPlugin ? <p className="field__help">{triggerPlugin.description}</p> : null}
          <FieldErrors messages={errorsFor("trigger.type").concat(errorsFor("trigger"))} />
        </div>

        {triggerFields.map((schema) => (
          <Field
            key={`trigger-${schema.key}`}
            schema={schema}
            idPrefix="trigger-"
            value={form.triggerConfig[schema.key]}
            onChange={(value) => setTriggerField(schema.key, value)}
            errors={errorsFor(`trigger.${schema.key}`)}
            disabled={busy}
            {...renderTriggerControl(schema, {
              value: form.triggerConfig[schema.key],
              timezone: jobTimezone,
              fallbackTimezone: defaultTimezone,
              disabled: busy,
              errors: errorsFor(`trigger.${schema.key}`),
              onChange: (next) => setTriggerField(schema.key, next),
              preview: previewRequest ? (
                <SchedulePreview preview={preview} loading={previewLoading} jobTimezone={jobTimezone} />
              ) : null,
            })}
          />
        ))}

        {previewRequest && triggerFields.every((schema) => schema.format !== "cron") ? (
          <SchedulePreview preview={preview} loading={previewLoading} jobTimezone={jobTimezone} />
        ) : null}
      </section>

      {/* ---------------- agent (plugin-driven) ---------------- */}
      <section className="form-section">
        <h3 className="form-section__title">Agent</h3>
        <div className="field">
          <label className="field__label" htmlFor="job-agent-type">
            <span>Type</span>
            <span className="field__required" title="Required">*</span>
            <code className="field__key">agent.type</code>
          </label>
          <select
            id="job-agent-type"
            className="input input--select"
            value={form.agentType}
            disabled={busy}
            onChange={(event) => onAgentTypeChange(event.currentTarget.value)}
          >
            {agents.length === 0 ? <option value="">(no agent plugins loaded)</option> : null}
            {agents.map((plugin) => (
              <option key={plugin.type} value={plugin.type}>
                {plugin.displayName} — {plugin.type}
              </option>
            ))}
          </select>
          {agentPlugin ? <p className="field__help">{agentPlugin.description}</p> : null}
          <FieldErrors messages={errorsFor("agent.type").concat(errorsFor("agent"))} />
        </div>

        {agentFields.map((schema) => (
          <Field
            key={`agent-${schema.key}`}
            schema={schema}
            idPrefix="agent-"
            value={form.agentConfig[schema.key]}
            onChange={(value) => setAgentField(schema.key, value)}
            errors={errorsFor(`agent.${schema.key}`)}
            disabled={busy}
            {...agentOptionProps(schema, {
              options: agentOptions,
              modelProviders,
              value: form.agentConfig[schema.key],
              disabled: busy,
              onChange: (next) => setAgentField(schema.key, next as FieldValue),
              onDerive: (patch) => {
                for (const [key, value] of Object.entries(patch)) setAgentField(key, value);
              },
            })}
          />
        ))}

        {agentOptionsState.loading && Object.keys(agentOptions).length === 0 ? (
          <p className="field__help">Discovering models from pi…</p>
        ) : null}
        {agentOptionsState.error ? (
          <p className="field__help">
            Could not list options ({agentOptionsState.error}) — the fields stay free-text.{" "}
            <button type="button" className="link-btn" onClick={agentOptionsState.refresh} disabled={busy}>
              Retry
            </button>
          </p>
        ) : null}
      </section>

      {/* ---------------- prompt ---------------- */}
      <section className="form-section">
        <h3 className="form-section__title">Prompt</h3>
        <div className="field">
          <label className="field__label" htmlFor="job-prompt">
            <span>Task text handed to the agent</span>
            <span className="field__required" title="Required">*</span>
            <code className="field__key">prompt</code>
          </label>
          <textarea
            id="job-prompt"
            className="input input--area input--mono input--prompt"
            rows={8}
            value={form.prompt}
            disabled={busy}
            placeholder="Look at the commits from the last 24 hours and summarise the risks."
            onChange={(event) => patch({ prompt: event.currentTarget.value })}
            aria-invalid={errorsFor("prompt").length > 0 || undefined}
          />
          <FieldErrors messages={errorsFor("prompt")} />
        </div>
      </section>

      {/* ---------------- advanced ---------------- */}
      <section className="form-section">
        <h3 className="form-section__title">Advanced</h3>
        <div className="form-grid form-grid--3">
          <div className="field">
            <label className="field__label" htmlFor="job-timeout">
              <span>Timeout (ms)</span>
              <code className="field__key">timeoutMs</code>
            </label>
            <input
              id="job-timeout"
              className="input input--num"
              type="number"
              min={1}
              value={form.timeoutMs}
              disabled={busy}
              placeholder="1800000"
              onChange={(event) => patch({ timeoutMs: event.currentTarget.value })}
            />
            <p className="field__help">Default 30 min.</p>
            <FieldErrors messages={errorsFor("timeoutMs")} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="job-retries">
              <span>Retries</span>
              <code className="field__key">retries</code>
            </label>
            <input
              id="job-retries"
              className="input input--num"
              type="number"
              min={0}
              max={10}
              value={form.retries}
              disabled={busy}
              placeholder="1"
              onChange={(event) => patch({ retries: event.currentTarget.value })}
            />
            <p className="field__help">Extra attempts after a failure.</p>
            <FieldErrors messages={errorsFor("retries")} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="job-backoff">
              <span>Retry backoff (ms)</span>
              <code className="field__key">retryBackoffMs</code>
            </label>
            <input
              id="job-backoff"
              className="input input--num"
              type="number"
              min={0}
              value={form.retryBackoffMs}
              disabled={busy}
              placeholder="30000"
              onChange={(event) => patch({ retryBackoffMs: event.currentTarget.value })}
            />
            <p className="field__help">Delay before attempt n+1.</p>
            <FieldErrors messages={errorsFor("retryBackoffMs")} />
          </div>
        </div>

        <div className="field field--inline">
          <label className="field__label" htmlFor="job-overlap">
            <span>Allow overlap</span>
            <code className="field__key">allowOverlap</code>
          </label>
          <div className="field__switch">
            <input
              id="job-overlap"
              type="checkbox"
              checked={form.allowOverlap}
              disabled={busy}
              onChange={(event) => patch({ allowOverlap: event.currentTarget.checked })}
            />
            <span className="field__switch-text">
              {form.allowOverlap ? "new run may start while one is running" : "one run at a time"}
            </span>
          </div>
          <FieldErrors messages={errorsFor("allowOverlap")} />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="job-tags">
            <span>Tags</span>
            <code className="field__key">tags</code>
          </label>
          <input
            id="job-tags"
            className="input"
            value={form.tags}
            disabled={busy}
            placeholder="audit, nightly"
            onChange={(event) => patch({ tags: event.currentTarget.value })}
            aria-invalid={errorsFor("tags").length > 0 || undefined}
          />
          <p className="field__help">Comma separated.</p>
          <FieldErrors messages={errorsFor("tags")} />
        </div>
      </section>

      {/* ---------------- readonly spec ---------------- */}
      <section className="form-section">
        <button
          type="button"
          className="collapse-head"
          aria-expanded={specOpen}
          onClick={() => setSpecOpen((prev) => !prev)}
        >
          <span className={`caret${specOpen ? " caret--open" : ""}`} aria-hidden="true">
            ▸
          </span>
          Spec JSON (read only)
        </button>
        {specOpen ? (
          <pre className="code-block code-block--spec">{JSON.stringify(spec, null, 2)}</pre>
        ) : null}
      </section>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Preview helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Builds the preview body from the *descriptor*: any plugin that declares one of
 * the schedule keys gets a preview, so `manual` (no fields) shows nothing.
 */
function buildPreviewRequest(
  fields: FieldSchema[],
  config: Record<string, FieldValue>,
): CronPreviewRequest | null {
  const hasScheduleField = fields.some((field) => PREVIEW_KEYS.includes(field.key as PreviewKey));
  if (!hasScheduleField) return null;

  const request: CronPreviewRequest = { count: PREVIEW_COUNT };
  let meaningful = false;
  for (const key of PREVIEW_KEYS) {
    const raw = config[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value === "") continue;
    request[key] = value;
    if (key !== "timezone") meaningful = true;
  }
  // Without a cron/every value the server would just echo an error; wait for input.
  return meaningful ? request : null;
}

interface TriggerControlArgs {
  value: FieldValue | undefined;
  timezone: string;
  fallbackTimezone: string;
  disabled: boolean;
  errors: string[];
  onChange: (next: FieldValue) => void;
  preview: React.ReactNode;
}

/**
 * Map a descriptor `format` hint to a richer control. Everything else falls
 * through to the generic schema-driven `Field` renderer, so plugins that only
 * declare scalar types are unaffected.
 */
function renderTriggerControl(
  schema: FieldSchema,
  args: TriggerControlArgs,
): { renderCustom?: () => React.ReactNode } {
  if (schema.format === "cron") {
    return {
      renderCustom: () => (
        <CronFieldEditor
          value={asString(args.value)}
          onChange={args.onChange}
          timezone={args.timezone}
          disabled={args.disabled}
          errors={args.errors}
        >
          {args.preview}
        </CronFieldEditor>
      ),
    };
  }
  if (schema.format === "timezone") {
    return {
      renderCustom: () => (
        <TimezoneField
          value={asString(args.value)}
          onChange={args.onChange}
          fallback={args.fallbackTimezone}
          disabled={args.disabled}
          errors={args.errors}
        />
      ),
    };
  }
  return {};
}

/** Render an unset field value as "" for text-based custom controls. */
function asString(value: FieldValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function previewTimezone(
  fields: FieldSchema[],
  config: Record<string, FieldValue>,
  fallback: string,
): string {
  const declared = fields.some((field) => field.key === "timezone");
  if (!declared) return fallback;
  const raw = config.timezone;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
}

interface SchedulePreviewProps {
  preview: CronPreviewResponse | null;
  loading: boolean;
  jobTimezone: string;
}

function SchedulePreview({ preview, loading, jobTimezone }: SchedulePreviewProps) {
  return (
    <div className="preview">
      <div className="preview__head">
        <span className="preview__title">Next 5 fires</span>
        {loading ? <span className="preview__loading">computing…</span> : null}
        {preview?.scheduleText ? <code className="preview__schedule">{preview.scheduleText}</code> : null}
      </div>

      {preview?.error ? (
        <p className="preview__error">{preview.error}</p>
      ) : preview && preview.fires.length > 0 ? (
        <table className="preview__table">
          <thead>
            <tr>
              <th>Browser · {formatZoneLabel(LOCAL_TIMEZONE)}</th>
              <th>Job · {formatZoneLabel(jobTimezone)}</th>
              <th>Relative</th>
            </tr>
          </thead>
          <tbody>
            {preview.fires.map((fire) => (
              <tr key={fire}>
                <td className="mono">{formatTime(fire)}</td>
                <td className="mono">
                  {jobTimezone === LOCAL_TIMEZONE ? <span className="muted">same</span> : formatTime(fire, jobTimezone)}
                </td>
                <td className="muted">{formatRelativeFuture(fire)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : preview && preview.fires.length === 0 && !loading ? (
        <p className="preview__empty">No upcoming fires.</p>
      ) : (
        <p className="preview__empty">Set a cron expression or interval to preview the schedule.</p>
      )}
    </div>
  );
}

function FieldErrors({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <p className="field__error" role="alert">
      {messages.join(" · ")}
    </p>
  );
}

export default JobEditor;
