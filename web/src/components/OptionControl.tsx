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
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [byKey, setByKey] = useState<Record<string, FieldOptionSource>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!type) {
      setByKey({});
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
  /** When true the field maps to two keys (provider + model). */
  onDerive?: (patch: Record<string, string>) => void;
}

/**
 * A picker for one config key, driven entirely by discovery results.
 *
 * Falls back to a free-text input whenever discovery is unavailable, so an
 * unknown/failed model list never blocks someone from describing what they
 * want. The chosen value is always the plain string pi accepts.
 */
export function OptionControl({ source, value, onChange, disabled = false, onDerive }: OptionControlProps) {
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
        <div className="chips" role="group" aria-label={source.key}>
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
            className="input input--mono"
            type="text"
            value={current}
            placeholder={source.options.length === 0 ? "type a value" : "custom value"}
            disabled={disabled}
            onChange={(event) => {
              const next = event.currentTarget.value;
              const match = source.options.find((option) => option.value === next);
              if (match && onDerive) onDerive(derivePatch(source.key, match.value));
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
          className="input input--select"
          value={known ? current : ""}
          disabled={disabled}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (next === "") {
              onChange(undefined);
              return;
            }
            const match = source.options.find((option) => option.value === next);
            if (match && onDerive) onDerive(derivePatch(source.key, match.value));
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
 * Selecting `provider/model` implies the provider. Deriving it here keeps the
 * two fields consistent without asking the user to set the same fact twice
 * (pi rejects `--provider` without `--model`, and a mismatched pair is a
 * confusing runtime error).
 */
function derivePatch(key: string, value: string): Record<string, string> {
  if (key !== "model") return {};
  const slash = value.indexOf("/");
  if (slash <= 0) return {};
  return { provider: value.slice(0, slash) };
}
