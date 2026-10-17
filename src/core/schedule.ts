/**
 * Schedule normalisation: turns a `CronTriggerConfig`-shaped input
 * (`{ cron? | every?, timezone? }`) into a `NormalizedSchedule`, and answers
 * "when does this fire next?" for the engine's tick loop.
 */

import type { CronTriggerConfig } from "../shared/types.ts";
import { describeCron, isValidTimezone, nextCronFires, parseCron, parseInterval } from "./cron.ts";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export interface NormalizedSchedule {
  kind: "cron" | "interval";
  /** Cron expression for `kind === "cron"`, else null. */
  expr: string | null;
  /** Interval in ms for `kind === "interval"`, else null. */
  everyMs: number | null;
  timezone: string;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedSchedule }
  | { ok: false; errors: string[] };

function fail(...errors: string[]): { ok: false; errors: string[] } {
  return { ok: false, errors };
}

/* ------------------------------------------------------------------ */
/* normalizeSchedule                                                  */
/* ------------------------------------------------------------------ */

/**
 * Normalise a raw trigger config.
 *
 * Accepts a bare cron string (`"0 9 * * 1-5"`, treated as `{ cron }`) or an
 * object shaped like `CronTriggerConfig`.
 */
export function normalizeSchedule(raw: unknown, defaultTimezone: string): NormalizeResult {
  let cron: unknown;
  let every: unknown;
  let timezone: unknown;

  if (typeof raw === "string") {
    cron = raw;
  } else if (raw !== null && typeof raw === "object") {
    const record = raw as Partial<CronTriggerConfig> & Record<string, unknown>;
    cron = record.cron;
    every = record.every;
    timezone = record.timezone;
  } else if (raw === undefined) {
    return fail("cron or every is required");
  } else {
    return fail("schedule must be an object with cron/every, or a cron string");
  }

  const hasCron = cron !== undefined && cron !== null;
  const hasEvery = every !== undefined && every !== null;

  if (hasCron && hasEvery) {
    return fail("cron and every are mutually exclusive");
  }
  if (!hasCron && !hasEvery) {
    return fail("cron or every is required");
  }

  // Resolve the timezone first: both branches need it.
  let tz = defaultTimezone;
  if (timezone !== undefined && timezone !== null) {
    if (typeof timezone !== "string" || timezone.trim() === "") {
      return fail("timezone must be a non-empty string");
    }
    if (!isValidTimezone(timezone)) {
      return fail(`Invalid timezone "${timezone}"`);
    }
    tz = timezone.trim();
  } else if (typeof defaultTimezone !== "string" || defaultTimezone.trim() === "") {
    return fail("timezone must be a non-empty string");
  } else {
    tz = defaultTimezone.trim();
  }

  if (hasCron) {
    if (typeof cron !== "string") return fail("cron must be a string");
    const parsed = parseCron(cron, tz);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    return {
      ok: true,
      value: { kind: "cron", expr: parsed.value.cron, everyMs: null, timezone: parsed.value.timezone },
    };
  }

  if (typeof every !== "string") return fail("every must be a string");
  const parsed = parseInterval(every);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return {
    ok: true,
    value: { kind: "interval", expr: null, everyMs: parsed.everyMs, timezone: tz },
  };
}

/* ------------------------------------------------------------------ */
/* nextFire                                                           */
/* ------------------------------------------------------------------ */

/**
 * Next fire time strictly after `after`, or null when it will never fire again.
 *
 * Intervals are anchored on `lastFire` when available. Without a previous fire
 * the schedule is aligned to the epoch grid (`after` rounded up to a multiple of
 * `everyMs`), so two callers agreeing on `after` always agree on the result.
 */
export function nextFire(
  schedule: NormalizedSchedule,
  after: number,
  lastFire: number | null,
): number | null {
  if (!Number.isFinite(after)) return null;

  if (schedule.kind === "interval") {
    const everyMs = schedule.everyMs;
    if (typeof everyMs !== "number" || !Number.isFinite(everyMs) || everyMs <= 0) return null;

    if (lastFire !== null && Number.isFinite(lastFire)) {
      let candidate = lastFire + everyMs;
      // Never hand back a time in the past: catch up by whole periods.
      if (candidate <= after) {
        const skipped = Math.floor((after - candidate) / everyMs) + 1;
        candidate += skipped * everyMs;
      }
      return candidate;
    }

    // No anchor: align to the epoch grid, strictly after `after`.
    const aligned = Math.ceil(after / everyMs) * everyMs;
    return aligned > after ? aligned : aligned + everyMs;
  }

  const expr = schedule.expr;
  if (typeof expr !== "string" || expr.trim() === "") return null;

  const [first] = nextCronFires(expr, schedule.timezone, after, 1);
  return typeof first === "number" ? first : null;
}

/* ------------------------------------------------------------------ */
/* describeSchedule                                                   */
/* ------------------------------------------------------------------ */

/** One-line human description, e.g. `Every 15 minutes` or `Cron: 0 9 * * 1-5 (Asia/Shanghai)`. */
export function describeSchedule(schedule: NormalizedSchedule): string {
  if (schedule.kind === "interval") {
    const everyMs = schedule.everyMs;
    if (typeof everyMs !== "number" || !Number.isFinite(everyMs) || everyMs <= 0) {
      return "Invalid interval";
    }
    if (everyMs % 86_400_000 === 0) {
      const days = everyMs / 86_400_000;
      return days === 1 ? "Every day" : `Every ${days} days`;
    }
    if (everyMs % 3_600_000 === 0) {
      const hours = everyMs / 3_600_000;
      return hours === 1 ? "Every hour" : `Every ${hours} hours`;
    }
    if (everyMs % 60_000 === 0) {
      const minutes = everyMs / 60_000;
      return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
    }
    if (everyMs % 1000 === 0) {
      const seconds = everyMs / 1000;
      return seconds === 1 ? "Every second" : `Every ${seconds} seconds`;
    }
    return `Every ${everyMs} ms`;
  }

  const expr = schedule.expr;
  if (typeof expr !== "string" || expr.trim() === "") return "Invalid schedule";

  // Invalid expressions come back verbatim from describeCron; surface them
  // untouched rather than dressing a parse error up as a schedule description.
  if (!parseCron(expr, schedule.timezone).ok) return expr.trim();

  const described = describeCron(expr, schedule.timezone);
  return `${described} (${schedule.timezone})`;
}
