/**
 * Cron / interval parsing + human-readable descriptions.
 *
 * Wraps `croner@9` (contract §3: never hand-roll a cron parser). Everything here
 * is pure: no clocks are read, `after` is always passed in explicitly so callers
 * can test with fixed timestamps.
 */

import { Cron } from "croner";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export interface ParsedSchedule {
  /** Normalised cron expression (whitespace collapsed, macro kept verbatim). */
  cron: string;
  everyMs: null;
  timezone: string;
}

export interface ParsedInterval {
  cron: null;
  everyMs: number;
  timezone: string;
}

export type ParsedScheduleLike = ParsedSchedule | ParsedInterval;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

const NUMERIC = /^\d+$/;
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Cap on candidates inspected by `nextCronFires` (contract: at most 1000 scans). */
const MAX_SCAN = 1000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Collapse runs of whitespace and trim. */
function collapse(value: string): string {
  return value.trim().split(/\s+/).join(" ");
}

function fail(...errors: string[]): { ok: false; errors: string[] } {
  return { ok: false, errors };
}

/* ------------------------------------------------------------------ */
/* Timezone                                                           */
/* ------------------------------------------------------------------ */

/** True when `Intl` recognises `tz` as an IANA timezone. */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string") return false;
  const value = tz.trim();
  if (value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* parseCron                                                          */
/* ------------------------------------------------------------------ */

/**
 * Macros croner does not know but that are conventional cron vocabulary.
 * Values are 5-field equivalents.
 */
const MACRO_ALIASES: Record<string, string> = {
  "@midnight": "0 0 * * *",
  "@reboot": "0 0 * * *",
};

/**
 * Expand a macro the underlying engine cannot parse. Unknown macros are passed
 * through unchanged so croner reports them.
 */
function expandMacro(expr: string): string {
  return MACRO_ALIASES[expr.toLowerCase()] ?? expr;
}

/**
 * Validate a cron expression for a timezone.
 *
 * Accepts 5-field (`m h dom mon dow`), 6-field (`s m h dom mon dow`) and macros
 * (`@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`, `@annually`).
 *
 * `@midnight` is a conventional cron macro that croner@9 does not implement, so
 * it is expanded here before validation. Same for anything else in MACRO_ALIASES.
 */
export function parseCron(
  expr: string,
  timezone: string,
): { ok: true; value: { cron: string; timezone: string } } | { ok: false; errors: string[] } {
  if (typeof expr !== "string") return fail("cron must be a string");
  const cron = collapse(expr);
  if (cron === "") return fail("cron must not be empty");

  if (typeof timezone !== "string" || !isValidTimezone(timezone)) {
    return fail(`Invalid timezone "${String(timezone)}"`);
  }

  // Reject things croner would happily accept but that are not cron patterns
  // (croner also parses ISO date strings as "run once" patterns).
  if (!cron.startsWith("@")) {
    const fields = cron.split(" ");
    if (fields.length !== 5 && fields.length !== 6) {
      return fail(
        `Invalid cron expression "${cron}": expected 5 or 6 space-separated fields, or a macro like @daily`,
      );
    }
  }

  const expanded = expandMacro(cron);

  try {
    // Construction validates the pattern (and the timezone) without scheduling.
    new Cron(expanded, { paused: true, timezone }).stop();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Invalid cron expression "${cron}": ${message}`);
  }

  return { ok: true, value: { cron: expanded, timezone } };
}

/* ------------------------------------------------------------------ */
/* parseInterval                                                      */
/* ------------------------------------------------------------------ */

const INTERVAL_RE = /^(\d+)\s*([smhd])$/;

/** Parse `30s` / `15m` / `2h` / `1d` (space between number and unit optional). */
export function parseInterval(
  input: string,
): { ok: true; everyMs: number } | { ok: false; errors: string[] } {
  if (typeof input !== "string") return fail("every must be a string");
  const raw = input.trim();
  if (raw === "") return fail("every must not be empty");

  const match = INTERVAL_RE.exec(raw.toLowerCase());
  if (!match) {
    return fail(
      `Invalid interval "${raw}": expected <number><s|m|h|d>, e.g. 30s, 15m, 2h, 1d`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const unitMs =
    unit === "s" ? 1000 : unit === "m" ? MINUTE_MS : unit === "h" ? HOUR_MS : DAY_MS;
  const everyMs = amount * unitMs;

  if (!Number.isFinite(everyMs) || everyMs < 1000) {
    return fail(`Invalid interval "${raw}": must be at least 1s`);
  }

  return { ok: true, everyMs };
}

/* ------------------------------------------------------------------ */
/* describeCron                                                       */
/* ------------------------------------------------------------------ */

/** Expand a day-of-week field (`*` returns null → "any day"). */
function expandDow(field: string): number[] | null {
  const days = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return null;
    const startRaw = Number(match[1]);
    const endRaw = match[2] === undefined ? startRaw : Number(match[2]);
    if (startRaw > 7 || endRaw > 7) return null;
    // 0 and 7 both mean Sunday.
    const start = startRaw === 7 ? 0 : startRaw;
    const end = endRaw === 7 ? 0 : endRaw;
    if (start <= end) {
      for (let day = start; day <= end; day += 1) days.add(day);
    } else {
      for (let day = start; day <= 6; day += 1) days.add(day);
      for (let day = 0; day <= end; day += 1) days.add(day);
    }
  }
  if (days.size === 0) return null;
  return [...days].sort((a, b) => a - b);
}

function describeDow(dowSet: number[], time: string): string {
  if (dowSet.length === 7) return `Every day at ${time}`;
  const isWeekdays = dowSet.length === 5 && dowSet.every((day, index) => day === index + 1);
  if (isWeekdays) return `Every weekday at ${time}`;
  const names = dowSet.map((day) => DOW_NAMES[day] ?? "?").join(", ");
  return `Every ${names} at ${time}`;
}

/** Describe a normalised 5-field pattern, or null when the shape is unsupported. */
function describeFiveFields(min: string, hour: string, dom: string, mon: string, dow: string): string | null {
  // --- minute-level patterns: "* * * * *"-ish hour/day -----------------
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const step = /^\*\/(\d+)$/.exec(min);
    if (step) {
      const minutes = Number(step[1]);
      if (minutes === 1) return "Every minute";
      if (minutes >= 2 && minutes <= 59) return `Every ${minutes} minutes`;
      return null;
    }
    if (min === "0") return "Every hour, on the hour";
    if (NUMERIC.test(min) && Number(min) <= 59) return `Every hour at minute ${Number(min)}`;
    return null;
  }

  // --- everything below needs a fixed minute + fixed hour ---------------
  if (!NUMERIC.test(min) || Number(min) > 59) return null;
  if (!NUMERIC.test(hour) || Number(hour) > 23) return null;
  const minutes = Number(min);
  const hours = Number(hour);
  const time = `${pad2(hours)}:${pad2(minutes)}`;

  if (dom === "*" && mon === "*") {
    if (dow === "*") {
      return hours === 0 && minutes === 0 ? "Every day at midnight" : `Every day at ${time}`;
    }
    const dowSet = expandDow(dow);
    if (!dowSet) return null;
    if (dowSet.length === 7 && hours === 0 && minutes === 0) return "Every day at midnight";
    return describeDow(dowSet, time);
  }

  // --- monthly: "M H D * *" --------------------------------------------
  if (dow === "*" && mon === "*" && NUMERIC.test(dom)) {
    const day = Number(dom);
    if (day >= 1 && day <= 31) return `Every month on day ${day} at ${time}`;
  }

  return null;
}

/** Map a (possibly 6-field) normalised pattern to 5 fields, if possible. */
function toFiveFields(pattern: string): string[] | null {
  const parts = pattern.split(" ");
  if (parts.length === 5) return parts;
  // 6-field with a zero seconds field is the same schedule as its 5-field form.
  if (parts.length === 6 && parts[0] === "0") return parts.slice(1);
  return null;
}

/**
 * Human-readable description, without a timezone suffix
 * (callers append ` (Asia/Shanghai)` themselves).
 *
 * Invalid expressions (bad pattern or bad timezone) are returned verbatim;
 * valid-but-unsupported shapes fall back to `Cron: <expr>`, echoed exactly as
 * the caller wrote it (so `@yearly` stays `@yearly`, not its expansion).
 */
export function describeCron(expr: string, timezone: string): string {
  const parsed = parseCron(expr, timezone);
  if (!parsed.ok) return typeof expr === "string" ? expr : String(expr);

  const original = parsed.value.cron;
  let pattern = original;
  // Macros (@daily …) expand to their 5-field equivalent.
  try {
    const expanded = new Cron(pattern, { paused: true, timezone }).getPattern();
    if (typeof expanded === "string" && expanded !== "") pattern = collapse(expanded);
  } catch {
    // keep the original pattern; the fallback below still renders it
  }

  const fields = toFiveFields(pattern);
  if (fields) {
    const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
    const described = describeFiveFields(min, hour, dom, mon, dow);
    if (described) return described;
  }

  return `Cron: ${original}`;
}

/* ------------------------------------------------------------------ */
/* nextCronFires                                                      */
/* ------------------------------------------------------------------ */

/**
 * Next `count` fire times strictly after `after` (epoch ms, ascending).
 * Scans at most 1000 candidates; returns [] for invalid input.
 */
export function nextCronFires(
  expr: string,
  timezone: string,
  after: number,
  count: number,
): number[] {
  if (!Number.isFinite(after)) return [];
  const wanted = Math.floor(count);
  if (!Number.isFinite(wanted) || wanted <= 0) return [];

  const parsed = parseCron(expr, timezone);
  if (!parsed.ok) return [];

  const fires: number[] = [];
  try {
    const cron = new Cron(parsed.value.cron, { paused: true, timezone });
    let cursor = after;
    for (let scan = 0; scan < MAX_SCAN && fires.length < wanted; scan += 1) {
      const next = cron.nextRun(new Date(cursor));
      if (!next) break;
      const at = next.getTime();
      if (!Number.isFinite(at) || at <= cursor) break;
      fires.push(at);
      cursor = at;
    }
    cron.stop();
  } catch {
    return fires.length > 0 ? fires : [];
  }

  return fires;
}
