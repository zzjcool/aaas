/**
 * L1 E2E — offline, CI-safe.
 *
 * Boots the real server as a subprocess and drives it over real HTTP. The pi
 * binary is the deterministic fixture (tests/e2e/fixtures/fake-pi.mjs), so the
 * REAL pi adapter runs — spawn, argv, JSONL RPC, transcript, token accounting,
 * abort escalation — with only the model swapped out.
 *
 * What this suite guarantees that unit tests cannot:
 *   - the HTTP contract (status codes, error shapes) as an external client sees it
 *   - jobs/*.yaml really is the source of truth (write → reload → serve)
 *   - a run's full lifecycle (queued → running → succeeded) with real scheduling
 *   - logs, SSE and static UI serving work over a real socket
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  bootEngine,
  del,
  get,
  jobFile,
  jobFileExists,
  post,
  put,
  waitForRun,
  type Engine,
} from "./helpers/harness.ts";

let engine: Engine;

before(async () => {
  engine = await bootEngine({ pi: "fake", webDir: null });
});

after(async () => {
  await engine?.stop();
});

describe("L1 · service surface", () => {
  test("health reports ok with version, timezone and live counters", async () => {
    const res = await get(engine, "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.version, "string");
    assert.equal(res.body.defaultTimezone, "Asia/Shanghai");
    assert.equal(typeof res.body.jobs, "number");
    assert.equal(typeof res.body.running, "number");
  });

  test("status reports scheduler state", async () => {
    const res = await get(engine, "/api/status");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.jobs, "number");
    assert.equal(typeof res.body.enabledJobs, "number");
    assert.ok(Array.isArray(res.body.running));
    assert.equal(typeof res.body.startedAt, "number");
  });

  test("registered triggers and agents are discoverable with descriptors", async () => {
    const triggers = await get(engine, "/api/triggers");
    assert.equal(triggers.status, 200);
    assert.deepEqual(
      triggers.body.map((t: any) => t.type).sort(),
      ["cron", "manual"],
    );

    const agents = await get(engine, "/api/agents");
    assert.equal(agents.status, 200);
    const pi = agents.body.find((a: any) => a.type === "pi");
    assert.ok(pi, "the pi adapter must be registered");
    assert.ok(pi.fields.some((f: any) => f.key === "cwd"), "descriptor drives the UI form");
  });

  test("an unknown /api route returns JSON 404, not HTML", async () => {
    const res = await get(engine, "/api/nope");
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(typeof res.body.error, "string");
  });

  test("the api keeps answering whatever the UI state is", async () => {
    assert.equal((await get(engine, "/api/health")).status, 200);
    // This boot has no web assets, so a UI route must not shadow the API.
    assert.equal((await get(engine, "/api/nope")).status, 404);
  });
});

describe("L1 · job lifecycle over HTTP", () => {
  const id = "l1-lifecycle";

  test("POST /api/jobs creates the job and persists YAML", async () => {
    const res = await post(engine, "/api/jobs", {
      id,
      name: "L1 lifecycle",
      trigger: { type: "cron", every: "1h", timezone: "Asia/Shanghai" },
      agent: { type: "pi", cwd: "/tmp" },
      prompt: "l1 hello",
      timeoutMs: 20_000,
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.job.spec.id, id);
    assert.equal(typeof res.body.job.nextFireAt, "number");
    assert.ok(jobFileExists(engine, id), "job must exist as YAML on disk");
    assert.match(jobFile(engine, id), /id: l1-lifecycle/);
  });

  test("creating the same id twice is 409", async () => {
    const res = await post(engine, "/api/jobs", {
      id,
      trigger: { type: "cron", every: "1h" },
      agent: { type: "pi", cwd: "/tmp" },
      prompt: "dup",
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already exists/);
  });

  test("invalid jobs are rejected with 422 and a field path", async () => {
    const res = await post(engine, "/api/jobs", {
      id: "l1-invalid",
      trigger: { type: "nope" },
      agent: { type: "pi", cwd: "/tmp" },
      prompt: "x",
    });
    assert.equal(res.status, 422);
    assert.ok(Array.isArray(res.body.details));
  });

  test("PUT updates the job and the YAML follows", async () => {
    const res = await put(engine, `/api/jobs/${id}`, {
      id,
      name: "L1 renamed",
      trigger: { type: "cron", every: "2h" },
      agent: { type: "pi", cwd: "/tmp" },
      prompt: "l1 hello",
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.job.spec.name, "L1 renamed");
    assert.match(jobFile(engine, id), /L1 renamed/);
  });

  test("toggling enabled persists and stops scheduling", async () => {
    const off = await post(engine, `/api/jobs/${id}/enabled`, { enabled: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.body.spec.enabled, false);

    const listed = await get(engine, "/api/jobs");
    const view = listed.body.find((j: any) => j.spec.id === id);
    assert.equal(view.spec.enabled, false);
    assert.equal(view.nextFireAt, null, "a disabled job must have no next fire");
    assert.match(jobFile(engine, id), /enabled: false/);

    await post(engine, `/api/jobs/${id}/enabled`, { enabled: true });
  });

  test("manual run → succeeded, with transcript and tokens", async () => {
    const started = await post(engine, `/api/jobs/${id}/run`, {});
    assert.equal(started.status, 202, started.text);
    const runId = started.body.run.id;
    assert.ok(typeof runId === "string" && runId.length > 0);

    const record = await waitForRun(engine, runId);
    assert.equal(record.status, "succeeded", JSON.stringify(record));
    assert.match(record.resultText ?? "", /fake pi answer/);
    assert.equal(record.tokens?.total, 18, "tokens come from the RPC usage block");
    assert.equal(record.triggerKind, "manual");

    // The transcript is the audit trail: it must show the real spawn line and
    // the streamed model output, or an operator cannot debug a failed run.
    const log = await get(engine, `/api/runs/${runId}/log`);
    assert.ok(log.body.lines.length > 0, "the run must have a transcript");
    const lines = log.body.lines.map((l: any) => l.line).join("\n");
    assert.match(lines, /spawn .* --mode rpc --no-session/, "the spawn argv is recorded");
    assert.match(lines, /fake pi answer/, "streamed output is recorded");
    assert.ok(
      log.body.lines.some((l: any) => l.stream === "system"),
      "system lines (queue/attempt/spawn) are part of the transcript",
    );
  });

  test("runs are listed and filterable by job", async () => {
    const all = await get(engine, `/api/runs?limit=50`);
    assert.equal(all.status, 200);
    assert.ok(all.body.length >= 1);

    const byJob = await get(engine, `/api/runs?jobId=${id}`);
    assert.ok(byJob.body.length >= 1);
    assert.ok(byJob.body.every((r: any) => r.jobId === id));
  });

  test("GET /api/jobs/:id returns the full view, not just 404s", async () => {
    // The 404 path was covered; the 200 shape is what the UI actually renders
    // (nextFireAt / scheduleText / lastRun / runningCount / problem), and it had
    // no assertion anywhere.
    const res = await get(engine, `/api/jobs/${id}`);
    assert.equal(res.status, 200, res.text);
    const view = res.body;
    assert.equal(view.spec.id, id);
    assert.equal(typeof view.scheduleText, "string");
    assert.ok(view.scheduleText.length > 0, "scheduleText is rendered in the job list");
    assert.ok("nextFireAt" in view);
    assert.equal(typeof view.runningCount, "number");
    assert.ok("lastRun" in view && "problem" in view);
    assert.equal(typeof view.sourcePath, "string");
  });

  test("GET /api/jobs/:id/runs lists one job's history with limit clamping", async () => {
    // Contract §5 has this endpoint; nothing in the repo exercised it, and the
    // clampInt bounds (1..500) were unverified.
    const res = await get(engine, `/api/jobs/${id}/runs`);
    assert.equal(res.status, 200, res.text);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1);
    assert.ok(res.body.every((r: any) => r.jobId === id));

    const limited = await get(engine, `/api/jobs/${id}/runs?limit=1`);
    assert.equal(limited.status, 200, limited.text);
    assert.equal(limited.body.length, 1, "limit=1 must clamp the result");

    // Out-of-range limits must be clamped, never passed through to SQL.
    for (const bad of ["0", "9999", "abc", "-1"]) {
      const r = await get(engine, `/api/jobs/${id}/runs?limit=${bad}`);
      assert.equal(r.status, 200, `limit=${bad} must not error: ${r.text}`);
      assert.ok(Array.isArray(r.body), `limit=${bad} must return an array`);
    }
  });

  test("DELETE removes the YAML and the job disappears", async () => {
    const res = await del(engine, `/api/jobs/${id}`);
    assert.equal(res.status, 204, res.text);
    assert.equal(jobFileExists(engine, id), false);
    assert.equal((await get(engine, `/api/jobs/${id}`)).status, 404);
  });
});

describe("L1 · schedule preview", () => {
  test("returns ascending fires in the requested timezone", async () => {
    const res = await post(engine, "/api/schedule/preview", {
      cron: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
      count: 3,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.fires.length, 3);
    const times = res.body.fires.map((f: any) => (typeof f === "number" ? f : f.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  test("an invalid expression is reported in the body, not thrown", async () => {
    // Deliberate contract: the UI renders this inline, so it is 200 + error.
    const res = await post(engine, "/api/schedule/preview", { cron: "not a cron", count: 2 });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.scheduleText, "invalid");
    assert.equal(typeof res.body.error, "string");
    assert.deepEqual(res.body.fires, []);
  });
});

describe("L1 · yaml is the source of truth", () => {
  test("a job file dropped on disk is picked up on the next boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trigger-l1-yaml-"));
    const jobsDir = join(dir, "jobs");
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(
      join(jobsDir, "from-disk.yaml"),
      [
        "id: from-disk",
        "name: From disk",
        "enabled: false",
        "trigger:",
        "  type: cron",
        "  cron: '0 9 * * *'",
        "  timezone: Asia/Shanghai",
        "agent:",
        "  type: pi",
        "  cwd: /tmp",
        "prompt: |",
        "  from disk",
        "",
      ].join("\n"),
      "utf8",
    );

    const second = await bootEngine({ pi: "fake", webDir: null, env: { TRIGGER_JOBS_DIR: jobsDir } });
    try {
      const listed = await get(second, "/api/jobs");
      const view = listed.body.find((j: any) => j.spec.id === "from-disk");
      assert.ok(view, "a job declared only as YAML must be loaded at boot");
      assert.equal(view.spec.name, "From disk");
    } finally {
      await second.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
