import assert from "node:assert/strict";
import test from "node:test";
import {
  PRESETS,
  defaultModel,
  describeModel,
  parseCron,
  serializeCron,
  type CronModel,
} from "../../web/src/cron.ts";

/**
 * The visual builder is a *view* over the cron string. These tests pin the
 * property that matters: anything the builder claims to model must round-trip
 * to an equivalent expression, and anything it does not model must return
 * `null` so the UI falls back to raw text instead of silently rewriting it.
 */

function roundTrip(expr: string): string {
  const model = parseCron(expr);
  assert.ok(model, `${expr} should be modelled`);
  return serializeCron(model);
}

test("modelled expressions round-trip unchanged", () => {
  const cases = [
    "* * * * *",
    "*/15 * * * *",
    "0 * * * *",
    "0 9 * * *",
    "0 9 * * 1-5",
    "0 9,18 * * 1-5",
    "0 9 * * 1",
    "0 3 1 * *",
    "0 2 * * *",
    "0 9 1 6 *",
    "*/5 */2 * * *",
  ];
  for (const expr of cases) {
    assert.equal(roundTrip(expr), expr, `round-trip changed ${expr}`);
  }
});

test("Sunday is normalised to 7 (0 and 7 mean the same day)", () => {
  assert.equal(roundTrip("30 4 * * 0"), "30 4 * * 7");
  assert.equal(roundTrip("30 4 * * 7"), "30 4 * * 7");
  const sunday = parseCron("0 9 * * 0");
  assert.equal(sunday?.weekday, 7);
});

test("shapes the builder cannot represent return null, never a mangled string", () => {
  const unsupported = [
    "0,30 9 * * *", // multiple minutes
    "0 9 * * 1-5/2", // step in weekday range
    "0 0 9 * * *", // six-field (seconds)
    "@daily", // macro
    "0 9 L * *", // last-day syntax
    "0 9 * * 1,3", // weekday list
    "0-5 9 * * *", // minute range
    "", // empty
    "not a cron", // junk
  ];
  for (const expr of unsupported) {
    assert.equal(parseCron(expr), null, `${expr} must not be modelled`);
  }
});

test("hour lists must already be ascending, so we never silently reorder", () => {
  assert.equal(parseCron("0 18,9 * * *"), null);
  assert.notEqual(parseCron("0 9,18 * * *"), null);
});

test("default model is every day at 09:00", () => {
  assert.equal(serializeCron(defaultModel()), "0 9 * * *");
  assert.equal(describeModel(defaultModel()), "At 09:00 every day");
});

test("every preset serialises to the expression it advertises", () => {
  for (const preset of PRESETS) {
    const result = preset.apply();
    if (typeof result === "string") {
      assert.equal(result, preset.hint, `${preset.id} string preset drifted`);
      continue;
    }
    const expr = serializeCron(result);
    assert.equal(expr, preset.hint, `${preset.id} produced ${expr}`);
    // and it must survive a round-trip through the parser
    const reparsed = parseCron(expr);
    assert.ok(reparsed, `${preset.id} (${expr}) must be re-parsable`);
    assert.equal(serializeCron(reparsed), expr);
  }
});

test("descriptions read like English", () => {
  const expectations: [string, string][] = [
    ["* * * * *", "Every minute, every day"],
    ["*/15 * * * *", "Every 15 minutes every day"],
    ["0 * * * *", "Every hour at :00 every day"],
    ["0 9 * * *", "At 09:00 every day"],
    ["0 9 * * 1-5", "At 09:00 on weekdays"],
    ["0 9 * * 0,6", "At 09:00 on weekends"],
    ["0 9 * * 1", "At 09:00 on Mon"],
    ["0 3 1 * *", "At 03:00 on day 1 of the month"],
    ["0 9 1 6 *", "At 09:00 on June 1"],
    ["0 9,18 * * *", "At 09:00, 18:00 every day"],
  ];
  for (const [expr, expected] of expectations) {
    const model = parseCron(expr);
    assert.ok(model, expr);
    assert.equal(describeModel(model), expected, expr);
  }
});

test("every-minute detection covers both shapes", () => {
  assert.equal(parseCron("* * * * *")?.everyMinute, true);
  assert.equal(parseCron("*/5 * * * *")?.everyMinute, false);
});

test("changing a chip keeps the previously chosen weekday", () => {
  const model = parseCron("0 9 * * 3") as CronModel;
  assert.equal(model.dayMode, "specific");
  assert.equal(model.weekday, 3);
  // Toggling to weekends and back must not lose the day.
  const weekends = { ...model, dayMode: "weekends" as const };
  assert.equal(serializeCron(weekends), "0 9 * * 0,6");
  const back = { ...weekends, dayMode: "specific" as const };
  assert.equal(serializeCron(back), "0 9 * * 3", "weekday must survive the round trip");
});
