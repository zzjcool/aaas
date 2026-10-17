import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "./app.ts";
import { createEchoAdapter } from "./echo-adapter.ts";
import { Db } from "../core/db.ts";
import { EventBus, LogStore } from "../core/events.ts";
import { JobStore } from "../core/jobstore.ts";
import { AgentRegistry, TriggerRegistry } from "../core/registry.ts";
import { Runner } from "../core/runner.ts";
import { Scheduler } from "../core/scheduler.ts";
import { createCronTrigger } from "../triggers/cron.ts";
import { manualTrigger } from "../triggers/manual.ts";

const TZ = "Asia/Shanghai";

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "aaas-api-"));
  const dataDir = join(dir, "data");
  const jobsDir = join(dir, "jobs");
  const db = new Db(join(dataDir, "aaas.db"));
  const logs = new LogStore(dataDir);
  const bus = new EventBus();

  const triggers = new TriggerRegistry();
  triggers.register(createCronTrigger({ defaultTimezone: TZ }) as never);
  triggers.register(manualTrigger as never);

  const agents = new AgentRegistry();
  agents.register(createEchoAdapter());

  const runner = new Runner({ db, logs, bus, maxConcurrency: 2 });
  const jobs = new JobStore({
    dir: jobsDir,
    validateTrigger: (raw) => {
      const type = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).type : undefined;
      const plugin = typeof type === "string" ? triggers.get(type) : undefined;
      return plugin ? plugin.validate(raw) : { ok: false, errors: [`unknown trigger type: ${String(type)}`] };
    },
    validateAgent: (raw) => {
      const type = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).type : undefined;
      const adapter = typeof type === "string" ? agents.get(type) : undefined;
      return adapter ? adapter.validate(raw) : { ok: false, errors: [`unknown agent type: ${String(type)}`] };
    },
    describeTrigger: (raw) => {
      const type = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).type : undefined;
      const plugin = typeof type === "string" ? triggers.get(type) : undefined;
      return plugin ? plugin.describe(raw) : "unknown trigger";
    },
  });

  const scheduler = new Scheduler({
    triggers,
    agents,
    runner,
    db,
    defaultTimezone: TZ,
    tickMs: 1000,
    missedGraceMs: 60_000,
  });

  const reloadJobs = () => {
    const { jobs: loaded } = jobs.load();
    scheduler.setJobs(loaded.map((job) => ({ spec: job.spec, problem: job.problem })));
  };
  reloadJobs();

  return { dir, dataDir, jobsDir, db, logs, bus, triggers, agents, runner, jobs, scheduler, reloadJobs };
}

function specBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "api-job",
    name: "API Job",
    enabled: true,
    trigger: { type: "cron", cron: "0 9 * * 1-5", timezone: TZ },
    agent: { type: "echo", cwd: "/tmp" },
    prompt: "say hello",
    timeoutMs: 5000,
    retries: 0,
    ...overrides,
  };
}

async function withApp(
  fn: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void>,
): Promise<void> {
  const harness = makeHarness();
  const app = await buildApp({
    ...harness,
    defaultTimezone: TZ,
    version: "test",
    startedAt: Date.now(),
    webDir: null,
  });
  try {
    await fn({ ...harness, app });
  } finally {
    await app.close();
    harness.scheduler.stop();
    harness.db.close();
    harness.logs.closeAll();
    rmSync(harness.dir, { recursive: true, force: true });
  }
}

async function setup(harness: ReturnType<typeof makeHarness>) {
  const app = await buildApp({
    ...harness,
    defaultTimezone: TZ,
    version: "test",
    startedAt: Date.now(),
    webDir: null,
  });
  return { ...harness, app };
}

/* ------------------------------------------------------------------ */

test("health and status report engine state", async () => {
  await withApp(async ({ app }) => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    const healthBody = health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.defaultTimezone, TZ);

    const status = await app.inject({ method: "GET", url: "/api/status" });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().maxConcurrency, 2);
  });
});

test("trigger and agent plugins are discoverable with form descriptors", async () => {
  await withApp(async ({ app }) => {
    const triggers = (await app.inject({ method: "GET", url: "/api/triggers" })).json();
    assert.deepEqual(triggers.map((t: { type: string }) => t.type).sort(), ["cron", "manual"]);
    const cron = triggers.find((t: { type: string }) => t.type === "cron");
    assert.ok(cron.fields.some((f: { key: string }) => f.key === "cron"));
    assert.ok(cron.fields.some((f: { key: string }) => f.key === "every"));
    assert.ok(cron.fields.some((f: { key: string }) => f.key === "timezone"));

    const agents = (await app.inject({ method: "GET", url: "/api/agents" })).json();
    assert.deepEqual(agents.map((a: { type: string }) => a.type), ["echo"]);
  });
});

test("creating a job writes YAML, validates plugins, and exposes next fire", async () => {
  await withApp(async ({ app, jobsDir, jobs }) => {
    const created = await app.inject({ method: "POST", url: "/api/jobs", payload: specBody() });
    assert.equal(created.statusCode, 201, created.body);
    const view = created.json().job;
    assert.equal(view.spec.id, "api-job");
    assert.ok(view.nextFireAt !== null, "next fire must be computed from the cron expression");
    assert.ok(view.nextFireAt > Date.now());
    assert.match(view.scheduleText, /weekday/i);

    const yaml = jobs.load().jobs;
    assert.equal(yaml.length, 1);
    assert.ok(yaml[0]?.sourcePath.startsWith(jobsDir));
  });
});

test("creating a duplicate job is rejected with 409", async () => {
  await withApp(async ({ app }) => {
    assert.equal((await app.inject({ method: "POST", url: "/api/jobs", payload: specBody() })).statusCode, 201);
    const duplicate = await app.inject({ method: "POST", url: "/api/jobs", payload: specBody() });
    assert.equal(duplicate.statusCode, 409);
  });
});

test("validation errors are returned with field paths", async () => {
  await withApp(async ({ app }) => {
    const badId = await app.inject({ method: "POST", url: "/api/jobs", payload: specBody({ id: "Bad Id!" }) });
    assert.equal(badId.statusCode, 422);
    assert.ok(badId.json().details.some((d: { path: string }) => d.path === "id"));

    const badTrigger = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: specBody({ trigger: { type: "cron", cron: "nonsense" } }),
    });
    assert.equal(badTrigger.statusCode, 422);
    assert.match(badTrigger.json().error, /invalid trigger/);

    const unknownAgent = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: specBody({ agent: { type: "ghost", cwd: "/tmp" } }),
    });
    assert.equal(unknownAgent.statusCode, 422);
    assert.match(unknownAgent.json().error, /invalid agent/);
  });
});

test("updating and toggling a job persists through YAML", async () => {
  await withApp(async ({ app, jobs }) => {
    await app.inject({ method: "POST", url: "/api/jobs", payload: specBody() });

    const updated = await app.inject({
      method: "PUT",
      url: "/api/jobs/api-job",
      payload: specBody({ name: "Renamed", prompt: "updated prompt" }),
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().job.spec.name, "Renamed");
    assert.equal(jobs.load().jobs[0]?.spec.prompt, "updated prompt");

    const toggled = await app.inject({ method: "POST", url: "/api/jobs/api-job/enabled", payload: { enabled: false } });
    assert.equal(toggled.statusCode, 200);
    assert.equal(toggled.json().spec.enabled, false);
    assert.equal(toggled.json().nextFireAt, null, "disabled jobs must not report a next fire");
    assert.equal(jobs.load().jobs[0]?.spec.enabled, false);
  });
});

test("running a job streams logs and finishes with a stored run record", async () => {
  await withApp(async ({ app }) => {
    await app.inject({ method: "POST", url: "/api/jobs", payload: specBody() });
    const runResponse = await app.inject({ method: "POST", url: "/api/jobs/api-job/run", payload: {} });
    assert.equal(runResponse.statusCode, 202, runResponse.body);
    const runId = runResponse.json().run.id as string;

    // Wait for the run to leave the queue.
    let record = null;
    for (let i = 0; i < 100; i += 1) {
      const response = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
      record = response.json();
      if (record.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(record.status, "succeeded");
    assert.equal(record.resultText, "echo: say hello");
    assert.deepEqual(record.tokens, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 });

    const log = await app.inject({ method: "GET", url: `/api/runs/${runId}/log` });
    assert.equal(log.statusCode, 200);
    const lines = log.json().lines as { stream: string; line: string }[];
    assert.ok(lines.some((l) => l.stream === "system" && l.line.includes("queued job=api-job")));
    assert.ok(lines.some((l) => l.stream === "stdout" && l.line === "say"));

    const list = await app.inject({ method: "GET", url: "/api/runs?jobId=api-job" });
    assert.equal(list.json().length, 1);
    const filtered = await app.inject({ method: "GET", url: "/api/runs?status=failed" });
    assert.equal(filtered.json().length, 0);
  });
});

test("schedule preview returns ascending fires in the requested timezone", async () => {
  await withApp(async ({ app }) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/schedule/preview",
      payload: { cron: "0 9 * * 1-5", timezone: TZ, count: 3, after: Date.parse("2026-10-17T00:00:00Z") },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.fires.length, 3);
    assert.match(body.scheduleText, /weekday/i);
    for (let i = 1; i < body.fires.length; i += 1) {
      assert.ok(body.fires[i] > body.fires[i - 1]);
    }
    // 09:00 Asia/Shanghai == 01:00 UTC
    assert.equal(new Date(body.fires[0]).toISOString(), "2026-10-19T01:00:00.000Z");
  });
});

test("schedule preview reports invalid expressions instead of throwing", async () => {
  await withApp(async ({ app }) => {
    const response = await app.inject({ method: "POST", url: "/api/schedule/preview", payload: { cron: "nope" } });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().error);
    assert.deepEqual(response.json().fires, []);
  });
});

test("unknown endpoints and jobs return 404", async () => {
  await withApp(async ({ app }) => {
    assert.equal((await app.inject({ method: "GET", url: "/api/jobs/ghost" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/runs/ghost" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/nothing" })).statusCode, 404);
  });
});

test("a malformed job file surfaces as a problem instead of breaking the list", async () => {
  const harness = makeHarness();
  writeFileSync(join(harness.jobsDir, "broken.yaml"), "id: broken\nprompt: [unclosed\n", "utf8");
  const app = await buildApp({
    ...harness,
    defaultTimezone: TZ,
    version: "test",
    startedAt: Date.now(),
    webDir: null,
  });
  try {
    const jobs = (await app.inject({ method: "GET", url: "/api/jobs" })).json();
    const broken = jobs.find((j: { spec: { id: string } }) => j.spec.id === "broken");
    assert.ok(broken, "broken file must still appear in the list");
    assert.match(broken.problem, /YAML parse error/);
  } finally {
    await app.close();
    harness.scheduler.stop();
    harness.db.close();
    harness.logs.closeAll();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

test("deleting a job removes the YAML file", async () => {
  await withApp(async ({ app, jobs }) => {
    await app.inject({ method: "POST", url: "/api/jobs", payload: specBody() });
    assert.equal((await app.inject({ method: "DELETE", url: "/api/jobs/api-job" })).statusCode, 204);
    assert.equal(jobs.load().jobs.length, 0);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/jobs/api-job" })).statusCode, 404);
  });
});

test("cancel reports zero when nothing is running", async () => {
  await withApp(async ({ app }) => {
    await app.inject({ method: "POST", url: "/api/jobs", payload: specBody() });
    const response = await app.inject({ method: "POST", url: "/api/jobs/api-job/cancel" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().cancelled, 0);
  });
});
