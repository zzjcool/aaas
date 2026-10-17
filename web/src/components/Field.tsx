import type { ReactNode } from "react";
import type { FieldSchema } from "../types.ts";

/**
 * The JSON scalar shapes a plugin config field can hold. `undefined` means
 * "unset" so the server-side default applies.
 */
export type FieldValue = string | number | boolean | string[] | undefined;

export interface FieldProps {
  schema: FieldSchema;
  value: FieldValue;
  onChange: (next: FieldValue) => void;
  /** Validation messages rendered under the control (e.g. from a 422). */
  errors?: string[];
  disabled?: boolean;
  /** Namespace for DOM ids so two plugins with the same key stay unique. */
  idPrefix?: string;
  /**
   * Optional replacement for the scalar control, used for `schema.format`
   * hints (a cron builder is much more usable than a text box). The wrapper —
   * label, help text, error slot — stays the same, so layout is unaffected.
   */
  renderCustom?: () => ReactNode;
}

/**
 * Renders one `FieldSchema` (contract §2 "Minimal JSON-schema subset").
 *
 * Deliberately schema-driven: the trigger and agent panels never hard-code
 * field names, so a new plugin's descriptor renders without UI changes.
 */
export function Field({
  schema,
  value,
  onChange,
  errors = [],
  disabled = false,
  idPrefix = "",
  renderCustom,
}: FieldProps) {
  const id = `${idPrefix}${schema.key}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const hasError = errors.length > 0;
  const describedBy = [schema.help ? helpId : null, hasError ? errorId : null].filter(Boolean).join(" ");

  const common = {
    id,
    disabled,
    "aria-invalid": hasError || undefined,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
  };

  const control = renderCustom
    ? renderCustom()
    : renderControl({ schema, value, onChange, common });

  return (
    <div className={`field${hasError ? " field--error" : ""}`}>
      <label className="field__label" htmlFor={renderCustom ? undefined : id}>
        <span>{schema.label || schema.key}</span>
        {schema.required ? <span className="field__required" title="Required">*</span> : null}
        <code className="field__key">{schema.key}</code>
      </label>
      {control}
      {schema.help ? (
        <p className="field__help" id={helpId}>
          {schema.help}
        </p>
      ) : null}
      {hasError ? (
        <p className="field__error" id={errorId}>
          {errors.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

interface ControlArgs {
  schema: FieldSchema;
  value: FieldValue;
  onChange: (next: FieldValue) => void;
  common: {
    id: string;
    disabled: boolean;
    "aria-invalid"?: true;
    "aria-describedby"?: string;
  };
}

function renderControl({ schema, value, onChange, common }: ControlArgs) {
  const defaultPlaceholder =
    schema.default === undefined ? "" : String(schema.default);

  switch (schema.type) {
    case "boolean":
      return (
        <div className="field__switch">
          <input
            {...common}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
          <span className="field__switch-text">{value === true ? "enabled" : "disabled"}</span>
        </div>
      );

    case "number":
      return (
        <input
          {...common}
          className="input input--num"
          type="number"
          value={typeof value === "number" && Number.isFinite(value) ? String(value) : ""}
          placeholder={schema.placeholder ?? defaultPlaceholder}
          min={schema.min}
          max={schema.max}
          step={schema.min !== undefined && !Number.isInteger(schema.min) ? "any" : "1"}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            if (raw.trim() === "") {
              onChange(undefined);
              return;
            }
            const parsed = Number(raw);
            onChange(Number.isFinite(parsed) ? parsed : undefined);
          }}
        />
      );

    case "select": {
      const options = schema.options ?? [];
      const current = value === undefined || value === null ? "" : String(value);
      const known = options.some((o) => o.value === current);
      const showUnknown = !known && current !== "";
      return (
        <select
          {...common}
          className="input input--select"
          value={known ? current : ""}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            onChange(raw === "" ? undefined : raw);
          }}
        >
          {schema.required ? null : <option value="">— default —</option>}
          {showUnknown ? <option value={current}>{current} (unknown)</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }

    case "textarea":
      return (
        <textarea
          {...common}
          className="input input--area"
          rows={4}
          value={typeof value === "string" ? value : ""}
          placeholder={schema.placeholder ?? ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );

    case "string[]":
      return (
        <input
          {...common}
          className="input"
          type="text"
          value={Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : ""}
          placeholder={schema.placeholder ?? "comma separated"}
          onChange={(event) => {
            const items = event.currentTarget.value
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part.length > 0);
            onChange(items);
          }}
        />
      );

    case "string":
    default:
      return (
        <input
          {...common}
          className="input"
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder={schema.placeholder ?? ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
  }
}

/** Boundary parse for `FieldSchema.default` (typed `unknown` in the contract). */
function toFieldValue(raw: unknown): FieldValue {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw) && raw.every((item): item is string => typeof item === "string")) return raw;
  return undefined;
}

/** Coerce a `FieldSchema` into a sensible initial value (used when a type is picked). */
export function initialValueFor(schema: FieldSchema): FieldValue {
  if (schema.default !== undefined) {
    const parsed = toFieldValue(schema.default);
    if (parsed !== undefined) return parsed;
  }
  switch (schema.type) {
    case "boolean":
      return false;
    case "string[]":
      return [];
    default:
      return undefined;
  }
}
