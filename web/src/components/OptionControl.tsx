import { useEffect, useMemo, useState } from "react";
import { errorMessage, http } from "../api.ts";
import type { AgentOptionsResponse, FieldOptionSource } from "../types.ts";

/**
 * Loads `GET /api/agents/:type/options` once per agent type.
 *
 * Discovery starts pi, so it is cached server-side; here we dedupe in-flight
 * requests and keep the previous result while a refresh is running so the form
 * never flickers back to a text box mid-edit.
 */
export function useAgentOptions(type: string | null | undefined): {
  options: Record<string, FieldOptionSource>;
  modelProviders: Record<string, string>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [byKey, setByKey] = useState<Record<string, FieldOptionSource>>({});
  const [modelProviders, setModelProviders] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!type) {
      setByKey({});
      setModelProviders({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await http.get<AgentOptionsResponse>(`/api/agents/${encodeURIComponent(type)}/options`);
        if (cancelled) return;
        const next: Record<string, FieldOptionSource> = {};
        for (const source of response.options) next[source.key] = source;
        setByKey(next);
        setModelProviders(response.modelProviders ?? {});
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type, nonce]);

  return {
    options: byKey,
    modelProviders,
    loading,
    error,
    refresh: () => setNonce((value) => value + 1),
  };
}

export interface OptionControlProps {
  source: FieldOptionSource;
  /** Current value: string, or string[] for multi-select sources. */
  value: unknown;
  onChange: (next: string | string[] | undefined) => void;
  disabled?: boolean;
  /** Selecting a model also pins the provider pi reports for it. */
  onDerive?: (patch: Record<string, string>) => void;
  /** Authoritative model -> provider map from discovery. */
  modelProviders?: Record<string, string>;
  /** DOM id, so the wrapper <label> can point at this control. */
  id?: string;
}

/**
 * A picker for one config key, driven entirely by discovery results.
 *
 * Falls back to a free-text input whenever discovery is unavailable, so an
 * unknown/failed model list never blocks someone from describing what they
 * want. The chosen value is always the plain string pi accepts.
 */
export function OptionControl({
  source,
  value,
  onChange,
  disabled = false,
  onDerive,
  modelProviders = {},
  id,
}: OptionControlProps) {
  const current = typeof value === "string" ? value : "";
  const multiple = source.multiple === true;
  const selected = useMemo(() => {
    if (!multiple) return [];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }, [multiple, value]);

  // A value that is not in the discovered list (hand-edited YAML, a model added
  // to another machine) must still render and stay editable.
  const known = source.options.some((option) => option.value === current);
  /*
   * Default to the picker. Free text is an explicit escape hatch ("Type…")
   * plus the only option when discovery returned nothing — but that last case
   * must be derived at render time, not latched in state: options arrive
   * asynchronously and a latched `true` would leave the picker permanently
   * replaced by a text box.
   */
  const [free, setFree] = useState(false);

  if (source.error) {
    return (
      <div className="opt-control">
        <input
          id={id}
          className="input input--mono"
          type="text"
          value={current}
          placeholder="could not list options — type a value"
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value === "" ? undefined : event.currentTarget.value)}
        />
        <p className="opt-control__note opt-control__note--warn">
          Discovery failed: {source.error}
        </p>
      </div>
    );
  }

  if (multiple) {
    const toggle = (item: string) => {
      const next = new Set(selected);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      onChange(next.size === 0 ? undefined : [...next]);
    };
    return (
      <div className="opt-control">
        <div className="chips" id={id} role="group" aria-label={source.key}>
          {source.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`chip${selected.includes(option.value) ? " chip--active" : ""}`}
              onClick={() => toggle(option.value)}
              disabled={disabled}
              aria-pressed={selected.includes(option.value)}
              title={option.detail}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="opt-control__note">
          {selected.length === 0 ? "No tools selected → pi uses its defaults (read, bash, edit, write)." : `${selected.length} selected`}
          {source.source ? ` · from ${source.source}` : ""}
        </p>
      </div>
    );
  }

  if (free || source.options.length === 0) {
    return (
      <div className="opt-control">
        <div className="opt-control__row">
          <input
            id={id}
            className="input input--mono"
            type="text"
            value={current}
            placeholder={source.options.length === 0 ? "type a value" : "custom value"}
            disabled={disabled}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (onDerive) onDerive(derivePatch(source.key, next, modelProviders));
              onChange(next === "" ? undefined : next);
            }}
          />
          {source.options.length > 0 ? (
            <button type="button" className="chip" onClick={() => setFree(false)} disabled={disabled}>
              Pick from list
            </button>
          ) : null}
        </div>
        <p className="opt-control__note">{source.source ? `from ${source.source}` : ""}</p>
      </div>
    );
  }

  return (
    <div className="opt-control">
      <div className="opt-control__row">
        <select
          id={id}
          className="input input--select"
          value={known ? current : ""}
          disabled={disabled}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (next === "") {
              onChange(undefined);
              return;
            }
            if (onDerive) onDerive(derivePatch(source.key, next, modelProviders));
            onChange(next);
          }}
        >
          <option value="">— pi default —</option>
          {!known && current !== "" ? <option value={current}>{current} (not in list)</option> : null}
          {source.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
              {option.detail ? ` — ${option.detail}` : ""}
            </option>
          ))}
        </select>
        <button type="button" className="chip" onClick={() => setFree(true)} disabled={disabled} title="Type a value instead">
          Type…
        </button>
      </div>
      <p className="opt-control__note">
        {source.options.length} available{source.source ? ` · from ${source.source}` : ""}
      </p>
    </div>
  );
}

/**
 * Picking a model also sets its provider, so the user never has to state the
 * same fact twice (pi rejects `--provider` without `--model`).
 *
 * The provider comes from the discovery map, never from the model id: pi
 * reports `workbuddy/claude-sonnet-5.5` on provider `any-endpoint`, so splitting
 * the string on `/` would write a provider that does not exist.
 */
function derivePatch(
  key: string,
  value: string,
  modelProviders: Record<string, string>,
): Record<string, string> {
  if (key !== "model") return {};
  const provider = modelProviders[value];
  return provider ? { provider } : {};
}
