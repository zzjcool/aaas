import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildApp } from "./app.ts";
import { Db } from "../core/db.ts";
import { EventBus, LogStore } from "../core/events.ts";
import { JobStore } from "../core/jobstore.ts";
import { AgentRegistry, TriggerRegistry } from "../core/registry.ts";
import { Runner } from "../core/runner.ts";
import { Scheduler } from "../core/scheduler.ts";
import { createCronTrigger } from "../triggers/cron.ts";
import { manualTrigger } from "../triggers/manual.ts";
import { piAgent } from "../agents/pi/index.ts";

const VERSION = "0.1.0";

export interface BootOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  jobsDir?: string;
  webDir?: string | null;
  defaultTimezone?: string;
  maxConcurrency?: number;
  tickMs?: number;
  missedGraceMs?: number;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

export async function boot(options: BootOptions = {}) {
  const defaultLog = (level: string, message: string, detail?: unknown) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (level === "error") console.error(line, detail ?? "");
    else if (level === "warn") console.warn(line, detail ?? "");
    else console.log(line, detail ?? "");
  };
  const log = options.log ?? defaultLog;

  const dataDir = resolve(options.dataDir ?? process.env.AAAS_DATA_DIR ?? "data");
  const jobsDir = resolve(options.jobsDir ?? process.env.AAAS_JOBS_DIR ?? "jobs");
  const defaultTimezone = options.defaultTimezone ?? process.env.AAAS_DEFAULT_TZ ?? "Asia/Shanghai";
  const maxConcurrency = options.maxConcurrency ?? Number(process.env.AAAS_MAX_CONCURRENCY ?? 2);
  const tickMs = options.tickMs ?? Number(process.env.AAAS_TICK_MS ?? 1000);
  const missedGraceMs = options.missedGraceMs ?? Number(process.env.AAAS_MISSED_GRACE_MS ?? 60_000);
  const candidates = [options.webDir ?? process.env.AAAS_WEB_DIR ?? join(process.cwd(), "web", "dist"), join(process.cwd(), "web", "dist")];
  const webDir = candidates.find((candidate) => candidate && existsSync(join(candidate, "index.html"))) ?? null;

  const startedAt = Date.now();
  const db = new Db(join(dataDir, "aaas.db"));
  const logs = new LogStore(dataDir);
  const bus = new EventBus();

  const staleRuns = db.markStaleRuns("engine restarted while this run was live", startedAt);
  if (staleRuns > 0) log("warn", `marked ${staleRuns} stale run(s) as failed`);

  const triggers = new TriggerRegistry();
  triggers.register(createCronTrigger({ defaultTimezone }) as never);
  triggers.register(manualTrigger as never);

  const agents = new AgentRegistry();
  agents.register(piAgent);

  const runner = new Runner({ db, logs, bus, maxConcurrency });

  const jobs = new JobStore({
    dir: jobsDir,
    validateTrigger: (raw) => {
      const type = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).type : undefined;
      const plugin = typeof type === "string" ? triggers.get(type) : undefined;
      if (!plugin) return { ok: false, errors: [`unknown trigger type: ${String(type)}`] };
      return plugin.validate(raw);
    },
    validateAgent: (raw) => {
      const type = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).type : undefined;
      const adapter = typeof type === "string" ? agents.get(type) : undefined;
      if (!adapter) return { ok: false, errors: [`unknown agent type: ${String(type)}`] };
      return adapter.validate(raw);
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
    defaultTimezone,
    tickMs,
    missedGraceMs,
    log,
  });

  const reloadJobs = () => {
    const { jobs: loaded, errors } = jobs.load();
    scheduler.setJobs(loaded.map((job) => ({ spec: job.spec, problem: job.problem })));
    for (const error of errors) log("warn", `job file rejected: ${error.sourcePath}`, error.problem);
    log("info", `loaded ${loaded.length} job(s) from ${jobs.dir}`);
    return loaded;
  };

  const initial = reloadJobs();
  if (initial.length === 0) log("info", "no jobs declared yet — create one with `npm run cli -- job create` or POST /api/jobs");

  const app = await buildApp({
    db,
    logs,
    bus,
    runner,
    scheduler,
    triggers,
    agents,
    jobs,
    defaultTimezone,
    version: VERSION,
    startedAt,
    webDir,
    reloadJobs,
  });

  scheduler.start();

  const port = options.port ?? Number(process.env.AAAS_PORT ?? 7788);
  const host = options.host ?? process.env.AAAS_HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  log("info", `aaas listening on http://${host}:${port}${webDir ? ` (ui: ${webDir})` : " (ui not built)"}`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log("info", `received ${signal}, shutting down`);
    scheduler.stop();
    await app.close();
    await runner.shutdown();
    logs.closeAll();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return { app, db, logs, bus, runner, scheduler, triggers, agents, jobs, webDir, port, host };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const booted = await boot();
  void booted;
}
