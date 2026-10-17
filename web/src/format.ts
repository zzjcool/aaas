import type { RunStatus } from "./types.ts";

/**
 * All time rendering goes through this module (task requirement: "时间渲染统一走 format.ts").
 *
 * Backend timestamps are epoch milliseconds; every helper here renders in the
 * *browser's* local timezone unless an explicit `timeZone` is passed.
 */

const LOCALE = undefined; // browser default locale

const DATE_TIME = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const DATE_TIME_SHORT = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const TIME_ONLY = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const CLOCK = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export const LOCAL_TIMEZONE: string = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** `2025-03-04 09:00:12` in the browser timezone (or `timeZone`). */
export function formatTime(epochMs: number | null | undefined, timeZone?: string): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return "—";
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "—";
  if (timeZone && timeZone !== LOCAL_TIMEZONE) {
    try {
      return new Intl.DateTimeFormat(LOCALE, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone,
      }).format(date);
    } catch {
      /* unknown IANA zone → fall through to local */
    }
  }
  return DATE_TIME.format(date);
}

/** Compact variant for dense tables: `Mar 04, 09:00:12`. */
export function formatTimeShort(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return "—";
  return DATE_TIME_SHORT.format(new Date(epochMs));
}

/** `09:00:12` — time of day only. */
export function formatClock(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return "—";
  return TIME_ONLY.format(new Date(epochMs));
}

/** Current wall clock for the top bar: `HH:MM:SS`. */
export function formatNow(epochMs: number): string {
  return CLOCK.format(new Date(epochMs));
}

/** `+03:00` offset label for a timezone, useful in the preview header. */
export function formatZoneLabel(timeZone: string, at: number = Date.now()): string {
  try {
    const parts = new Intl.DateTimeFormat(LOCALE, {
      timeZone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date(at));
    const offset = parts.find((p) => p.type === "timeZoneName")?.value;
    return offset ? `${timeZone} (${offset})` : timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * Signed relative label in the `in 3h 12m` / `3h 12m ago` form — the two
 * coarsest units only, so table cells stay narrow.
 *
 * `now` is injectable so a table can share one tick across all its rows.
 */
export function formatRelative(target: number | null | undefined, now: number = Date.now()): string {
  if (target === null || target === undefined || !Number.isFinite(target)) return "—";
  const delta = target - now;
  const magnitude = formatDelta(Math.abs(delta));
  return delta >= 0 ? `in ${magnitude}` : `${magnitude} ago`;
}

/** Future-only relative label used by the "Next fire" column. */
export function formatRelativeFuture(target: number | null | undefined, now: number = Date.now()): string {
  if (target === null || target === undefined || !Number.isFinite(target)) return "—";
  if (target <= now) return "due now";
  return `in ${formatDelta(target - now)}`;
}

/** Past-only relative label for "Last run". */
export function formatRelativePast(target: number | null | undefined, now: number = Date.now()): string {
  if (target === null || target === undefined || !Number.isFinite(target)) return "—";
  if (target >= now) return "now";
  return `${formatDelta(now - target)} ago`;
}

/** `312000` → `5m 12s`. Two coarsest non-zero units, space separated. */
function formatDelta(absMs: number): string {
  const d = Math.floor(absMs / (24 * 3600_000));
  const h = Math.floor((absMs % (24 * 3600_000)) / 3600_000);
  const m = Math.floor((absMs % 3600_000) / 60_000);
  const s = Math.floor((absMs % 60_000) / 1000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Compact duration: `1.2s`, `3m 04s`, `1h 12m`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(totalSeconds < 10 ? 2 : 1)}s`;
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Live duration between `startedAt` and now/finishedAt. */
export function durationBetween(start: number | null, end: number | null, now: number = Date.now()): number | null {
  if (start === null) return null;
  return Math.max(0, (end ?? now) - start);
}

/** `1_234_567` → `1.23M` (token counts). */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** USD cost with sensible precision for sub-cent amounts. */
export function formatCost(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export type StatusTone = "muted" | "accent" | "success" | "warn" | "danger";

/**
 * Colour tone for a run status. Used by `StatusBadge` and any inline dot;
 * keeps the palette mapping in one place.
 */
export function statusColor(status: RunStatus | string | null | undefined): StatusTone {
  switch (status) {
    case "succeeded":
      return "success";
    case "running":
      return "accent";
    case "queued":
      return "muted";
    case "failed":
      return "danger";
    case "timeout":
      return "warn";
    case "cancelled":
      return "warn";
    case "skipped":
      return "muted";
    default:
      return "muted";
  }
}

/** Human labels for statuses (title-cased, plus a couple of aliases). */
export function statusLabel(status: RunStatus | string | null | undefined): string {
  if (!status) return "—";
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "running":
      return "running";
    case "queued":
      return "queued";
    case "failed":
      return "failed";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return status;
  }
}

/** Truncate for table cells; the full text goes in `title`. */
export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "—";
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, Math.max(0, max - 1))}…`;
}
