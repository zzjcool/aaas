import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { JobSpec, JobView } from "../shared/types.ts";
import { JOB_DEFAULTS } from "../shared/types.ts";

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export const JOB_ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

const triggerSchema = z.looseObject({
  type: z.string().min(1),
});

const agentSchema = z.looseObject({
  type: z.string().min(1),
});

export const jobSpecSchema = z
  .strictObject({
    id: z.string().regex(JOB_ID_RE, "id must match ^[a-z0-9][a-z0-9-_]{0,63}$"),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    enabled: z.boolean().optional(),
    trigger: triggerSchema,
    agent: agentSchema,
    prompt: z.string().min(1, "prompt is required"),
    timeoutMs: z.number().int().positive().max(24 * 3600_000).optional(),
    retries: z.number().int().min(0).max(10).optional(),
    retryBackoffMs: z.number().int().min(0).max(3600_000).optional(),
    allowOverlap: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  })
  .strict();

export type ValidationIssue = { path: string; message: string };

export function validateJobSpec(raw: unknown): { ok: true; spec: JobSpec } | { ok: false; issues: ValidationIssue[] } {
  const parsed = jobSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        // Unrecognized-key errors report `(root)` plus the key name in the
        // message; lift the key into the path so the UI can attach it to a field.
        path: issue.path.join(".") || unrecognizedKey(issue.message) || "(root)",
        message: issue.message,
      })),
    };
  }
  return { ok: true, spec: withDefaults(toJobSpec(parsed.data)) };
}

/**
 * Map the validated (loose) document onto the frozen JobSpec shape explicitly.
 *
 * SAFETY: plugin configs are intentionally opaque at the job level — the trigger
 * and agent plugins validate their own payloads (see JobStore's validateTrigger /
 * validateAgent). TypeScript cannot narrow a `z.looseObject({type})` into the
 * discriminated `TriggerConfig`/`AgentConfig` union, so the cast is the boundary
 * and the plugin validators are the actual invariant check.
 */
function toJobSpec(data: z.infer<typeof jobSpecSchema>): JobSpec {
  const spec: JobSpec = {
    id: data.id,
    // SAFETY: opaque plugin payload, invariant checked by TriggerPlugin.validate.
    trigger: data.trigger as unknown as JobSpec["trigger"],
    // SAFETY: opaque plugin payload, invariant checked by AgentAdapter.validate.
    agent: data.agent as unknown as JobSpec["agent"],
    prompt: data.prompt,
  };
  if (data.name !== undefined) spec.name = data.name;
  if (data.description !== undefined) spec.description = data.description;
  if (data.enabled !== undefined) spec.enabled = data.enabled;
  if (data.timeoutMs !== undefined) spec.timeoutMs = data.timeoutMs;
  if (data.retries !== undefined) spec.retries = data.retries;
  if (data.retryBackoffMs !== undefined) spec.retryBackoffMs = data.retryBackoffMs;
  if (data.allowOverlap !== undefined) spec.allowOverlap = data.allowOverlap;
  if (data.tags !== undefined) spec.tags = data.tags;
  return spec;
}

function unrecognizedKey(message: string): string | null {
  const match = /Unrecognized key: "([^"]+)"/.exec(message);
  return match?.[1] ?? null;
}

export function withDefaults(spec: JobSpec): JobSpec {
  return {
    ...spec,
    name: spec.name ?? spec.id,
    enabled: spec.enabled ?? JOB_DEFAULTS.enabled,
    timeoutMs: spec.timeoutMs ?? JOB_DEFAULTS.timeoutMs,
    retries: spec.retries ?? JOB_DEFAULTS.retries,
    retryBackoffMs: spec.retryBackoffMs ?? JOB_DEFAULTS.retryBackoffMs,
    allowOverlap: spec.allowOverlap ?? JOB_DEFAULTS.allowOverlap,
  };
}

/* ------------------------------------------------------------------ */
/* Store: jobs/*.yaml is the source of truth                           */
/* ------------------------------------------------------------------ */

export interface LoadedJob {
  spec: JobSpec;
  sourcePath: string;
  /** Redacted/validation problem for this file; the job is not schedulable when set. */
  problem: string | null;
  scheduleText: string;
}

export interface LoadResult {
  jobs: LoadedJob[];
  errors: { sourcePath: string; problem: string }[];
}

/**
 * Reads every `*.yaml|*.yml` file in the jobs directory. One file = one job.
 * YAML is authoritative: the API writes through this class, so an operator can
 * always `git diff` the declared state of the platform.
 */
export class JobStore {
  readonly #dir: string;
  readonly #validateTrigger: (raw: unknown) => { ok: boolean; errors?: string[] };
  readonly #validateAgent: (raw: unknown) => { ok: boolean; errors?: string[] };
  readonly #describeTrigger: (raw: unknown) => string;

  constructor(opts: {
    dir: string;
    validateTrigger: (raw: unknown) => { ok: boolean; errors?: string[] };
    validateAgent: (raw: unknown) => { ok: boolean; errors?: string[] };
    describeTrigger: (raw: unknown) => string;
  }) {
    this.#dir = resolve(opts.dir);
    this.#validateTrigger = opts.validateTrigger;
    this.#validateAgent = opts.validateAgent;
    this.#describeTrigger = opts.describeTrigger;
    mkdirSync(this.#dir, { recursive: true });
  }

  get dir(): string {
    return this.#dir;
  }

  pathFor(id: string): string {
    return join(this.#dir, `${id}.yaml`);
  }

  load(): LoadResult {
    const jobs: LoadedJob[] = [];
    const errors: LoadResult["errors"] = [];
    if (!existsSync(this.#dir)) return { jobs, errors };

    const files = readdirSync(this.#dir)
      .filter((f) => [".yaml", ".yml"].includes(extname(f).toLowerCase()))
      .sort();

    for (const file of files) {
      const sourcePath = join(this.#dir, file);
      let raw: unknown;
      try {
        raw = parseYaml(readFileSync(sourcePath, "utf8"));
      } catch (err) {
        const problem = `YAML parse error: ${(err as Error).message}`;
        errors.push({ sourcePath, problem });
        continue;
      }
      if (raw === null || raw === undefined) {
        errors.push({ sourcePath, problem: "file is empty" });
        continue;
      }
      if (typeof raw === "object" && !("id" in (raw as Record<string, unknown>))) {
        (raw as Record<string, unknown>).id = basename(file, extname(file));
      }
      const validated = validateJobSpec(raw);
      if (!validated.ok) {
        const problem = validated.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
        errors.push({ sourcePath, problem });
        continue;
      }
      const spec = validated.spec;

      const triggerCheck = this.#validateTrigger(spec.trigger);
      if (!triggerCheck.ok) {
        jobs.push({
          spec,
          sourcePath,
          problem: `trigger: ${(triggerCheck.errors ?? []).join("; ")}`,
          scheduleText: "invalid",
        });
        continue;
      }
      const agentCheck = this.#validateAgent(spec.agent);
      if (!agentCheck.ok) {
        jobs.push({
          spec,
          sourcePath,
          problem: `agent: ${(agentCheck.errors ?? []).join("; ")}`,
          scheduleText: this.#describeTriggerSafe(spec.trigger),
        });
        continue;
      }

      jobs.push({
        spec,
        sourcePath,
        problem: null,
        scheduleText: this.#describeTriggerSafe(spec.trigger),
      });
    }
    return { jobs, errors };
  }

  /** Write a job back to YAML (atomic-ish: temp file then rename is unnecessary at this scale). */
  save(spec: JobSpec): string {
    const path = this.pathFor(spec.id);
    const doc = orderForYaml(spec);
    writeFileSync(path, stringifyYaml(doc, { lineWidth: 120 }), "utf8");
    return path;
  }

  delete(id: string): boolean {
    for (const ext of [".yaml", ".yml"]) {
      const path = join(this.#dir, `${id}${ext}`);
      if (existsSync(path)) {
        rmSync(path);
        return true;
      }
    }
    return false;
  }

  #describeTriggerSafe(trigger: unknown): string {
    try {
      return this.#describeTrigger(trigger);
    } catch {
      return "unknown schedule";
    }
  }
}

/** Keep YAML output stable and readable (fixed key order, no defaults noise). */
function orderForYaml(spec: JobSpec): Record<string, unknown> {
  const doc: Record<string, unknown> = { id: spec.id };
  if (spec.name && spec.name !== spec.id) doc.name = spec.name;
  if (spec.description) doc.description = spec.description;
  doc.enabled = spec.enabled ?? true;
  doc.trigger = spec.trigger;
  doc.agent = spec.agent;
  doc.prompt = spec.prompt;
  if (spec.timeoutMs !== undefined) doc.timeoutMs = spec.timeoutMs;
  if (spec.retries !== undefined) doc.retries = spec.retries;
  if (spec.retryBackoffMs !== undefined) doc.retryBackoffMs = spec.retryBackoffMs;
  if (spec.allowOverlap !== undefined) doc.allowOverlap = spec.allowOverlap;
  if (spec.tags && spec.tags.length) doc.tags = spec.tags;
  return doc;
}

/** Merge runtime state onto a spec for the API/UI. */
export function toJobView(
  loaded: LoadedJob,
  runtime: Pick<JobView, "nextFireAt" | "lastRun" | "runningCount">,
): JobView {
  return {
    spec: loaded.spec,
    sourcePath: loaded.sourcePath,
    scheduleText: loaded.scheduleText,
    problem: loaded.problem,
    nextFireAt: runtime.nextFireAt,
    lastRun: runtime.lastRun,
    runningCount: runtime.runningCount,
  };
}
