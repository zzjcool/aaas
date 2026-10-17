export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Renders a busy state while the server round-trip is in flight. */
  busy?: boolean;
}

/**
 * Accessible switch (real checkbox + styled track). The label doubles as the
 * `aria-label`, so table rows stay compact without extra visible text.
 */
export function Toggle({ checked, onChange, label, disabled = false, busy = false }: ToggleProps) {
  const isDisabled = disabled || busy;
  return (
    <label className={`toggle${isDisabled ? " toggle--disabled" : ""}`} title={label}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={isDisabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
      {busy ? <span className="toggle__spinner" aria-hidden="true" /> : null}
    </label>
  );
}
