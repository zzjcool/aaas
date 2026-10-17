import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunRecord } from "../shared/types.ts";
import { Db, toSummary } from "./db.ts";
import { EventBus, LogStore } from "./events.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "aaas-db-"));
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_1",
    jobId: "job-a",
    jobName: "Job A",
    triggerKind: "cron",
    status: "succeeded",
    scheduledFor: 1_000,
    createdAt: 1_100,
    startedAt: 1_150,
    finishedAt: 1_500,
    durationMs: 350,
    attempt: 1,
    exitCode: 0,
    error: null,
    resultText: "done",
    tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    costTotal: 0.5,
    sessionId: "s1",
    logPath: "/tmp/x.jsonl",
    payload: null,
    ...overrides,
  };
}

test("runs round-trip through SQLite including JSON columns", () => {
  const dir = tempDir();
  const db = new Db(join(dir, "test.db"));
  try {
    db.insertRun(makeRun({ payload: { branch: "main" } }));
    const loaded = db.getRun("run_1");
    assert.ok(loaded);
    assert.equal(loaded.jobId, "job-a");
    assert.equal(loaded.status, "succeeded");
    assert.deepEqual(loaded.tokens, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 });
    assert.equal(loaded.costTotal, 0.5);
    assert.deepEqual(loaded.payload, { branch: "main" });
    assert.equal(loaded.scheduledFor, 1_000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateRun patches a subset of columns", () => {
  const dir = tempDir();
  const db = new Db(join(dir, "test.db"));
  try {
    db.insertRun(makeRun({ status: "running", finishedAt: null, durationMs: null, resultText: null }));
    db.updateRun("run_1", { status: "failed", error: "boom", finishedAt: 2_000 });
    const loaded = db.getRun("run_1");
    assert.equal(loaded?.status, "failed");
    assert.equal(loaded?.error, "boom");
    assert.equal(loaded?.finishedAt, 2_000);
    // untouched columns keep their previous value
    assert.equal(loaded?.exitCode, 0);
    assert.equal(loaded?.attempt, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateRun on a missing id is a no-op", () => {
  const dir = tempDir();
  const db = new Db(join(dir, "test.db"));
  try {
    db.updateRun("nope", { status: "failed" });
    assert.equal(db.getRun("nope"), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns filters by job and status and honours the limit", () => {
  const dir = tempDir();
  const db = new Db(join(dir, "test.db"));
  try {
    db.insertRun(makeRun({ id: "run_1", jobId: "job-a", status: "succeeded", createdAt: 1 }));
    db.insertRun(makeRun({ id: "run_2", jobId: "job-a", status: "failed", createdAt: 2 }));
    db.insertRun(makeRun({ id: "run_3", jobId: "job-b", status: "succeeded", createdAt: 3 }));

    assert.equal(db.listRuns().length, 3);
    assert.equal(db.listRuns({ jobId: "job-a" }).length, 2);
    assert.deepEqual(
      db.listRuns({ status: ["failed"] }).map((r) => r.id),
      ["run_2"],
    );
    assert.deepEqual(
      db.listRuns({ jobId: "job-a", status: ["failed", "succeeded"] }).map((r) => r.id),
      ["run_2", "run_1"],
      "results are newest-first",
    );
    assert.equal(db.listRuns({ limit: 1 })[0]?.id, "run_3");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status values with quotes cannot break the JSON-based status filter", () => {
  const dir = tempDir();
  const db = new Db(join(dir, "test.db"));
  try {
    db.insertRun(makeRun({ id: "run_1", status: "failed" }));
    // A malicious/broken status string must simply match nothing.
    const rows = db.listRuns({ status: [`failed' OR 1=1 --`] });
    assert.deepEqual(rows, []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastRunForJob and countRunningForJob", () => {
  const dir = tempDir();
  const db = new Db(join(dir, "test.db"));
  try {
    db.insertRun(makeRun({ id: "run_1", createdAt: 1, status: "succeeded" }));
    db.insertRun(makeRun({ id: "run_2", createdAt: 2, status: "running" }));
    assert.equal(db.lastRunForJob("job-a")?.id, "run_2");
    assert.equal(db.lastRunForJob("job-z"), null);
    assert.equal(db.countRunningForJob("job-a"), 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markStaleRuns only touches queued/running rows", () => {
  const dir = tempDir();
  const db = new Db(join(dir, "test.db"));
  try {
    db.insertRun(makeRun({ id: "run_ok", status: "succeeded" }));
    db.insertRun(makeRun({ id: "run_live", status: "running", finishedAt: null, durationMs: null }));
    db.insertRun(makeRun({ id: "run_q", status: "queued", startedAt: null, finishedAt: null, durationMs: null }));

    const changed = db.markStaleRuns("restart", 5_000);
    assert.equal(changed, 2);
    assert.equal(db.getRun("run_ok")?.status, "succeeded");
    assert.equal(db.getRun("run_live")?.status, "failed");
    assert.equal(db.getRun("run_live")?.durationMs, 3_850);
    assert.equal(db.getRun("run_q")?.durationMs, null, "a run that never started has no duration");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("job state and meta survive a reopen", () => {
  const dir = tempDir();
  const path = join(dir, "test.db");
  const first = new Db(path);
  first.setJobState("job-a", 12_345, 100);
  first.setMeta("schema", "1");
  first.close();

  const second = new Db(path);
  try {
    assert.equal(second.getJobState("job-a").lastFire, 12_345);
    assert.equal(second.getJobState("job-z").lastFire, null);
    assert.equal(second.getMeta("schema"), "1");
    assert.equal(second.getMeta("missing"), null);
    second.setJobState("job-a", 99, 200);
    assert.equal(second.getJobState("job-a").lastFire, 99);
  } finally {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toSummary drops the heavy fields", () => {
  const summary = toSummary(makeRun({ payload: { x: 1 }, logPath: "/tmp/x", sessionId: "s" }));
  assert.equal("payload" in summary, false);
  assert.equal("logPath" in summary, false);
  assert.equal("sessionId" in summary, false);
  assert.equal("resultText" in summary, false);
  assert.equal(summary.id, "run_1");
});

/* ------------------------------------------------------------------ */
/* LogStore + EventBus                                                 */
/* ------------------------------------------------------------------ */

test("log store appends JSONL and tails it", () => {
  const dir = tempDir();
  const logs = new LogStore(dir);
  try {
    logs.open("run_x");
    logs.write("run_x", "stdout", "one", 1);
    logs.write("run_x", "stderr", "two", 2);
    logs.write("run_x", "system", "three", 3);
    logs.close("run_x");

    const tail = logs.tail("run_x", 10);
    assert.deepEqual(
      tail.map((l) => [l.stream, l.line, l.at]),
      [
        ["stdout", "one", 1],
        ["stderr", "two", 2],
        ["system", "three", 3],
      ],
    );
    assert.equal(logs.tail("run_x", 2).length, 2);
    assert.equal(logs.tail("run_x", 2)[0]?.line, "two");
    assert.deepEqual(logs.tail("run_missing", 10), []);
  } finally {
    logs.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("event bus fans out and retains per-run history", () => {
  const bus = new EventBus();
  const seen: string[] = [];
  const unsubscribe = bus.subscribe((event) => {
    seen.push(event.type);
  });
  bus.publish({ type: "log", runId: "r1", stream: "stdout", line: "a", at: 1 });
  bus.publish({ type: "log", runId: "r1", stream: "stdout", line: "b", at: 2 });
  bus.publish({ type: "log", runId: "r2", stream: "stdout", line: "c", at: 3 });
  bus.publish({ type: "ping", at: 4 });
  unsubscribe();
  bus.publish({ type: "ping", at: 5 });

  assert.deepEqual(seen, ["log", "log", "log", "ping"]);
  assert.deepEqual(
    bus.history("r1").map((l) => l.line),
    ["a", "b"],
  );
  assert.equal(bus.subscriberCount, 0);
});

test("a throwing subscriber does not break the others", () => {
  const bus = new EventBus();
  const seen: number[] = [];
  bus.subscribe(() => {
    throw new Error("bad subscriber");
  });
  bus.subscribe((event) => {
    if (event.type === "ping") seen.push(event.at);
  });
  bus.publish({ type: "ping", at: 7 });
  assert.deepEqual(seen, [7]);
});
