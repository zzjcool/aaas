import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import type {
  ApiError,
  CronPreviewRequest,
  CronPreviewResponse,
  AgentDiscovery,
  EngineStatus,
  FieldOptionSource,
  HealthResponse,
  JobSpec,
  JobView,
  RunRecord,
  RunSummary,
  SseEvent,
} from "../shared/types.ts";
import type { Db } from "../core/db.ts";
import { toSummary } from "../core/db.ts";
import type { EventBus, LogStore } from "../core/events.ts";
import type { JobStore } from "../core/jobstore.ts";
import { validateJobSpec, toJobView } from "../core/jobstore.ts";
import type { AgentRegistry, TriggerRegistry } from "../core/registry.ts";
import type { Runner } from "../core/runner.ts";
import type { Scheduler } from "../core/scheduler.ts";
import { describeSchedule, nextFire, normalizeSchedule } from "../core/schedule.ts";

/** How long a discovery result is reused before the UI has to ask again. */
const OPTION_CACHE_MS = 10 * 60_000;

export interface AppDeps {
  db: Db;
  logs: LogStore;
  bus: EventBus;
  runner: Runner;
  scheduler: Scheduler;
  triggers: TriggerRegistry;
  agents: AgentRegistry;
  jobs: JobStore;
  defaultTimezone: string;
  version: string;
  startedAt: number;
  webDir: string | null;
  reloadJobs: () => void;
}

const SSE_HEARTBEAT_MS = 15_000;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const optionCache = new Map<string, { at: number; discovery: AgentDiscovery }>();

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
    request.log.error(error);
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    const body: ApiError = { error: error.message || "internal error" };
    if (error.validation) body.error = "invalid request body";
    void reply.status(status).send(body);
  });

  /* ---------------------------------------------------------------- */
  /* Health / status                                                   */
  /* ---------------------------------------------------------------- */

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    version: deps.version,
    now: Date.now(),
    defaultTimezone: deps.defaultTimezone,
    jobs: deps.scheduler.jobCount,
    running: deps.runner.runningCount,
  }));

  app.get("/api/status", async (): Promise<EngineStatus> => {
    const runningIds = deps.db.listRunning();
    const all = deps.jobs.load().jobs;
    return {
      running: runningIds.filter((r) => r.status === "running").map(toSummary),
      queued: runningIds.filter((r) => r.status === "queued").length,
      jobs: all.length,
      enabledJobs: all.filter((j) => j.spec.enabled !== false && !j.problem).length,
      maxConcurrency: Number(process.env.AAAS_MAX_CONCURRENCY ?? 2),
      defaultTimezone: deps.defaultTimezone,
      startedAt: deps.startedAt,
    };
  });

  app.get("/api/triggers", async () => deps.triggers.list());
  app.get("/api/agents", async () => deps.agents.list());

  /**
   * Runtime choices for an agent's config fields (models, tools, …).
   *
   * Cached per process: listing models starts pi once (seconds), and the answer
   * only changes when the operator installs things. `?refresh=1` bypasses it.
   */
  app.get<{ Params: { type: string }; Querystring: { refresh?: string } }>(
    "/api/agents/:type/options",
    async (request, reply) => {
      const type = request.params.type;
      const adapter = deps.agents.get(type);
      if (!adapter) return reply.status(404).send({ error: `unknown agent type: ${type}` } satisfies ApiError);
      if (!adapter.discoverOptions) {
        return { type, options: [] as FieldOptionSource[] };
      }

      const refresh = request.query.refresh === "1" || request.query.refresh === "true";
      const cached = optionCache.get(type);
      if (!refresh && cached && Date.now() - cached.at < OPTION_CACHE_MS) {
        return { type, ...cached.discovery, cachedAt: cached.at };
      }

      let discovery: AgentDiscovery;
      try {
        discovery = await adapter.discoverOptions();
      } catch (err) {
        // Discovery is best-effort: the UI falls back to free text.
        discovery = {
          options: [{ key: "*", options: [], error: err instanceof Error ? err.message : String(err) }],
        };
      }
      optionCache.set(type, { at: Date.now(), discovery });
      return { type, ...discovery, cachedAt: Date.now(), fresh: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Jobs                                                              */
  /* ---------------------------------------------------------------- */

  app.get("/api/jobs", async (): Promise<JobView[]> => listJobViews(deps));

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply): Promise<JobView | FastifyReply> => {
    const view = listJobViews(deps).find((j) => j.spec.id === request.params.id);
    if (!view) return reply.status(404).send({ error: `job not found: ${request.params.id}` } satisfies ApiError);
    return view;
  });

  app.post("/api/jobs", async (request, reply) => {
    const validated = validateJobSpec(request.body);
    if (!validated.ok) return reply.status(422).send({ error: "invalid job", details: validated.issues } satisfies ApiError);
    const spec = validated.spec;

    const existing = deps.jobs.load().jobs.find((j) => j.spec.id === spec.id);
    if (existing) {
      return reply.status(409).send({ error: `job already exists: ${spec.id}` } satisfies ApiError);
    }
    const pluginProblem = checkPlugins(deps, spec);
    if (pluginProblem) {
      return reply.status(422).send({ error: pluginProblem.slot ? `invalid ${pluginProblem.slot}` : "invalid job", details: pluginProblem.details } satisfies ApiError);
    }

    deps.jobs.save(spec);
    deps.reloadJobs();
    const view = listJobViews(deps).find((j) => j.spec.id === spec.id);
    return reply.status(201).send({ job: view });
  });

  app.put<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const id = request.params.id;
    const body = request.body;
    if (typeof body === "object" && body !== null && (body as Record<string, unknown>).id === undefined) {
      (body as Record<string, unknown>).id = id;
    }
    if (typeof body === "object" && body !== null && (body as Record<string, unknown>).id !== id) {
      return reply.status(400).send({ error: "body id does not match path id" } satisfies ApiError);
    }
    const validated = validateJobSpec(body);
    if (!validated.ok) return reply.status(422).send({ error: "invalid job", details: validated.issues } satisfies ApiError);
    const spec = validated.spec;

    const existing = deps.jobs.load().jobs.find((j) => j.spec.id === id);
    if (!existing) return reply.status(404).send({ error: `job not found: ${id}` } satisfies ApiError);
    const pluginProblem = checkPlugins(deps, spec);
    if (pluginProblem) {
      return reply.status(422).send({ error: pluginProblem.slot ? `invalid ${pluginProblem.slot}` : "invalid job", details: pluginProblem.details } satisfies ApiError);
    }

    deps.jobs.save(spec);
    deps.reloadJobs();
    const view = listJobViews(deps).find((j) => j.spec.id === id);
    return reply.send({ job: view });
  });

  app.delete<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const removed = deps.jobs.delete(request.params.id);
    if (!removed) return reply.status(404).send({ error: `job not found: ${request.params.id}` } satisfies ApiError);
    deps.reloadJobs();
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/jobs/:id/enabled", async (request, reply) => {
    const id = request.params.id;
    const enabled = request.body?.enabled;
    if (typeof enabled !== "boolean") {
      return reply.status(422).send({ error: "enabled must be a boolean", details: [{ path: "enabled", message: "required boolean" }] });
    }
    const loaded = deps.jobs.load().jobs.find((j) => j.spec.id === id);
    if (!loaded) return reply.status(404).send({ error: `job not found: ${id}` } satisfies ApiError);
    deps.jobs.save({ ...loaded.spec, enabled });
    deps.reloadJobs();
    const view = listJobViews(deps).find((j) => j.spec.id === id);
    return reply.send(view);
  });

  app.post<{ Params: { id: string }; Body: { payload?: unknown } }>("/api/jobs/:id/run", async (request, reply) => {
    const id = request.params.id;
    const loaded = deps.jobs.load().jobs.find((j) => j.spec.id === id);
    if (!loaded) return reply.status(404).send({ error: `job not found: ${id}` } satisfies ApiError);
    if (loaded.problem) {
      return reply.status(409).send({ error: `job is not runnable: ${loaded.problem}` } satisfies ApiError);
    }
    const adapter = deps.agents.get(loaded.spec.agent.type);
    if (!adapter) {
      return reply.status(409).send({ error: `unknown agent type: ${loaded.spec.agent.type}` } satisfies ApiError);
    }
    const run = deps.runner.triggerRun(
      {
        job: loaded.spec,
        triggerKind: "manual",
        scheduledFor: null,
        payload: request.body?.payload ?? null,
        force: true,
      },
      adapter,
    );
    if (!run) return reply.status(409).send({ error: "run could not be queued" } satisfies ApiError);
    return reply.status(202).send({ run });
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const cancelled = deps.runner.cancelJob(request.params.id);
    return reply.send({ cancelled });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/jobs/:id/runs", async (request): Promise<RunSummary[]> => {
    const limit = clampInt(request.query.limit, 50, 1, 500);
    return deps.db.listRuns({ jobId: request.params.id, limit });
  });

  /* ---------------------------------------------------------------- */
  /* Runs                                                              */
  /* ---------------------------------------------------------------- */

  app.get<{ Querystring: { jobId?: string; status?: string; limit?: string } }>("/api/runs", async (request): Promise<RunSummary[]> => {
    const statuses = request.query.status
      ? request.query.status
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    const filter: { jobId?: string; status?: string[]; limit?: number } = {
      limit: clampInt(request.query.limit, 100, 1, 1000),
    };
    if (request.query.jobId) filter.jobId = request.query.jobId;
    if (statuses.length > 0) filter.status = statuses;
    return deps.db.listRuns(filter);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply): Promise<RunRecord | FastifyReply> => {
    const run = deps.db.getRun(request.params.id);
    if (!run) return reply.status(404).send({ error: `run not found: ${request.params.id}` } satisfies ApiError);
    return run;
  });

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>("/api/runs/:id/log", async (request, reply) => {
    const run = deps.db.getRun(request.params.id);
    if (!run) return reply.status(404).send({ error: `run not found: ${request.params.id}` } satisfies ApiError);
    const tail = clampInt(request.query.tail, 500, 1, 5000);
    return { runId: run.id, lines: deps.logs.tail(run.id, tail) };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/stream", async (request, reply) => {
    const runId = request.params.id;
    const run = deps.db.getRun(runId);
    if (!run) return reply.status(404).send({ error: `run not found: ${runId}` } satisfies ApiError);

    return streamSse(reply, (send) => {
      const unsubscribe = deps.bus.subscribe((event) => {
        if (event.type === "log" && event.runId === runId) send(event);
        if (event.type === "end" && event.runId === runId) {
          send(event);
          unsubscribe();
          send({ type: "ping", at: Date.now() });
          reply.raw.end();
        }
      });
      const heartbeat = setInterval(() => send({ type: "ping", at: Date.now() }), SSE_HEARTBEAT_MS);
      heartbeat.unref();
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      reply.raw.on("close", cleanup);
      return cleanup;
    });
  });

  app.get("/api/events", async (_request, reply) =>
    streamSse(reply, (send) => {
      const unsubscribe = deps.bus.subscribe(send);
      const heartbeat = setInterval(() => send({ type: "ping", at: Date.now() }), SSE_HEARTBEAT_MS);
      heartbeat.unref();
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      reply.raw.on("close", cleanup);
      return cleanup;
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Schedule preview                                                  */
  /* ---------------------------------------------------------------- */

  app.post<{ Body: CronPreviewRequest }>("/api/schedule/preview", async (request, reply): Promise<CronPreviewResponse | FastifyReply> => {
    const body = request.body ?? {};
    const timezone = body.timezone ?? deps.defaultTimezone;
    const count = clampInt(body.count, 5, 1, 50);    const after = typeof body.after === "number" && Number.isFinite(body.after) ? body.after : Date.now();
    const normalized = normalizeSchedule({ cron: body.cron, every: body.every, timezone }, deps.defaultTimezone);
    if (!normalized.ok) {
      return reply.send({ fires: [], scheduleText: "invalid", error: normalized.errors.join("; ") } satisfies CronPreviewResponse);
    }
    const fires: number[] = [];
    let cursor = after;
    for (let i = 0; i < count; i += 1) {
      const next = nextFire(normalized.value, cursor, fires.length > 0 ? cursor : null);
      if (next === null) break;
      fires.push(next);
      cursor = next;
    }
    return reply.send({ fires, scheduleText: describeSchedule(normalized.value) } satisfies CronPreviewResponse);
  });

  /* ---------------------------------------------------------------- */
  /* Static UI                                                         */
  /* ---------------------------------------------------------------- */

  if (deps.webDir && existsSync(deps.webDir)) {
    await app.register(fastifyStatic, { root: resolve(deps.webDir), index: ["index.html"] });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.status(404).send({ error: `no such endpoint: ${request.url}` } satisfies ApiError);
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

/* ------------------------------------------------------------------ */

function listJobViews(deps: AppDeps): JobView[] {
  const { jobs: loaded, errors } = deps.jobs.load();
  const problems = new Map<string, string>();
  for (const error of errors) {
    const id = error.sourcePath.split("/").pop()?.replace(/\.ya?ml$/, "") ?? error.sourcePath;
    problems.set(id, error.problem);
  }
  const views = loaded.map((job) =>
    toJobView(job, {
      nextFireAt: job.problem ? null : deps.scheduler.nextFireFor(job.spec.id),
      lastRun: deps.db.lastRunForJob(job.spec.id),
      runningCount: deps.db.countRunningForJob(job.spec.id),
    }),
  );
  // Surface files that failed to parse at all so the UI can show them.
  for (const [id, problem] of problems) {
    if (views.some((v) => v.spec.id === id)) continue;
    views.push({
      spec: {
        id,
        trigger: { type: "manual" },
        agent: { type: "pi", cwd: process.cwd() },
        prompt: "",
      },
      sourcePath: join(deps.jobs.dir, `${id}.yaml`),
      scheduleText: "unreadable",
      nextFireAt: null,
      lastRun: null,
      runningCount: 0,
      problem,
    });
  }
  return views.sort((a, b) => a.spec.id.localeCompare(b.spec.id));
}

function checkPlugins(
  deps: AppDeps,
  spec: JobSpec,
): { slot: "trigger" | "agent"; details: { path: string; message: string }[] } | null {
  const trigger = deps.triggers.get(spec.trigger.type);
  if (!trigger) {
    return { slot: "trigger", details: [{ path: "trigger.type", message: `unknown trigger type: ${spec.trigger.type}` }] };
  }
  const triggerCheck = trigger.validate(spec.trigger);
  if (!triggerCheck.ok) {
    return {
      slot: "trigger",
      details: (triggerCheck.errors ?? ["invalid trigger"]).map((message) => ({ path: "trigger", message })),
    };
  }
  const agent = deps.agents.get(spec.agent.type);
  if (!agent) {
    return { slot: "agent", details: [{ path: "agent.type", message: `unknown agent type: ${spec.agent.type}` }] };
  }
  const agentCheck = agent.validate(spec.agent);
  if (!agentCheck.ok) {
    return {
      slot: "agent",
      details: (agentCheck.errors ?? ["invalid agent"]).map((message) => ({ path: "agent", message })),
    };
  }
  return null;
}

function streamSse(
  reply: FastifyReply,
  attach: (send: (event: SseEvent) => void) => () => void,
): FastifyReply {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(": connected\n\n");

  const send = (event: SseEvent) => {
    if (reply.raw.writableEnded) return;
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const cleanup = attach(send);
  reply.raw.on("error", cleanup);
  return reply;
}

function clampInt(raw: string | number | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null) return fallback;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}
