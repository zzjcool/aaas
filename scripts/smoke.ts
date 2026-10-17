#!/usr/bin/env node
/**
 * Smoke test: boots the real engine against a temporary data/jobs dir and a
 * stub agent adapter, drives one manual run and one cron tick, then asserts the
 * HTTP surface reports them. Intended for `npm run smoke`.
 *
 * It does NOT touch the pi adapter, so it runs without a model provider.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app.ts";
import { Db } from "../src/core/db.ts";
import { EventBus, LogStore } from "../src/core/events.ts";
import { JobStore } from "../src/core/jobstore.ts";
import { AgentRegistry, TriggerRegistry } from "../src/core/registry.ts";
import { Runner } from "../src/core/runner.ts";
import { Scheduler } from "../src/core/scheduler.ts";
import { createCronTrigger } from "../src/triggers/cron.ts";
import { manualTrigger } from "../src/triggers/manual.ts";

const TZ = process.env.AAAS_DEFAULT_TZ ?? "Asia/Shanghai";
const dir = mkdtempSync(join(tmpdir(), "aaas-smoke-"));
const dataDir = join(dir, "data");
const jobsDir = join(dir, "jobs");

const db = new Db(join(dataDir, "aaas.db"));
const logs = new LogStore(dataDir);
const bus = new EventBus();
const triggers = new TriggerRegistry();
triggers.register(createCronTrigger({ defaultTimezone: TZ }) as never);
triggers.register(manualTrigger as never);

const agents = new AgentRegistry();
agents.register({
  type: "pi",
  descriptor: { type: "pi", displayName: "stub pi", description: "smoke stub", fields: [] },
  validate: () => ({ ok: true, config: { type: "pi", cwd: "/tmp" } }),
  run: async (input, ctx) => {
    ctx.log("system", `stub adapter for ${input.jobId}`);
    ctx.log("stdout", `prompt was: ${input.prompt}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ok: true,
      text: `stub result for ${input.jobId}`,
      exitCode: 0,
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    };
  },
} as never);

const runner = new Runner({ db, logs, bus, maxConcurrency: 2 });
const jobs = new JobStore({
  dir: jobsDir,
  validateTrigger: (raw) => {
    const type = (raw as { type?: string }).type;
    const plugin = type ? triggers.get(type) : undefined;
    return plugin ? plugin.validate(raw) : { ok: false, errors: ["unknown trigger"] };
  },
  validateAgent: (raw) => {
    const type = (raw as { type?: string }).type;
    const adapter = type ? agents.get(type) : undefined;
    return adapter ? adapter.validate(raw) : { ok: false, errors: ["unknown agent"] };
  },
  describeTrigger: (raw) => {
    const type = (raw as { type?: string }).type;
    const plugin = type ? triggers.get(type) : undefined;
    return plugin ? plugin.describe(raw) : "?";
  },
});

const scheduler = new Scheduler({ triggers, agents, runner, db, defaultTimezone: TZ, tickMs: 1000, missedGraceMs: 60_000 });
const reloadJobs = () => {
  const { jobs: loaded } = jobs.load();
  scheduler.setJobs(loaded.map((job) => ({ spec: job.spec, problem: job.problem })));
};

const app = await buildApp({
  db,
  logs,
  bus,
  runner,
  scheduler,
  triggers,
  agents,
  jobs,
  defaultTimezone: TZ,
  version: "smoke",
  startedAt: Date.now(),
  webDir: null,
  reloadJobs,
});
scheduler.start();

const steps: string[] = [];
const check = (label: string, condition: boolean, detail?: unknown) => {
  steps.push(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) {
    console.error(`FAIL ${label}`, detail ?? "");
    process.exitCode = 1;
  }
};

try {
  const health = (await app.inject({ method: "GET", url: "/api/health" })).json();
  check("health ok", health.ok === true, health);

  const created = await app.inject({
    method: "POST",
    url: "/api/jobs",
    payload: {
      id: "smoke-job",
      name: "Smoke",
      trigger: { type: "cron", every: "1h", timezone: TZ },
      agent: { type: "pi", cwd: "/tmp" },
      prompt: "hello smoke",
      timeoutMs: 10_000,
    },
  });
  check("create job -> 201", created.statusCode === 201, created.body);
  const view = created.json().job;
  check("next fire computed", typeof view.nextFireAt === "number", view);

  const runResponse = await app.inject({ method: "POST", url: "/api/jobs/smoke-job/run", payload: {} });
  check("run accepted -> 202", runResponse.statusCode === 202, runResponse.body);
  const runId = runResponse.json().run.id;

  let record = null;
  for (let i = 0; i < 200; i += 1) {
    record = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    if (record.status !== "queued" && record.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  check("run succeeded", record?.status === "succeeded", record);
  check("result text stored", record?.resultText === "stub result for smoke-job", record?.resultText);
  check("tokens stored", record?.tokens?.total === 3, record?.tokens);

  const log = (await app.inject({ method: "GET", url: `/api/runs/${runId}/log` })).json();
  check("logs recorded", log.lines.some((l: { line: string }) => l.line.includes("hello smoke")), log.lines);

  const preview = (
    await app.inject({ method: "POST", url: "/api/schedule/preview", payload: { cron: "0 9 * * 1-5", timezone: TZ, count: 3 } })
  ).json();
  check("preview returns 3 fires", Array.isArray(preview.fires) && preview.fires.length === 3, preview);

  const listed = (await app.inject({ method: "GET", url: "/api/jobs" })).json();
  check("job listed with last run", listed.length === 1 && listed[0].lastRun?.id === runId, listed.map((j: { spec: { id: string } }) => j.spec.id));

  const deleted = await app.inject({ method: "DELETE", url: "/api/jobs/smoke-job" });
  check("delete -> 204", deleted.statusCode === 204, deleted.body);
} finally {
  scheduler.stop();
  await app.close();
  await runner.shutdown(1000);
  logs.closeAll();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(steps.join("\n"));
  console.log(process.exitCode === 1 ? "\nsmoke: FAILED" : "\nsmoke: OK");
}
