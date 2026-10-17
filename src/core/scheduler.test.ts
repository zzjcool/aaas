import assert from "node:assert/strict";
import test from "node:test";
import { Scheduler } from "./scheduler.ts";
import type { JobSpec, TriggerPlugin } from "../shared/types.ts";

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

interface Fire {
  jobId: string;
  scheduledFor: number | null;
}

function makeJob(id: string, enabled = true): JobSpec {
  return {
    id,
    name: id,
    enabled,
    trigger: { type: "test", every: "1m" },
    agent: { type: "fake", cwd: "/tmp" },
    prompt: "hi",
    timeoutMs: 1000,
    retries: 0,
    retryBackoffMs: 0,
    allowOverlap: false,
  } as unknown as JobSpec;
}

function makePlugin(fires: number[]): TriggerPlugin<unknown> {
  return {
    type: "test",
    descriptor: { type: "test", displayName: "Test", description: "", fields: [] },
    validate: (raw) => ({ ok: true, config: raw }),
    describe: () => "test trigger",
    nextFire: (_config, after) => {
      for (const fire of fires) if (fire > after) return fire;
      return null;
    },
  };
}

function harness(options: { fires: number[]; now: () => number; missedGraceMs?: number; enabled?: boolean }) {
  const triggered: Fire[] = [];
  const skipped: { scheduledFor: number; reason: string }[] = [];
  const errors: string[] = [];
  const state = new Map<string, number | null>();
  const plugin = makePlugin(options.fires);

  const triggers = { get: (type: string) => (type === "test" ? plugin : undefined) } as never;
  const agents = {
    get: (type: string) => (type === "fake" ? { type: "fake" } : undefined),
  } as never;
  const runner = {
    triggerRun: (input: { job: JobSpec; scheduledFor: number | null }) => {
      triggered.push({ jobId: input.job.id, scheduledFor: input.scheduledFor });
      return null;
    },
    recordSkipped: (_job: JobSpec, scheduledFor: number, reason: string) => {
      skipped.push({ scheduledFor, reason });
      return null;
    },
  } as never;
  const db = {
    getJobState: (jobId: string) => ({ lastFire: state.get(jobId) ?? null }),
    setJobState: (jobId: string, lastFire: number | null) => {
      state.set(jobId, lastFire);
    },
  };

  const scheduler = new Scheduler({
    triggers,
    agents,
    runner,
    db,
    defaultTimezone: "UTC",
    tickMs: 1000,
    missedGraceMs: options.missedGraceMs ?? 60_000,
    now: options.now,
    log: (level, message) => {
      if (level === "error") errors.push(message);
    },
  });

  return { scheduler, triggered, skipped, errors, state };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test("due job fires exactly once per tick and advances its schedule", async () => {
  let now = 1_000_000;
  const { scheduler, triggered, state } = harness({
    fires: [1_000_000, 1_060_000, 1_120_000],
    now: () => now,
  });
  scheduler.setJobs([{ spec: makeJob("a"), problem: null }]);
  scheduler.start();

  await scheduler.tick();
  assert.deepEqual(triggered, [{ jobId: "a", scheduledFor: 1_000_000 }]);
  assert.equal(state.get("a"), 1_000_000);
  assert.equal(scheduler.nextFireFor("a"), 1_060_000);

  // Same instant again: must not double fire.
  await scheduler.tick();
  assert.equal(triggered.length, 1);

  now = 1_060_000;
  await scheduler.tick();
  assert.deepEqual(triggered.at(-1), { jobId: "a", scheduledFor: 1_060_000 });

  scheduler.stop();
});

test("disabled jobs never fire", async () => {
  const { scheduler, triggered } = harness({ fires: [1_000_000], now: () => 1_000_000 });
  scheduler.setJobs([{ spec: makeJob("off", false), problem: null }]);
  scheduler.start();
  await scheduler.tick();
  assert.equal(triggered.length, 0);
  scheduler.stop();
});

test("jobs with a load problem are not scheduled", async () => {
  const { scheduler, triggered } = harness({ fires: [1_000_000], now: () => 1_000_000 });
  scheduler.setJobs([{ spec: makeJob("bad"), problem: "agent: cwd missing" }]);
  scheduler.start();
  await scheduler.tick();
  assert.equal(triggered.length, 0);
  assert.equal(scheduler.jobCount, 0);
  scheduler.stop();
});

test("fire times missed while the engine was down collapse into one skipped record", async () => {
  const now = 10_000_000;
  const { scheduler, triggered, state, skipped } = harness({
    fires: [1_000_000, 1_060_000, 1_120_000, 20_000_000],
    now: () => now,
    missedGraceMs: 60_000,
  });
  // The job ran at 1_000_000 before the engine went down.
  state.set("late", 1_000_000);

  scheduler.setJobs([{ spec: makeJob("late"), problem: null }]);
  scheduler.start();

  // One skipped record for the collapsed gap, not three replayed runs.
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.scheduledFor, 1_120_000, "records the latest missed point, not the earliest");
  assert.deepEqual(triggered, [], "nothing stale may actually run");

  await scheduler.tick();
  assert.deepEqual(triggered, [], "the next fire is still in the future");
  assert.equal(scheduler.nextFireFor("late"), 20_000_000);
  scheduler.stop();
});

test("a fire inside the grace window still runs after a restart", async () => {
  const now = 10_000_000;
  const { scheduler, triggered } = harness({
    fires: [9_990_000, 20_000_000],
    now: () => now,
    missedGraceMs: 60_000,
  });
  scheduler.setJobs([{ spec: makeJob("grace"), problem: null }]);
  scheduler.start();
  await scheduler.tick();
  assert.deepEqual(triggered, [{ jobId: "grace", scheduledFor: 9_990_000 }]);
  scheduler.stop();
});

test("nonexistent agent type is logged and does not fire", async () => {
  const now = 1_000_000;
  const { scheduler, triggered, errors } = harness({ fires: [now], now: () => now });
  const job = makeJob("x");
  job.agent = { type: "ghost", cwd: "/tmp" } as never;
  scheduler.setJobs([{ spec: job, problem: null }]);
  scheduler.start();
  await scheduler.tick();
  assert.equal(triggered.length, 0);
  assert.ok(errors.some((e) => e.includes("unknown agent")), `errors: ${errors.join("|")}`);
  scheduler.stop();
});

test("reloading jobs keeps the next fire time when the schedule is unchanged", async () => {
  const now = 1_000_000;
  const { scheduler } = harness({ fires: [1_000_000, 1_060_000, 1_120_000], now: () => now });
  const job = makeJob("stable");
  scheduler.setJobs([{ spec: job, problem: null }]);
  scheduler.start();
  await scheduler.tick();
  const next = scheduler.nextFireFor("stable");
  assert.equal(next, 1_060_000);

  scheduler.setJobs([{ spec: { ...job, name: "renamed" }, problem: null }]);
  assert.equal(scheduler.nextFireFor("stable"), next, "renaming must not reset the schedule");
  scheduler.stop();
});

test("reloading jobs recomputes when the trigger changes", async () => {
  const now = 1_000_000;
  const { scheduler } = harness({ fires: [1_000_000, 1_060_000, 5_000_000], now: () => now });
  const job = makeJob("changing");
  scheduler.setJobs([{ spec: job, problem: null }]);
  scheduler.start();
  await scheduler.tick();
  assert.equal(scheduler.nextFireFor("changing"), 1_060_000);

  scheduler.setJobs([{ spec: { ...job, trigger: { type: "test", every: "5m" } } as unknown as JobSpec, problem: null }]);
  assert.equal(scheduler.nextFireFor("changing"), 1_060_000, "recompute still starts from `now`");
  scheduler.stop();
});

test("plugin start/stop hooks are invoked around reloads", async () => {
  const now = 1_000_000;
  const started: string[] = [];
  const stopped: string[] = [];
  const plugin: TriggerPlugin<unknown> = {
    type: "evented",
    descriptor: { type: "evented", displayName: "Evented", description: "", fields: [] },
    validate: (raw) => ({ ok: true, config: raw }),
    describe: () => "evented",
    start: (_ctx, job) => {
      started.push(job.id);
    },
    stop: (jobId) => {
      stopped.push(jobId);
    },
  };
  const scheduler = new Scheduler({
    triggers: { get: () => plugin } as never,
    agents: { get: () => ({ type: "fake" }) } as never,
    runner: { triggerRun: () => null } as never,
    db: { getJobState: () => ({ lastFire: null }), setJobState: () => {} },
    defaultTimezone: "UTC",
    tickMs: 1000,
    missedGraceMs: 0,
    now: () => now,
  });

  const job = {
    id: "evented-job",
    enabled: true,
    trigger: { type: "evented" },
    agent: { type: "fake", cwd: "/tmp" },
    prompt: "x",
    timeoutMs: 1000,
    retries: 0,
    retryBackoffMs: 0,
    allowOverlap: false,
  } as unknown as JobSpec;
  scheduler.setJobs([{ spec: job, problem: null }]);
  assert.deepEqual(started, ["evented-job"]);

  scheduler.setJobs([]);
  assert.deepEqual(stopped, ["evented-job"]);
  scheduler.stop();
});
