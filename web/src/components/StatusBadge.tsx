import { statusColor, statusLabel } from "../format.ts";
import type { RunStatus } from "../types.ts";

export interface StatusBadgeProps {
  status: RunStatus | string | null | undefined;
  /** Slightly smaller variant for dense tables. */
  small?: boolean;
  /** Append a pulsing dot (used for live rows). */
  pulse?: boolean;
}

/** Colour-coded pill for `RunStatus`; tone mapping lives in `format.ts`. */
export function StatusBadge({ status, small = false, pulse = false }: StatusBadgeProps) {
  const tone = statusColor(status);
  return (
    <span className={`badge badge--${tone}${small ? " badge--sm" : ""}`}>
      {pulse ? <span className={`dot dot--${tone} dot--pulse`} aria-hidden="true" /> : null}
      {statusLabel(status)}
    </span>
  );
}
