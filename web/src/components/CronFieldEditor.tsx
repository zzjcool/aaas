import { useEffect, useId, useMemo, useState } from "react";
import {
  PRESETS,
  defaultModel,
  describeModel,
  parseCron,
  serializeCron,
  MONTH_LABELS,
  WEEKDAY_LABELS,
  type CronModel,
  type DayMode,
} from "../cron.ts";

export interface CronFieldEditorProps {
  /** Current cron expression from the form (may be empty or unsupported). */
  value: string;
  onChange: (next: string) => void;
  /** Timezone the schedule is evaluated in, for the human summary. */
  timezone: string;
  disabled?: boolean;
  /** 422 messages for this field. */
  errors?: string[];
  /** Localised preview rows supplied by the parent (server-computed). */
  children?: React.ReactNode;
}

/**
 * Visual cron editor.
 *
 * Two modes over one value: a builder (presets + fields) for the shapes people
 * actually write, and a raw text box for everything else. The value is always a
 * plain cron string, so the server contract is untouched and nothing is lost
 * when an expression does not fit the builder.
 */
export function CronFieldEditor({ value, onChange, timezone, disabled = false, errors = [], children }: CronFieldEditorProps) {
  const model = useMemo(() => parseCron(value), [value]);
  const trimmed = value.trim();
  const isMacro = trimmed.startsWith("@");
  const [mode, setMode] = useState<"visual" | "raw">(() =>
    trimmed === "" || model !== null || isMacro ? "visual" : "raw",
  );

  // Follow the value: if it stops being representable (e.g. the user typed
  // something exotic in raw mode), stay in raw rather than showing a broken form.
  useEffect(() => {
    if (model === null && !isMacro && trimmed !== "") setMode("raw");
  }, [model, isMacro, trimmed]);

  const hasError = errors.length > 0;
  const summary = model ? describeModel(model) : macroSummary(trimmed);

  const emit = (next: CronModel) => onChange(serializeCron(next));
  const patch = (partial: Partial<CronModel>) => {
    const base = model ?? defaultModel();
    emit({ ...base, ...partial });
  };

  const applyPreset = (presetId: string) => {
    const preset = PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const result = preset.apply();
    if (typeof result === "string") {
      setMode("raw");
      onChange(result);
    } else {
      setMode("visual");
      emit(result);
    }
    setPresetId(presetId);
  };

  const matchedPreset = useMemo(() => {
    if (!model) return "";
    const serialized = serializeCron(model);
    return PRESETS.find((preset) => {
      const result = preset.apply();
      return typeof result !== "string" && serializeCron(result) === serialized;
    })?.id ?? "";
  }, [model]);

  const [presetId, setPresetId] = useState(matchedPreset);
  useEffect(() => {
    setPresetId(matchedPreset);
  }, [matchedPreset]);

  const summaryId = useId();

  return (
    <div className={`cron-field${hasError ? " cron-field--error" : ""}`}>
      {/* ---------------- summary + mode switch ---------------- */}
      <div className="cron-field__head">
        <div className="cron-field__summary">
          <span className="cron-field__badge" aria-hidden="true">⏱</span>
          <span className="cron-field__text" id={summaryId} aria-live="polite">
            {trimmed === "" ? "No schedule yet — pick a preset or build one." : summary}
          </span>
        </div>
        <div className="cron-field__modes" role="group" aria-label="Cron editing mode">
          <button
            type="button"
            className={`cron-mode${mode === "visual" ? " cron-mode--active" : ""}`}
            onClick={() => setMode("visual")}
            disabled={disabled}
          >
            Visual
          </button>
          <button
            type="button"
            className={`cron-mode${mode === "raw" ? " cron-mode--active" : ""}`}
            onClick={() => setMode("raw")}
            disabled={disabled}
          >
            Expression
          </button>
        </div>
      </div>

      {/* ---------------- presets ---------------- */}
      {mode === "visual" ? (
        <div className="cron-presets" role="group" aria-label="Schedule presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`cron-preset${presetId === preset.id ? " cron-preset--active" : ""}`}
              title={preset.hint}
              onClick={() => applyPreset(preset.id)}
              disabled={disabled}
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* ---------------- builder ---------------- */}
      {mode === "visual" ? (
        model ? (
          <div className="cron-builder">
            <RepeatRow
              label="Minutes"
              disabled={disabled}
              mode={model.minuteMode === "at" && model.hourMode === "every" ? "at" : model.minuteMode}
              modes={[
                { value: "every", label: "every minute" },
                { value: "step", label: "every N minutes" },
                { value: "at", label: "at minute" },
              ]}
              onMode={(next) => patch({ minuteMode: next as CronModel["minuteMode"] })}
            >
              {model.minuteMode === "step" ? (
                <NumberInput
                  ariaLabel="Minutes interval"
                  min={1}
                  max={59}
                  value={model.minuteStep}
                  disabled={disabled}
                  onChange={(next) => patch({ minuteStep: next })}
                />
              ) : model.minuteMode === "at" ? (
                <NumberInput
                  ariaLabel="Minute"
                  min={0}
                  max={59}
                  value={model.minute}
                  disabled={disabled}
                  onChange={(next) => patch({ minute: next })}
                />
              ) : null}
            </RepeatRow>

            <RepeatRow
              label="Hours"
              disabled={disabled}
              mode={model.hourMode}
              modes={[
                { value: "every", label: "every hour" },
                { value: "step", label: "every N hours" },
                { value: "at", label: "at these hours" },
              ]}
              onMode={(next) => patch({ hourMode: next as CronModel["hourMode"] })}
            >
              {model.hourMode === "step" ? (
                <NumberInput
                  ariaLabel="Hours interval"
                  min={1}
                  max={23}
                  value={model.hourStep}
                  disabled={disabled}
                  onChange={(next) => patch({ hourStep: next })}
                />
              ) : model.hourMode === "at" ? (
                <HourPicker
                  hours={model.hours}
                  disabled={disabled}
                  onChange={(hours) => patch({ hours })}
                />
              ) : null}
            </RepeatRow>

            <div className="cron-row">
              <span className="cron-row__label">Days</span>
              <div className="cron-row__body">
                <div className="chips" role="group" aria-label="Which days">
                  {(
                    [
                      ["daily", "Every day"],
                      ["weekdays", "Weekdays"],
                      ["weekends", "Weekends"],
                      ["specific", "Day of week"],
                    ] as [DayMode, string][]
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={`chip${model.dayMode === mode ? " chip--active" : ""}`}
                      onClick={() =>
                        patch({
                          dayMode: mode,
                          weekday: mode === "specific" ? (model.weekday ?? 1) : model.weekday,
                        })
                      }
                      disabled={disabled}
                    >
                      {label}
                    </button>
                  ))}
                  {model.dayOfMonth !== null || model.month !== null ? (
                    <button
                      type="button"
                      className="chip chip--active"
                      onClick={() => patch({ dayOfMonth: null, month: null })}
                      disabled={disabled}
                      title="Clear the day-of-month / month filter"
                    >
                      Day of month ✕
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="chip chip--ghost"
                      onClick={() => patch({ dayOfMonth: model.dayOfMonth ?? 1 })}
                      disabled={disabled}
                    >
                      Day of month…
                    </button>
                  )}
                </div>

                {model.dayMode === "specific" ? (
                  <select
                    className="input input--select cron-inline"
                    aria-label="Weekday"
                    value={model.weekday ?? 1}
                    disabled={disabled}
                    onChange={(event) => patch({ weekday: Number(event.currentTarget.value) })}
                  >
                    {[1, 2, 3, 4, 5, 6, 7].map((weekday) => (
                      <option key={weekday} value={weekday}>
                        {weekday === 7 ? "Sunday" : WEEKDAY_LABELS[weekday]}
                      </option>
                    ))}
                  </select>
                ) : null}

                {model.dayOfMonth !== null ? (
                  <span className="cron-inline-group">
                    <span className="cron-row__hint">on day</span>
                    <NumberInput
                      ariaLabel="Day of month"
                      min={1}
                      max={31}
                      value={model.dayOfMonth}
                      disabled={disabled}
                      onChange={(next) => patch({ dayOfMonth: next })}
                    />
                    <select
                      className="input input--select cron-inline"
                      aria-label="Month"
                      value={model.month ?? 0}
                      disabled={disabled}
                      onChange={(event) => {
                        const raw = Number(event.currentTarget.value);
                        patch({ month: raw === 0 ? null : raw });
                      }}
                    >
                      <option value={0}>every month</option>
                      {MONTH_LABELS.map((name, index) => (
                        <option key={name} value={index + 1}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </span>
                ) : null}
              </div>
            </div>

            <div className="cron-result">
              <span className="cron-result__label">Expression</span>
              <code className="cron-result__value">{serializeCron(model)}</code>
              <button
                type="button"
                className="cron-result__copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(serializeCron(model));
                }}
                disabled={disabled}
                title="Copy expression"
              >
                Copy
              </button>
            </div>
          </div>
        ) : (
          <div className="cron-builder cron-builder--raw-only">
            <p className="cron-builder__note">
              {isMacro ? (
                <>
                  Editing a macro. Switch to <strong>Expression</strong> to change it, or pick a
                  preset to build an equivalent schedule.
                </>
              ) : (
                <>
                  This expression uses a shape the builder does not cover. Switch to{" "}
                  <strong>Expression</strong> to edit it as text — your value is preserved.
                </>
              )}
            </p>
            <code className="cron-result__value">{trimmed}</code>
          </div>
        )
      ) : (
        /* ---------------- raw mode ---------------- */
        <div className="cron-raw">
          <input
            className="input input--mono"
            type="text"
            value={value}
            placeholder="0 9 * * 1-5, or @daily"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            aria-invalid={hasError || undefined}
            aria-describedby={summaryId}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          <p className="cron-raw__help">
            minute hour day-of-month month day-of-week · timezone <code>{timezone}</code>
          </p>
        </div>
      )}

      {hasError ? <p className="field__error">{errors.join(" · ")}</p> : null}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* pieces                                                             */
/* ------------------------------------------------------------------ */

interface RepeatRowProps {
  label: string;
  mode: string;
  modes: { value: string; label: string }[];
  onMode: (next: string) => void;
  disabled: boolean;
  children?: React.ReactNode;
}

function RepeatRow({ label, mode, modes, onMode, disabled, children }: RepeatRowProps) {
  return (
    <div className="cron-row">
      <span className="cron-row__label">{label}</span>
      <div className="cron-row__body">
        <div className="chips" role="group" aria-label={label}>
          {modes.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`chip${mode === option.value ? " chip--active" : ""}`}
              onClick={() => onMode(option.value)}
              disabled={disabled}
            >
              {option.label}
            </button>
          ))}
        </div>
        {children ? <div className="cron-row__extra">{children}</div> : null}
      </div>
    </div>
  );
}

interface NumberInputProps {
  ariaLabel: string;
  min: number;
  max: number;
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
}

function NumberInput({ ariaLabel, min, max, value, disabled, onChange }: NumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(Math.max(parsed, min), max);
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <input
      className="input input--num cron-num"
      type="number"
      aria-label={ariaLabel}
      min={min}
      max={max}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
      }}
    />
  );
}

interface HourPickerProps {
  hours: number[];
  disabled: boolean;
  onChange: (hours: number[]) => void;
}

/** Compact 24-cell hour grid; empty selection reads as "every hour". */
function HourPicker({ hours, disabled, onChange }: HourPickerProps) {
  const selected = new Set(hours);
  const toggle = (hour: number) => {
    const next = new Set(selected);
    if (next.has(hour)) next.delete(hour);
    else next.add(hour);
    onChange([...next].sort((a, b) => a - b));
  };

  return (
    <div className="hour-grid" role="group" aria-label="Hours of the day">
      {Array.from({ length: 24 }, (_, hour) => (
        <button
          key={hour}
          type="button"
          className={`hour-cell${selected.has(hour) ? " hour-cell--active" : ""}`}
          onClick={() => toggle(hour)}
          disabled={disabled}
          aria-pressed={selected.has(hour)}
          title={`${String(hour).padStart(2, "0")}:00`}
        >
          {String(hour).padStart(2, "0")}
        </button>
      ))}
    </div>
  );
}

/** `@daily` & co. are single tokens; explain them without a server round-trip. */
function macroSummary(expr: string): string {
  switch (expr.toLowerCase()) {
    case "@hourly":
      return "Every hour, on the hour";
    case "@daily":
    case "@midnight":
    case "@reboot":
      return "Every day at midnight";
    case "@weekly":
      return "Every Sunday at midnight";
    case "@monthly":
      return "1st of every month at midnight";
    case "@yearly":
    case "@annually":
      return "1st of January at midnight";
    default:
      return expr === "" ? "No schedule yet" : `Macro ${expr}`;
  }
}
