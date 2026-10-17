import test from "node:test";
import assert from "node:assert/strict";

import {
  describeCron,
  isValidTimezone,
  nextCronFires,
  parseCron,
  parseInterval,
} from "./cron.ts";

/* Fixed timestamps — never Date.now(), so assertions are deterministic. */
const TZ = "Asia/Shanghai";
const UTC = "UTC";

/** 2024-01-01T00:00:00.000Z (Monday 08:00 in Asia/Shanghai). */
const T_MON_00_UTC = 1_704_067_200_000;
/** 2024-01-01T01:00:00.000Z == Monday 09:00 Asia/Shanghai. */
const T_MON_09_SH = 1_704_070_800_000;
/** 2024-01-06T00:00:00.000Z == Saturday 08:00 Asia/Shanghai. */
const T_SAT_00_UTC = 1_704_499_200_000;

/* ------------------------------------------------------------------ */
/* parseCron                                                          */
/* ------------------------------------------------------------------ */

test("parseCron accepts a 5-field expression", () => {
  const result = parseCron("0 9 * * 1-5", TZ);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, { cron: "0 9 * * 1-5", timezone: TZ });
});

test("parseCron accepts a 6-field expression", () => {
  const result = parseCron("*/10 * * * * *", UTC);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, { cron: "*/10 * * * * *", timezone: UTC });
});

test("parseCron accepts macros", () => {
  for (const macro of ["@hourly", "@daily", "@weekly", "@monthly", "@yearly", "@annually"]) {
    const result = parseCron(macro, TZ);
    assert.equal(result.ok, true, `${macro} should parse`);
  }
});

test("parseCron expands @midnight, which croner does not implement", () => {
  const result = parseCron("@midnight", TZ);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.cron, "0 0 * * *", "must expand to the engine-compatible form");
  // Same fires as @daily.
  const midnight = nextCronFires("@midnight", TZ, 1_700_000_000_000, 3);
  const daily = nextCronFires("@daily", TZ, 1_700_000_000_000, 3);
  assert.deepEqual(midnight, daily);
});

test("parseCron rejects unknown macros instead of silently accepting them", () => {
  const result = parseCron("@nonsense", TZ);
  assert.equal(result.ok, false);
});

test("describeCron renders @midnight like @daily", () => {
  assert.equal(describeCron("@midnight", TZ), "Every day at midnight");
});

test("parseCron collapses surrounding and repeated whitespace", () => {
  const result = parseCron("  0   9  *  *  *  ", TZ);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.cron, "0 9 * * *");
});

test("parseCron rejects an empty expression", () => {
  const result = parseCron("   ", TZ);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors, ["cron must not be empty"]);
});

test("parseCron rejects a non-string expression", () => {
  // @ts-expect-error — runtime guard for untyped (YAML/JSON) input
  const result = parseCron(42, TZ);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors, ["cron must be a string"]);
});

test("parseCron rejects wrong field counts", () => {
  for (const expr of ["0 9 * *", "0 9 * * * * *", "bad expr"]) {
    const result = parseCron(expr, TZ);
    assert.equal(result.ok, false, `${expr} should be rejected`);
    if (result.ok) return;
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? "", /expected 5 or 6 space-separated fields/);
  }
});

test("parseCron rejects out-of-range field values", () => {
  const result = parseCron("60 * * * *", TZ);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.errors[0] ?? "", /Invalid cron expression "60 \* \* \* \*"/);
});

test("parseCron rejects an ISO date string (croner would treat it as run-once)", () => {
  const result = parseCron("2024-01-01T00:00:00Z", TZ);
  assert.equal(result.ok, false);
});

test("parseCron rejects an invalid timezone", () => {
  const result = parseCron("0 9 * * *", "Invalid/Zone");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors, ['Invalid timezone "Invalid/Zone"']);
});

/* ------------------------------------------------------------------ */
/* parseInterval                                                      */
/* ------------------------------------------------------------------ */

test("parseInterval converts every supported unit", () => {
  const cases: [string, number][] = [
    ["1s", 1_000],
    ["30s", 30_000],
    ["90s", 90_000],
    ["15m", 900_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
  ];
  for (const [input, expected] of cases) {
    const result = parseInterval(input);
    assert.equal(result.ok, true, `${input} should parse`);
    if (!result.ok) continue;
    assert.equal(result.everyMs, expected);
  }
});

test("parseInterval tolerates spaces and mixed case", () => {
  for (const input of [" 15 m ", "15m", "15 M", "15\tm"]) {
    const result = parseInterval(input);
    assert.equal(result.ok, true, `${JSON.stringify(input)} should parse`);
    if (!result.ok) continue;
    assert.equal(result.everyMs, 900_000);
  }
});

test("parseInterval enforces the 1s minimum", () => {
  const result = parseInterval("0s");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors, ['Invalid interval "0s": must be at least 1s']);

  const ok = parseInterval("1s");
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.everyMs, 1_000);
});

test("parseInterval rejects malformed input", () => {
  for (const input of ["", "   ", "15", "m", "15x", "500ms", "-5m", "1.5h", "1h30m"]) {
    const result = parseInterval(input);
    assert.equal(result.ok, false, JSON.stringify(input));
  }
});

test("parseInterval rejects non-string input", () => {
  // @ts-expect-error — runtime guard for untyped input
  const result = parseInterval(15);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors, ["every must be a string"]);
});

/* ------------------------------------------------------------------ */
/* isValidTimezone                                                    */
/* ------------------------------------------------------------------ */

test("isValidTimezone recognises IANA names", () => {
  assert.equal(isValidTimezone("Asia/Shanghai"), true);
  assert.equal(isValidTimezone("Europe/London"), true);
  assert.equal(isValidTimezone("UTC"), true);
});

test("isValidTimezone rejects unknown, empty and non-string values", () => {
  assert.equal(isValidTimezone("Invalid/Zone"), false);
  assert.equal(isValidTimezone("Asia/Shang"), false);
  assert.equal(isValidTimezone(""), false);
  assert.equal(isValidTimezone("   "), false);
  // @ts-expect-error — runtime guard for untyped input
  assert.equal(isValidTimezone(undefined), false);
});

/* ------------------------------------------------------------------ */
/* describeCron                                                       */
/* ------------------------------------------------------------------ */

test("describeCron: every N minutes", () => {
  assert.equal(describeCron("*/5 * * * *", TZ), "Every 5 minutes");
  assert.equal(describeCron("*/15 * * * *", TZ), "Every 15 minutes");
  assert.equal(describeCron("*/1 * * * *", TZ), "Every minute");
});

test("describeCron: hourly shapes", () => {
  assert.equal(describeCron("0 * * * *", TZ), "Every hour, on the hour");
  assert.equal(describeCron("7 * * * *", TZ), "Every hour at minute 7");
  assert.equal(describeCron("45 * * * *", TZ), "Every hour at minute 45");
});

test("describeCron: daily shapes", () => {
  assert.equal(describeCron("0 0 * * *", TZ), "Every day at midnight");
  assert.equal(describeCron("0 9 * * *", TZ), "Every day at 09:00");
  assert.equal(describeCron("30 18 * * *", TZ), "Every day at 18:30");
});

test("describeCron: weekday shape", () => {
  assert.equal(describeCron("0 9 * * 1-5", TZ), "Every weekday at 09:00");
  assert.equal(describeCron("0 9 * * 1-5", UTC), "Every weekday at 09:00");
  assert.equal(describeCron("0 0 9 * * 1-5", TZ), "Every weekday at 09:00"); // 6-field
});

test("describeCron: explicit day-of-week lists", () => {
  assert.equal(describeCron("0 9 * * 1,3,5", TZ), "Every Mon, Wed, Fri at 09:00");
  assert.equal(describeCron("0 9 * * 2", TZ), "Every Tue at 09:00");
  assert.equal(describeCron("0 9 * * 0-6", TZ), "Every day at 09:00");
});

test("describeCron: Sunday is both 0 and 7", () => {
  assert.equal(describeCron("0 9 * * 0", TZ), "Every Sun at 09:00");
  assert.equal(describeCron("0 9 * * 7", TZ), "Every Sun at 09:00");
  assert.equal(describeCron("0 0 * * 0", TZ), "Every Sun at 00:00");
});

test("describeCron: monthly shape", () => {
  assert.equal(describeCron("0 9 1 * *", TZ), "Every month on day 1 at 09:00");
  assert.equal(describeCron("30 6 15 * *", TZ), "Every month on day 15 at 06:30");
});

test("describeCron: macros expand to their readable form", () => {
  assert.equal(describeCron("@daily", TZ), "Every day at midnight");
  assert.equal(describeCron("@hourly", TZ), "Every hour, on the hour");
  assert.equal(describeCron("@weekly", TZ), "Every Sun at 00:00");
  assert.equal(describeCron("@monthly", TZ), "Every month on day 1 at 00:00");
});

test("describeCron: unsupported-but-valid shapes fall back to 'Cron: <expr>'", () => {
  assert.equal(describeCron("*/7 3 * * *", TZ), "Cron: */7 3 * * *");
  assert.equal(describeCron("0 9 * 6 *", TZ), "Cron: 0 9 * 6 *");
});

test("describeCron: fallback echoes the expression as written, not its macro expansion", () => {
  assert.equal(describeCron("@yearly", TZ), "Cron: @yearly");
  assert.equal(describeCron("@annually", TZ), "Cron: @annually");
  assert.equal(describeCron("0 0 1 1 *", TZ), "Cron: 0 0 1 1 *");
});

test("describeCron: invalid expressions are returned verbatim", () => {
  assert.equal(describeCron("not a cron", TZ), "not a cron");
  assert.equal(describeCron("0 9 * * *", "Invalid/Zone"), "0 9 * * *");
});

test("describeCron never appends a timezone suffix", () => {
  for (const expr of ["*/5 * * * *", "0 9 * * 1-5", "0 9 1 * *", "@daily"]) {
    const described = describeCron(expr, TZ);
    assert.equal(described.includes(TZ), false, `${described} must not contain the timezone`);
    assert.equal(described.includes("("), false);
  }
});

/* ------------------------------------------------------------------ */
/* nextCronFires                                                      */
/* ------------------------------------------------------------------ */

test("nextCronFires returns the next N fires, ascending", () => {
  const fires = nextCronFires("*/15 * * * *", UTC, T_MON_00_UTC, 3);
  assert.deepEqual(fires, [
    T_MON_00_UTC + 15 * 60_000,
    T_MON_00_UTC + 30 * 60_000,
    T_MON_00_UTC + 45 * 60_000,
  ]);
  assert.deepEqual([...fires].sort((a, b) => a - b), fires);
});

test("nextCronFires is strictly greater than 'after'", () => {
  // `after` already sits on a fire time → the next one is a full period later.
  const fires = nextCronFires("*/15 * * * *", UTC, T_MON_00_UTC + 15 * 60_000, 2);
  assert.deepEqual(fires, [T_MON_00_UTC + 30 * 60_000, T_MON_00_UTC + 45 * 60_000]);
  assert.ok(fires[0]! > T_MON_00_UTC + 15 * 60_000);
});

test("nextCronFires handles 6-field (seconds) expressions", () => {
  const fires = nextCronFires("*/10 * * * * *", UTC, T_MON_00_UTC, 4);
  assert.deepEqual(fires, [
    T_MON_00_UTC + 10_000,
    T_MON_00_UTC + 20_000,
    T_MON_00_UTC + 30_000,
    T_MON_00_UTC + 40_000,
  ]);
});

test("nextCronFires respects the timezone", () => {
  const shanghai = nextCronFires("0 9 * * *", TZ, T_MON_00_UTC, 1);
  assert.deepEqual(shanghai, [T_MON_09_SH]);

  const utc = nextCronFires("0 9 * * *", UTC, T_MON_00_UTC, 1);
  assert.deepEqual(utc, [T_MON_00_UTC + 9 * 3_600_000]);
  assert.notEqual(shanghai[0], utc[0]);
});

test("nextCronFires skips the weekend for weekday expressions", () => {
  const [first] = nextCronFires("0 9 * * 1-5", TZ, T_SAT_00_UTC, 1);
  // Saturday 08:00 Asia/Shanghai → Monday 09:00 (2024-01-08T01:00Z).
  assert.equal(first, Date.parse("2024-01-08T01:00:00.000Z"));
});

test("nextCronFires returns [] for count <= 0", () => {
  assert.deepEqual(nextCronFires("*/5 * * * *", UTC, T_MON_00_UTC, 0), []);
  assert.deepEqual(nextCronFires("*/5 * * * *", UTC, T_MON_00_UTC, -3), []);
});

test("nextCronFires returns [] for invalid input", () => {
  assert.deepEqual(nextCronFires("not a cron", UTC, T_MON_00_UTC, 3), []);
  assert.deepEqual(nextCronFires("*/5 * * * *", "Invalid/Zone", T_MON_00_UTC, 3), []);
  assert.deepEqual(nextCronFires("*/5 * * * *", UTC, Number.NaN, 3), []);
});

test("nextCronFires returns [] when the expression never fires", () => {
  assert.deepEqual(nextCronFires("0 0 30 2 *", UTC, T_MON_00_UTC, 3), []);
});

test("nextCronFires caps the scan at 1000 candidates", () => {
  const fires = nextCronFires("*/1 * * * * *", UTC, T_MON_00_UTC, 5_000);
  assert.equal(fires.length, 1_000);
  assert.equal(fires[0], T_MON_00_UTC + 1_000);
});
