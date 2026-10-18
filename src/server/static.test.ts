import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "./app.ts";
import { Db } from "../core/db.ts";
import { EventBus, LogStore } from "../core/events.ts";
import { JobStore } from "../core/jobstore.ts";
import { AgentRegistry, TriggerRegistry } from "../core/registry.ts";
import { Runner } from "../core/runner.ts";
import { Scheduler } from "../core/scheduler.ts";
import { createCronTrigger } from "../triggers/cron.ts";
import { manualTrigger } from "../triggers/manual.ts";
import { createEchoAdapter } from "./echo-adapter.ts";

const TZ = "Asia/Shanghai";

function harness(webDir: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "trigger-static-"));
  const dataDir = join(dir, "data");
  const jobsDir = join(dir, "jobs");
  const db = new Db(join(dataDir, "trigger.db"));
  const logs = new LogStore(dataDir);
  const bus = new EventBus();
  const triggers = new TriggerRegistry();
  triggers.register(createCronTrigger({ defaultTimezone: TZ }) as never);
  triggers.register(manualTrigger as never);
  const agents = new AgentRegistry();
  agents.register(createEchoAdapter());
  const runner = new Runner({ db, logs, bus, maxConcurrency: 1 });
  const jobs = new JobStore({
    dir: jobsDir,
    validateTrigger: () => ({ ok: true }),
    validateAgent: () => ({ ok: true }),
    describeTrigger: () => "x",
  });
  const scheduler = new Scheduler({
    triggers,
    agents,
    runner,
    db,
    defaultTimezone: TZ,
    tickMs: 1000,
    missedGraceMs: 0,
  });
  return { dir, db, logs, bus, triggers, agents, runner, jobs, scheduler, reloadJobs: () => {}, webDir };
}

test("built UI is served with an SPA fallback while /api keeps returning JSON 404s", async () => {
  const h = harness(null);
  const staticDir = join(h.dir, "dist");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>trigger</title>", "utf8");
  const app = await buildApp({
    ...h,
    webDir: staticDir,
    defaultTimezone: TZ,
    version: "test",
    startedAt: Date.now(),
  });
  try {
    const root = await app.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 200);
    assert.match(root.body, /trigger/);

    const deepLink = await app.inject({ method: "GET", url: "/runs/whatever" });
    assert.equal(deepLink.statusCode, 200);
    assert.match(deepLink.body, /trigger/, "client-side routes must fall back to index.html");

    const apiMiss = await app.inject({ method: "GET", url: "/api/nope" });
    assert.equal(apiMiss.statusCode, 404);
    assert.match(apiMiss.headers["content-type"] as string, /application\/json/);
  } finally {
    await app.close();
    h.scheduler.stop();
    h.db.close();
    h.logs.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("without a build, api still works and unknown routes 404", async () => {
  const h = harness(null);
  const app = await buildApp({
    ...h,
    webDir: null,
    defaultTimezone: TZ,
    version: "test",
    startedAt: Date.now(),
  });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/" })).statusCode, 404);
  } finally {
    await app.close();
    h.scheduler.stop();
    h.db.close();
    h.logs.closeAll();
    rmSync(h.dir, { recursive: true, force: true });
  }
});
