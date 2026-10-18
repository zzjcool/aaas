import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAdapter, AgentRunInput, AgentRunResult, AgentConfig, JobSpec } from "../shared/types.ts";
import { Db } from "./db.ts";
import { EventBus, LogStore } from "./events.ts";
import { Runner } from "./runner.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trigger-runner-"));
}

function makeJob(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    id: "job-1",
    name: "Job One",
    enabled: true,
    trigger: { type: "manual" },
    agent: { type: "fake", cwd: "/tmp" } as unknown as AgentConfig,
    prompt: "do the thing",
    timeoutMs: 1000,
    retries: 0,
    retryBackoffMs: 1,
    allowOverlap: false,
    ...overrides,
  };
}

interface FakeAdapter extends AgentAdapter {
  calls: AgentRunInput[];
}

function fakeAdapter(impl: (input: AgentRunInput) => Promise<AgentRunResult> | AgentRunResult): FakeAdapter {
  const calls: AgentRunInput[] = [];
  return {
    type: "fake",
    calls,
    descriptor: { type: "fake", displayName: "Fake", description: "test double", fields: [] },
    validate: () => ({ ok: true, config: { type: "fake", cwd: "/tmp" } as unknown as AgentConfig }),
    async run(input) {
      calls.push(input);
      return impl(input);
    },
  };
}

/**
 * `retryDelayFloorMs` defaults to 1ms so most tests stay fast, but a test about
 * the backoff window itself must pass a real delay: a 1ms window cannot expose
 * a race that in production lasts 30s (the default retryBackoffMs).
 */
function setup(adapter: FakeAdapter, runnerOptions: { retryDelayFloorMs?: number } = {}) {
  const dir = tempDir();
  const db = new Db(join(dir, "trigger.db"));
  const logs = new LogStore(dir);
  const bus = new EventBus();
  const runner = new Runner({
    db,
    logs,
    bus,
    maxConcurrency: 2,
    retryDelayFloorMs: runnerOptions.retryDelayFloorMs ?? 1,
  });
  return { dir, db, logs, bus, runner, adapter };
}

async function settle(runner: Runner, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (runner.runningCount > 0 || runner.queuedCount > 0) {
    if (Date.now() > deadline) throw new Error("runner did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("successful run is persisted with usage and result text", async () => {
  const adapter = fakeAdapter(async () => ({
    ok: true,
    text: "all good",
    exitCode: 0,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    costTotal: 0.01,
    sessionId: "sess-1",
  }));
  const { runner, db, dir } = setup(adapter);
  try {
    const run = runner.triggerRun({ job: makeJob(), triggerKind: "manual", scheduledFor: null }, adapter);
    assert.ok(run);
    await settle(runner);
    const stored = db.getRun(run.id);
    assert.ok(stored);
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.resultText, "all good");
    assert.deepEqual(stored.tokens, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 });
    assert.equal(stored.costTotal, 0.01);
    assert.equal(stored.sessionId, "sess-1");
    assert.equal(stored.exitCode, 0);
    assert.ok(stored.durationMs !== null && stored.durationMs >= 0);
    assert.ok(stored.logPath);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed run retries once and records the attempt count", async () => {
  let attempt = 0;
  const adapter = fakeAdapter(async () => {
    attempt += 1;
    return { ok: false, text: "", error: `boom ${attempt}`, exitCode: 1 };
  });
  const { runner, db, dir } = setup(adapter);
  try {
    const run = runner.triggerRun(
      { job: makeJob({ retries: 1 }), triggerKind: "manual", scheduledFor: null },
      adapter,
    );
    assert.ok(run);
    await settle(runner);
    const stored = db.getRun(run.id);
    assert.ok(stored);
    assert.equal(stored.status, "failed");
    assert.equal(stored.attempt, 2);
    assert.equal(adapter.calls.length, 2);
    assert.match(stored.error ?? "", /boom 2/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel during the retry backoff actually cancels", async () => {
  // Regression: #attempt deletes the abort controller in its own finally, and
  // cancelJob() only scanned #aborts + #queue. During the backoff sleep the
  // run was in neither, so `POST /jobs/:id/cancel` answered {cancelled:0} and
  // the retry fired anyway — flipping the run from failed back to running.
  // With the default retryBackoffMs (30s) that is a 30-second dead zone.
  //
  // The window must be real: with a 1ms floor the race cannot be observed and
  // the test passes whether or not the bug exists.
  let attempts = 0;
  const adapter = fakeAdapter(() => {
    attempts += 1;
    return { ok: false, text: "", error: `boom ${attempts}`, exitCode: 1 };
  });
  const { runner, db, dir } = setup(adapter, { retryDelayFloorMs: 10_000 });
  try {
    const run = runner.triggerRun(
      { job: makeJob({ retries: 1, retryBackoffMs: 60_000 }), triggerKind: "manual", scheduledFor: null },
      adapter,
    );
    assert.ok(run);

    // Wait for attempt 1 to fail and the backoff to start.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const live = db.getRun(run.id);
      if (live?.status === "failed" && attempts === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(attempts, 1, "attempt 1 must have failed and be waiting to retry");

    const cancelled = runner.cancelJob("job-1");
    assert.equal(cancelled, 1, "a run waiting to retry must be cancellable");

    await settle(runner);
    const stored = db.getRun(run.id);
    assert.equal(stored?.status, "cancelled", "must not silently retry after cancel");
    assert.equal(attempts, 1, "the retry must never have fired");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlap is skipped while a run is live", async () => {
  const releases: (() => void)[] = [];
  const adapter = fakeAdapter(
    () =>
      new Promise<AgentRunResult>((resolve) => {
        releases.push(() => resolve({ ok: true, text: "done", exitCode: 0 }));
      }),
  );
  const { runner, db, dir } = setup(adapter);
  const job = makeJob();
  try {
    const first = runner.triggerRun({ job, triggerKind: "manual", scheduledFor: null }, adapter);
    assert.ok(first);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = runner.triggerRun({ job, triggerKind: "cron", scheduledFor: Date.now() }, adapter);
    assert.equal(second, null, "second run must be skipped, not queued");

    const all = db.listRuns({ jobId: job.id });
    assert.equal(all.filter((r) => r.status === "skipped").length, 1);

    for (const release of releases.splice(0)) release();
    await settle(runner);
    assert.equal(db.getRun(first.id)?.status, "succeeded");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allowOverlap lets a second run start; force bypasses the guard", async () => {
  const adapter = fakeAdapter(async () => ({ ok: true, text: "ok", exitCode: 0 }));
  const { runner, db, dir } = setup(adapter);
  try {
    const overlayJob = makeJob({ id: "job-overlap", allowOverlap: true });
    const a = runner.triggerRun({ job: overlayJob, triggerKind: "manual", scheduledFor: null }, adapter);
    const b = runner.triggerRun({ job: overlayJob, triggerKind: "manual", scheduledFor: null }, adapter);
    assert.ok(a && b, "both runs should be accepted when allowOverlap is true");
    await settle(runner);

    const forcedJob = makeJob({ id: "job-forced" });
    const releases: (() => void)[] = [];
    const blocked = fakeAdapter(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          releases.push(() => resolve({ ok: true, text: "ok", exitCode: 0 }));
        }),
    );
    const c = runner.triggerRun({ job: forcedJob, triggerKind: "manual", scheduledFor: null }, blocked);
    assert.ok(c);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const d = runner.triggerRun({ job: forcedJob, triggerKind: "manual", scheduledFor: null, force: true }, blocked);
    assert.ok(d, "force must bypass the overlap guard");
    // Release both live runs (the forced one starts after the first finishes).
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const release of releases.splice(0)) release();
    }
    await settle(runner);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout aborts the adapter and marks the run as timeout", async () => {
  const adapter = fakeAdapter(
    (input) =>
      new Promise<AgentRunResult>((resolve) => {
        input.signal.addEventListener("abort", () => {
          resolve({ ok: false, text: "", error: "aborted by signal", aborted: true, exitCode: null });
        });
      }),
  );
  const { runner, db, dir } = setup(adapter);
  try {
    const run = runner.triggerRun(
      { job: makeJob({ timeoutMs: 40, retries: 0 }), triggerKind: "manual", scheduledFor: null },
      adapter,
    );
    assert.ok(run);
    await settle(runner);
    const stored = db.getRun(run.id);
    assert.ok(stored);
    assert.equal(stored.status, "timeout");
    assert.match(stored.error ?? "", /timed out/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator cancel marks the run as cancelled", async () => {
  const job = makeJob({ id: "job-cancel", timeoutMs: 60_000 });
  const adapter = fakeAdapter(
    (input) =>
      new Promise<AgentRunResult>((resolve) => {
        input.signal.addEventListener("abort", () => {
          resolve({ ok: false, text: "", error: "cancelled by operator", aborted: true });
        });
      }),
  );
  const { runner, db, dir } = setup(adapter);
  try {
    const run = runner.triggerRun({ job, triggerKind: "manual", scheduledFor: null }, adapter);
    assert.ok(run);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = runner.cancelJob(job.id);
    assert.equal(cancelled, 1);
    await settle(runner);
    assert.equal(db.getRun(run.id)?.status, "cancelled");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter exceptions are captured as failures", async () => {
  const adapter = fakeAdapter(async () => {
    throw new Error("kaboom");
  });
  const { runner, db, dir } = setup(adapter);
  try {
    const run = runner.triggerRun({ job: makeJob({ retries: 0 }), triggerKind: "manual", scheduledFor: null }, adapter);
    assert.ok(run);
    await settle(runner);
    const stored = db.getRun(run.id);
    assert.equal(stored?.status, "failed");
    assert.match(stored?.error ?? "", /kaboom/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs are written as JSONL and streamed to subscribers", async () => {
  const adapter = fakeAdapter(async (_input) => ({ ok: true, text: "done", exitCode: 0 }));
  const { runner, db, logs, bus, dir } = setup(adapter);
  const events: string[] = [];
  const unsubscribe = bus.subscribe((event) => {
    if (event.type === "log") events.push(`${event.stream}:${event.line}`);
  });
  try {
    const run = runner.triggerRun({ job: makeJob(), triggerKind: "manual", scheduledFor: null }, adapter);
    assert.ok(run);
    await settle(runner);
    unsubscribe();
    const lines = logs.tail(run.id, 100);
    assert.ok(lines.some((l) => l.stream === "system" && l.line.includes("queued job=job-1")));
    assert.ok(lines.some((l) => l.stream === "system" && l.line.includes("finished: succeeded")));
    assert.ok(events.some((e) => e.startsWith("system:queued job=job-1")));
    assert.ok(events.some((e) => e.startsWith("system:attempt 1 start")));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markStaleRuns clears ghost runs after a restart", async () => {
  const adapter = fakeAdapter(async () => ({ ok: true, text: "ok", exitCode: 0 }));
  const { db, dir } = setup(adapter);
  try {
    db.insertRun({
      id: "run_ghost",
      jobId: "job-1",
      jobName: "Job One",
      triggerKind: "cron",
      status: "running",
      scheduledFor: Date.now(),
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      attempt: 1,
      exitCode: null,
      error: null,
      resultText: null,
      tokens: null,
      costTotal: null,
      sessionId: null,
      logPath: null,
      payload: null,
    });
    const changed = db.markStaleRuns("engine restarted", Date.now());
    assert.equal(changed, 1);
    assert.equal(db.getRun("run_ghost")?.status, "failed");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
