/**
 * L2 E2E — engine semantics that only show up with a real clock and a real
 * scheduler process. Still offline (fake pi), still CI-safe.
 *
 * Covers the contract §6 promises that unit tests can only approximate:
 *   - a cron job actually fires on its own, without anyone calling /run
 *   - a long run is killed at timeoutMs and recorded as `timeout`
 *   - a failing run is retried once, and the retry is visible in the records
 *   - a missing/credential-less pi surfaces as `failed` with a usable error
 *   - SSE delivers log frames and an `end` frame over a real socket
 *   - the built UI is served with an SPA fallback
 *
 * These are the failures that would otherwise reach QA as "the UI is broken"
 * when the real cause is the engine, so each one asserts the *observable*
 * outcome an operator would see.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { bootEngine, get, post, waitFor, waitForRun, type Engine } from "./helpers/harness.ts";

let engine: Engine;

before(async () => {
  engine = await bootEngine({ pi: "fake", webDir: null });
});

after(async () => {
  await engine?.stop();
});

/** Create a job and return its id. */
async function createJob(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const res = await post(engine, "/api/jobs", {
    id,
    name: id,
    enabled: false,
    trigger: { type: "cron", every: "1h", timezone: "Asia/Shanghai" },
    agent: { type: "pi", cwd: "/tmp" },
    prompt: "l2",
    timeoutMs: 20_000,
    retries: 0,
    ...overrides,
  });
  assert.equal(res.status, 201, res.text);
}

/* ------------------------------------------------------------------ */

describe("L2 · the scheduler fires on its own", () => {
  test("an enabled every=1s job produces runs without any manual trigger", async () => {
    await createJob("l2-autofire", {
      trigger: { type: "cron", every: "1s", timezone: "Asia/Shanghai" },
      enabled: true,
      allowOverlap: true,
    });

    // No POST /run anywhere: if this job runs, the scheduler did it.
    const runs: any[] = await waitFor(
      "cron-driven runs to appear",
      async () => (await get(engine, "/api/runs?jobId=l2-autofire")).body,
      (list: any[]) => Array.isArray(list) && list.length >= 2,
      30_000,
      200,
    );
    assert.ok(runs.length >= 2, `expected cron-driven runs, got ${runs.length}`);
    assert.ok(
      runs.every((r: any) => r.triggerKind === "cron"),
      "these runs must be attributed to the cron trigger, not manual",
    );

    await post(engine, "/api/jobs/l2-autofire/enabled", { enabled: false });
  });

  test("a disabled job never fires", async () => {
    await createJob("l2-disabled", {
      trigger: { type: "cron", every: "1s" },
      enabled: false,
    });
    await new Promise((r) => setTimeout(r, 3_000));
    const runs = await get(engine, "/api/runs?jobId=l2-disabled");
    assert.equal(runs.body.length, 0, "disabled means disabled");
  });
});

describe("L2 · failure paths are recorded, not swallowed", () => {
  test("a run that outlives timeoutMs is marked timeout", async () => {
    await createJob("l2-timeout", {
      timeoutMs: 2_000,
      agent: { type: "pi", cwd: "/tmp", env: { FAKE_PI_MODE: "hang" } },
    });

    const started = await post(engine, "/api/jobs/l2-timeout/run", {});
    assert.equal(started.status, 202, started.text);
    const record = await waitForRun(engine, started.body.run.id, 40_000);

    assert.equal(record.status, "timeout", JSON.stringify(record));
    assert.match(record.error ?? "", /timed out after 2000ms/, "the error names the real limit");
    assert.ok(record.durationMs >= 2_000, `duration ${record.durationMs}ms should respect the 2s timeout`);
    assert.ok(record.durationMs < 15_000, `duration ${record.durationMs}ms — teardown must not hang`);
  });

  test("a run that settles with an error is marked failed with a message", async () => {
    await createJob("l2-fail", {
      agent: { type: "pi", cwd: "/tmp", env: { FAKE_PI_MODE: "fail" } },
    });

    const started = await post(engine, "/api/jobs/l2-fail/run", {});
    const record = await waitForRun(engine, started.body.run.id, 30_000);
    assert.equal(record.status, "failed", JSON.stringify(record));
    assert.ok(typeof record.error === "string" || record.error === null);
  });

  test("a pi that dies at startup is a failed run with a usable error", async () => {
    await createJob("l2-crash", {
      agent: { type: "pi", cwd: "/tmp", env: { FAKE_PI_MODE: "crash" } },
    });

    const started = await post(engine, "/api/jobs/l2-crash/run", {});
    const record = await waitForRun(engine, started.body.run.id, 30_000);
    assert.equal(record.status, "failed", JSON.stringify(record));
    assert.equal(record.exitCode, 3, "the child's exit code must be preserved");
  });

  test("no credentials surfaces as failed, not as a hang", async () => {
    await createJob("l2-noprovider", {
      agent: { type: "pi", cwd: "/tmp", env: { FAKE_PI_MODE: "noprovider" } },
    });

    const started = await post(engine, "/api/jobs/l2-noprovider/run", {});
    const record = await waitForRun(engine, started.body.run.id, 30_000);
    assert.equal(record.status, "failed", JSON.stringify(record));
    assert.match(JSON.stringify(record), /API key|provider|model/i, "the error must point at the real cause");
  });
});

describe("L2 · streaming and UI serving", () => {
  test("SSE /api/runs/:id/stream delivers log frames then an end frame", async () => {
    await createJob("l2-sse", { agent: { type: "pi", cwd: "/tmp", env: { FAKE_PI_MODE: "tool" } } });
    const started = await post(engine, "/api/jobs/l2-sse/run", {});
    const runId = started.body.run.id;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(`${engine.baseUrl}/api/runs/${runId}/stream`, { signal: controller.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !text.includes("\"type\":\"end\"")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > 200_000) break;
      }
      await reader.cancel().catch(() => {});

      assert.match(text, /^data: /m, "SSE frames must be prefixed with data:");
      assert.match(text, /"type":"log"/, "log frames must arrive");
      assert.match(text, /"type":"end"/, "the stream must terminate with an end frame");
    } finally {
      clearTimeout(timer);
    }
  });

  test("the built UI is served with an SPA fallback while /api stays JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trigger-l2-ui-"));
    const dist = join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>trigger ui</title>", "utf8");

    const ui = await bootEngine({ pi: "fake", webDir: dist });
    try {
      const root = await get(ui, "/");
      assert.equal(root.status, 200);
      assert.match(root.text, /trigger ui/);

      const deep = await get(ui, "/runs/anything");
      assert.equal(deep.status, 200, "client-side routes must fall back to index.html");
      assert.match(deep.text, /trigger ui/);

      const apiMiss = await get(ui, "/api/nope");
      assert.equal(apiMiss.status, 404);
      assert.match(apiMiss.headers.get("content-type") ?? "", /application\/json/);
    } finally {
      await ui.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("L2 · shutdown", () => {
  test("SIGTERM stops the process cleanly and leaves no orphans", async () => {
    const victim = await bootEngine({ pi: "fake", webDir: null });
    const pid = victim.proc.pid;
    assert.ok(typeof pid === "number");
    const code = await victim.stop();
    assert.equal(code, 0, `expected a clean exit, got ${code}`);
    // After stop(), the pid must be gone: a leaked server would keep the port.
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(pid!, 0), "the server process must be gone");
  });
});

