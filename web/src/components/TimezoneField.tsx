import { useMemo, useState } from "react";

export interface TimezoneFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** Server default, surfaced as an explicit "use default" option. */
  fallback: string;
  disabled?: boolean;
  errors?: string[];
  children?: React.ReactNode;
}

/**
 * Timezone picker backed by `Intl.supportedValuesOf("timeZone")`.
 *
 * The list comes from the browser, so it matches whatever the user's own
 * runtime knows about (no bundled tzdata to go stale). A `<datalist>` keeps the
 * field free-text: a valid IANA name that this browser does not list can still
 * be typed, and the server validates it authoritatively.
 */
export function TimezoneField({ value, onChange, fallback, disabled = false, errors = [], children }: TimezoneFieldProps) {
  const zones = useMemo(() => {
    const supported = typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const all = new Set<string>(supported);
    if (local) all.add(local);
    if (fallback) all.add(fallback);
    if (value) all.add(value);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [fallback, value]);

  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return zones.slice(0, 200);
    return zones.filter((zone) => zone.toLowerCase().includes(needle)).slice(0, 200);
  }, [zones, filter]);

  const hasError = errors.length > 0;
  const listId = "tz-options";
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="tz-field">
      <div className="tz-field__row">
        <input
          className="input input--mono"
          type="text"
          list={listId}
          value={value}
          placeholder={fallback || "Asia/Shanghai"}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={hasError || undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <datalist id={listId}>
          {visible.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </div>

      <div className="tz-field__quick">
        {local && local !== value ? (
          <button type="button" className="chip" onClick={() => onChange(local)} disabled={disabled}>
            Use browser ({local})
          </button>
        ) : null}
        {fallback && fallback !== value ? (
          <button type="button" className="chip" onClick={() => onChange(fallback)} disabled={disabled}>
            Use default ({fallback})
          </button>
        ) : null}
        <input
          className="input tz-field__filter"
          type="text"
          value={filter}
          placeholder="Filter…"
          aria-label="Filter timezones"
          disabled={disabled}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
        <span className="tz-field__count">{visible.length} of {zones.length}</span>
      </div>

      {hasError ? <p className="field__error">{errors.join(" · ")}</p> : null}
      {children}
    </div>
  );
}
