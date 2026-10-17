import test from "node:test";
import assert from "node:assert/strict";

import { describeSchedule, nextFire, normalizeSchedule, type NormalizedSchedule } from "./schedule.ts";

/* Fixed timestamps — never Date.now(), so assertions are deterministic. */
const TZ = "Asia/Shanghai";
const UTC = "UTC";

/** 2024-01-01T00:00:00.000Z — Monday 08:00 Asia/Shanghai. */
const T_MON_00_UTC = 1_704_067_200_000;
/** 2024-01-01T01:00:00.000Z — Monday 09:00 Asia/Shanghai. */
const T_MON_09_SH = 1_704_070_800_000;

const MIN = 60_000;
const HOUR = 3_600_000;

function okSchedule(raw: unknown, tz: string = TZ): NormalizedSchedule {
  const result = normalizeSchedule(raw, tz);
  assert.equal(result.ok, true, `expected ok for ${JSON.stringify(raw)}: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function errorsOf(raw: unknown, tz: string = TZ): string[] {
  const result = normalizeSchedule(raw, tz);
  assert.equal(result.ok, false, `expected failure for ${JSON.stringify(raw)}`);
  if (result.ok) throw new Error("unreachable");
  return result.errors;
}

/* ------------------------------------------------------------------ */
/* normalizeSchedule — happy paths                                    */
/* ------------------------------------------------------------------ */

test("normalizeSchedule: cron object", () => {
  assert.deepEqual(okSchedule({ type: "cron", cron: "0 9 * * 1-5" }), {
    kind: "cron",
    expr: "0 9 * * 1-5",
    everyMs: null,
    timezone: TZ,
  });
});

test("normalizeSchedule: 6-field cron and macros", () => {
  assert.equal(okSchedule({ cron: "*/10 * * * * *" }).expr, "*/10 * * * * *");
  assert.equal(okSchedule({ cron: "@daily" }).expr, "@daily");
});

test("normalizeSchedule: cron expression is whitespace-normalised", () => {
  assert.equal(okSchedule({ cron: "  0   9  * *  * " }).expr, "0 9 * * *");
});

test("normalizeSchedule: explicit timezone wins over the default", () => {
  assert.equal(okSchedule({ cron: "0 9 * * *", timezone: UTC }).timezone, UTC);
});

test("normalizeSchedule: every interval", () => {
  assert.deepEqual(okSchedule({ every: "15m" }), {
    kind: "interval",
    expr: null,
    everyMs: 15 * MIN,
    timezone: TZ,
  });
  assert.equal(okSchedule({ every: "30s" }).everyMs, 30_000);
  assert.equal(okSchedule({ every: "2h" }).everyMs, 2 * HOUR);
  assert.equal(okSchedule({ every: "1d" }).everyMs, 24 * HOUR);
  assert.equal(okSchedule({ every: "90s" }).everyMs, 90_000);
});

test("normalizeSchedule: a bare string is treated as a cron expression", () => {
  assert.deepEqual(okSchedule("0 9 * * *"), {
    kind: "cron",
    expr: "0 9 * * *",
    everyMs: null,
    timezone: TZ,
  });
});

/* ------------------------------------------------------------------ */
/* normalizeSchedule — errors                                         */
/* ------------------------------------------------------------------ */

test("normalizeSchedule: cron and every are mutually exclusive", () => {
  assert.deepEqual(errorsOf({ cron: "0 9 * * *", every: "15m" }), [
    "cron and every are mutually exclusive",
  ]);
});

test("normalizeSchedule: one of cron/every is required", () => {
  assert.deepEqual(errorsOf({ type: "cron" }), ["cron or every is required"]);
  assert.deepEqual(errorsOf({}), ["cron or every is required"]);
  assert.deepEqual(errorsOf({ cron: undefined, every: undefined }), ["cron or every is required"]);
  assert.deepEqual(errorsOf({ cron: null, every: null }), ["cron or every is required"]);
  assert.deepEqual(errorsOf(undefined), ["cron or every is required"]);
});

test("normalizeSchedule: blank and non-string cron", () => {
  assert.deepEqual(errorsOf({ cron: "   " }), ["cron must not be empty"]);
  assert.deepEqual(errorsOf({ cron: 42 }), ["cron must be a string"]);
  assert.deepEqual(errorsOf(""), ["cron must not be empty"]);
});

test("normalizeSchedule: invalid cron / every surface parser errors", () => {
  assert.match(errorsOf({ cron: "bad cron" })[0]!, /expected 5 or 6 space-separated fields/);
  assert.deepEqual(errorsOf({ every: "15x" }), [
    'Invalid interval "15x": expected <number><s|m|h|d>, e.g. 30s, 15m, 2h, 1d',
  ]);
  assert.deepEqual(errorsOf({ every: 15 }), ["every must be a string"]);
});

test("normalizeSchedule: invalid timezone", () => {
  assert.deepEqual(errorsOf({ cron: "0 9 * * *", timezone: "Invalid/Zone" }), [
    'Invalid timezone "Invalid/Zone"',
  ]);
  assert.deepEqual(errorsOf({ cron: "0 9 * * *", timezone: "" }), [
    "timezone must be a non-empty string",
  ]);
  assert.deepEqual(errorsOf({ cron: "0 9 * * *", timezone: 42 }), [
    "timezone must be a non-empty string",
  ]);
});

test("normalizeSchedule: non-object, non-string input", () => {
  assert.deepEqual(errorsOf(42), ["schedule must be an object with cron/every, or a cron string"]);
  assert.deepEqual(errorsOf(null), ["schedule must be an object with cron/every, or a cron string"]);
});

/* ------------------------------------------------------------------ */
/* nextFire — cron                                                    */
/* ------------------------------------------------------------------ */

const EVERY_15M: NormalizedSchedule = {
  kind: "interval",
  expr: null,
  everyMs: 15 * MIN,
  timezone: TZ,
};
const DAILY_9_SH: NormalizedSchedule = {
  kind: "cron",
  expr: "0 9 * * *",
  everyMs: null,
  timezone: TZ,
};

test("nextFire: cron returns the next 09:00 in the schedule timezone", () => {
  assert.equal(nextFire(DAILY_9_SH, T_MON_00_UTC, null), T_MON_09_SH);
});

test("nextFire: cron is strictly greater than 'after'", () => {
  // Exactly on a fire time → next day, not the same instant.
  assert.equal(nextFire(DAILY_9_SH, T_MON_09_SH, null), T_MON_09_SH + 24 * HOUR);
  assert.equal(nextFire(DAILY_9_SH, T_MON_09_SH - 1, null), T_MON_09_SH);
});

test("nextFire: cron is monotonically increasing across consecutive calls", () => {
  let cursor = T_MON_00_UTC;
  const seen: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const next = nextFire(EVERY_15M, cursor, null);
    assert.notEqual(next, null);
    seen.push(next!);
    cursor = next!;
  }
  assert.deepEqual(seen, [
    T_MON_00_UTC + 15 * MIN,
    T_MON_00_UTC + 30 * MIN,
    T_MON_00_UTC + 45 * MIN,
    T_MON_00_UTC + 60 * MIN,
    T_MON_00_UTC + 75 * MIN,
  ]);
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i]! > seen[i - 1]!);
});

test("nextFire: cron ignores lastFire (cron carries no anchor)", () => {
  assert.equal(nextFire(DAILY_9_SH, T_MON_00_UTC, T_MON_00_UTC - 7 * 24 * HOUR), T_MON_09_SH);
});

test("nextFire: never-firing cron returns null", () => {
  const never: NormalizedSchedule = {
    kind: "cron",
    expr: "0 0 30 2 *",
    everyMs: null,
    timezone: UTC,
  };
  assert.equal(nextFire(never, T_MON_00_UTC, null), null);
});

test("nextFire: malformed schedule returns null", () => {
  assert.equal(nextFire({ kind: "cron", expr: null, everyMs: null, timezone: UTC }, T_MON_00_UTC, null), null);
  assert.equal(nextFire({ kind: "interval", expr: null, everyMs: 0, timezone: UTC }, T_MON_00_UTC, null), null);
  assert.equal(nextFire(EVERY_15M, Number.NaN, null), null);
});

/* ------------------------------------------------------------------ */
/* nextFire — interval                                                */
/* ------------------------------------------------------------------ */

test("nextFire: interval anchors on lastFire", () => {
  const lastFire = T_MON_00_UTC;
  assert.equal(nextFire(EVERY_15M, lastFire, lastFire), lastFire + 15 * MIN);
});

test("nextFire: interval advances past 'after' when lastFire is stale", () => {
  const lastFire = T_MON_00_UTC;
  // 'after' is 40 minutes later → the first fires at 15/30/45 are already gone.
  const after = T_MON_00_UTC + 40 * MIN;
  assert.equal(nextFire(EVERY_15M, after, lastFire), T_MON_00_UTC + 45 * MIN);
});

test("nextFire: interval catch-up lands strictly after 'after'", () => {
  const lastFire = T_MON_00_UTC;
  const after = T_MON_00_UTC + 45 * MIN; // exactly on a fire time
  const next = nextFire(EVERY_15M, after, lastFire);
  assert.equal(next, T_MON_00_UTC + 60 * MIN);
  assert.ok(next! > after);
});

test("nextFire: interval without lastFire aligns to the epoch grid", () => {
  const after = T_MON_00_UTC + 7 * MIN + 123; // 00:07:00.123Z
  assert.equal(nextFire(EVERY_15M, after, null), T_MON_00_UTC + 15 * MIN);
});

test("nextFire: interval without lastFire on an exact boundary skips to the next slot", () => {
  const after = T_MON_00_UTC + 15 * MIN;
  assert.equal(nextFire(EVERY_15M, after, null), T_MON_00_UTC + 30 * MIN);
});

test("nextFire: interval results are strictly increasing across calls", () => {
  let cursor = T_MON_00_UTC + 3_000;
  let lastFire: number | null = null;
  const seen: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const next = nextFire(EVERY_15M, cursor, lastFire);
    assert.notEqual(next, null);
    seen.push(next!);
    lastFire = next!;
    cursor = next!;
  }
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i]! > seen[i - 1]!, `index ${i}`);
  // Offset by 3s from the grid: the first aligned fire is 00:15:00.000Z.
  assert.equal(seen[0], T_MON_00_UTC + 15 * MIN);
  assert.equal((seen[1] ?? 0) - (seen[0] ?? 0), 15 * MIN);
});

/* ------------------------------------------------------------------ */
/* describeSchedule                                                   */
/* ------------------------------------------------------------------ */

test("describeSchedule: interval units", () => {
  const at = (everyMs: number): string =>
    describeSchedule({ kind: "interval", expr: null, everyMs, timezone: TZ });
  assert.equal(at(15 * MIN), "Every 15 minutes");
  assert.equal(at(MIN), "Every minute");
  assert.equal(at(2 * HOUR), "Every 2 hours");
  assert.equal(at(HOUR), "Every hour");
  assert.equal(at(24 * HOUR), "Every day");
  assert.equal(at(3 * 24 * HOUR), "Every 3 days");
  assert.equal(at(30_000), "Every 30 seconds");
  assert.equal(at(1_000), "Every second");
  assert.equal(at(1_500), "Every 1500 ms");
  assert.equal(at(0), "Invalid interval");
});

test("describeSchedule: interval from normalizeSchedule round-trips", () => {
  assert.equal(describeSchedule(okSchedule({ every: "15m" })), "Every 15 minutes");
});

test("describeSchedule: cron appends the timezone", () => {
  assert.equal(describeSchedule(okSchedule({ cron: "0 9 * * 1-5" })), "Every weekday at 09:00 (Asia/Shanghai)");
  assert.equal(
    describeSchedule(okSchedule({ cron: "*/15 * * * *", timezone: UTC })),
    "Every 15 minutes (UTC)",
  );
  assert.equal(describeSchedule(okSchedule({ cron: "@daily" })), "Every day at midnight (Asia/Shanghai)");
});

test("describeSchedule: fallback shapes keep the 'Cron: <expr>' form plus timezone", () => {
  assert.equal(
    describeSchedule(okSchedule({ cron: "*/7 3 * * *" })),
    "Cron: */7 3 * * * (Asia/Shanghai)",
  );
});

test("describeSchedule: invalid cron is surfaced without a timezone suffix", () => {
  assert.equal(
    describeSchedule({ kind: "cron", expr: "garbage", everyMs: null, timezone: TZ }),
    "garbage",
  );
});

test("describeSchedule: blank cron schedule", () => {
  assert.equal(
    describeSchedule({ kind: "cron", expr: null, everyMs: null, timezone: TZ }),
    "Invalid schedule",
  );
  assert.equal(
    describeSchedule({ kind: "cron", expr: "   ", everyMs: null, timezone: TZ }),
    "Invalid schedule",
  );
});
