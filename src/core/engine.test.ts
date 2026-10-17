/**
 * Engine wiring test: YAML on disk -> JobStore -> Scheduler -> Runner, with the
 * scheduler clock driven by hand. This is the seam the HTTP tests do not cover
 * (they mostly exercise runs triggered through the API).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter, AgentConfig, JobSpec, TriggerPlugin } from "../shared/types.ts";
import { Db } from "./db.ts";
import { EventBus, LogStore } from "./events.ts";
import { JobStore } from "./jobstore.ts";
import { AgentRegistry, TriggerRegistry } from "./registry.ts";
import { Runner } from "./runner.ts";
import { Scheduler } from "./scheduler.ts";
import { describeSchedule, nextFire, normalizeSchedule, type NormalizedSchedule } from "./schedule.ts";

const TZ = "Asia/Shanghai";
const T_2026_10_17_MIDNIGHT_UTC = Date.parse("2026-10-17T00:00:00Z");

function countingAdapter(): AgentAdapter & { runs: { jobId: string; scheduledFor: number | null }[] } {
  const runs: { jobId: string; scheduledFor: number | null }[] = [];
  return {
    type: "count",
    runs,
    descriptor: { type: "count", displayName: "Count", description: "", fields: [] },
    validate: () => ({ ok: true, config: { type: "pi", cwd: "/tmp" } as unknown as AgentConfig }),
    run: async (input) => {
      runs.push({ jobId: input.jobId, scheduledFor: null });
      return { ok: true, text: "counted", exitCode: 0 };
    },
  };
}

test("a cron YAML job fires on the wall-clock time in its own timezone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaas-engine-"));
  const dataDir = join(dir, "data");
  const jobsDir = join(dir, "jobs");
  const db = new Db(join(dataDir, "aaas.db"));
  const logs = new LogStore(dataDir);
  const bus = new EventBus();
  const triggers = new TriggerRegistry();
  // A trigger plugin that defers to the shared schedule helpers.
  // Mirrors the real cron plugin: `validate` is the only normalisation point,
  // so `describe`/`nextFire` receive an already-normalised schedule.
  const cronish: TriggerPlugin<NormalizedSchedule> = {
    type: "cron",
    descriptor: { type: "cron", displayName: "cron", description: "", fields: [] },
    validate: (raw) => {
      const result = normalizeSchedule(raw, TZ);
      return result.ok ? { ok: true, config: result.value } : { ok: false, errors: result.errors };
    },
    describe: (config) => describeSchedule(config),
    nextFire: (config, after, lastFire) => nextFire(config, after, lastFire),
  };
  triggers.register(cronish as never);

  const adapter = countingAdapter();
  const agents = new AgentRegistry();
  agents.register(adapter);

  const runner = new Runner({ db, logs, bus, maxConcurrency: 2 });
  const jobs = new JobStore({
    dir: jobsDir,
    validateTrigger: (raw) => triggers.get((raw as { type: string }).type)?.validate(raw) ?? { ok: false, errors: ["unknown"] },
    validateAgent: () => ({ ok: true }),
    describeTrigger: (raw) => {
      const plugin = triggers.get((raw as { type: string }).type);
      return plugin ? plugin.describe(raw) : "?";
    },
  });

  writeFileSync(
    join(jobsDir, "morning.yaml"),
    [
      "id: morning",
      "trigger:",
      "  type: cron",
      "  cron: 0 9 * * *",
      `  timezone: ${TZ}`,
      "agent:",
      "  type: count",
      "prompt: hi",
      "timeoutMs: 1000",
      "retries: 0",
      "",
    ].join("\n"),
    "utf8",
  );

  let now = T_2026_10_17_MIDNIGHT_UTC;
  const scheduler = new Scheduler({
    triggers,
    agents,
    runner,
    db,
    defaultTimezone: TZ,
    tickMs: 1000,
    missedGraceMs: 60_000,
    now: () => now,
  });

  try {
    const loaded = jobs.load();
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    assert.equal(loaded.jobs.length, 1);
    assert.equal(loaded.jobs[0]?.problem, null);
    scheduler.setJobs(loaded.jobs.map((j) => ({ spec: j.spec, problem: j.problem })));
    scheduler.start();

    // Next fire is 09:00 Asia/Shanghai == 01:00 UTC on the same date.
    assert.equal(scheduler.nextFireFor("morning"), Date.parse("2026-10-17T01:00:00Z"));

    now = Date.parse("2026-10-17T00:59:59Z");
    await scheduler.tick();
    assert.equal(adapter.runs.length, 0, "must not fire one second early");

    now = Date.parse("2026-10-17T01:00:00Z");
    await scheduler.tick();
    assert.equal(adapter.runs.length, 1);
    assert.equal(adapter.runs[0]?.jobId, "morning");
    assert.equal(scheduler.nextFireFor("morning"), Date.parse("2026-10-18T01:00:00Z"));

    // Let the run settle so the DB reflects it.
    for (let i = 0; i < 100 && runner.runningCount > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const runs = db.listRuns({ jobId: "morning" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.triggerKind, "cron");
    assert.equal(runs[0]?.scheduledFor, Date.parse("2026-10-17T01:00:00Z"));
    assert.equal(runs[0]?.status, "succeeded");
  } finally {
    scheduler.stop();
    db.close();
    logs.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting the YAML file stops the job from firing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaas-engine2-"));
  const dataDir = join(dir, "data");
  const jobsDir = join(dir, "jobs");
  const db = new Db(join(dataDir, "aaas.db"));
  const logs = new LogStore(dataDir);
  const bus = new EventBus();
  const triggers = new TriggerRegistry();
  triggers.register({
    type: "every",
    descriptor: { type: "every", displayName: "every", description: "", fields: [] },
    validate: () => ({ ok: true, config: {} }),
    describe: () => "every 60s",
    nextFire: (_c: unknown, after: number) => after + 60_000,
  } as never);
  const adapter = countingAdapter();
  const agents = new AgentRegistry();
  agents.register(adapter);
  const runner = new Runner({ db, logs, bus, maxConcurrency: 1 });
  const jobs = new JobStore({
    dir: jobsDir,
    validateTrigger: () => ({ ok: true }),
    validateAgent: () => ({ ok: true }),
    describeTrigger: () => "every 60s",
  });

  writeFileSync(
    join(jobsDir, "tick.yaml"),
    ["id: tick", "trigger:", "  type: every", "agent:", "  type: count", "prompt: hi"].join("\n"),
    "utf8",
  );

  let now = 1_000_000;
  const scheduler = new Scheduler({
    triggers,
    agents,
    runner,
    db,
    defaultTimezone: TZ,
    tickMs: 1000,
    missedGraceMs: 0,
    now: () => now,
  });

  try {
    const load = () => {
      const { jobs: loaded } = jobs.load();
      scheduler.setJobs(loaded.map((j) => ({ spec: j.spec, problem: j.problem })));
    };
    load();
    scheduler.start();
    assert.equal(scheduler.jobCount, 1);

    now += 60_000;
    await scheduler.tick();
    assert.equal(adapter.runs.length, 1);

    jobs.delete("tick");
    load();
    assert.equal(scheduler.jobCount, 0);

    now += 120_000;
    await scheduler.tick();
    assert.equal(adapter.runs.length, 1, "a deleted job must not fire again");
  } finally {
    scheduler.stop();
    db.close();
    logs.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("job YAML documents the resolved spec used by the runner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaas-engine3-"));
  const jobsDir = join(dir, "jobs");
  const store = new JobStore({
    dir: jobsDir,
    validateTrigger: () => ({ ok: true }),
    validateAgent: () => ({ ok: true }),
    describeTrigger: () => "x",
  });
  try {
    const spec: JobSpec = {
      id: "explicit",
      name: "Explicit",
      enabled: false,
      trigger: { type: "cron", cron: "*/5 * * * *", timezone: TZ },
      agent: { type: "pi", cwd: "/tmp", tools: ["read"] },
      prompt: "p",
      timeoutMs: 1000,
      retries: 2,
      retryBackoffMs: 10,
      allowOverlap: true,
      tags: ["t"],
    };
    store.save(spec);
    const loaded = store.load().jobs[0];
    assert.deepEqual(loaded?.spec, spec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
