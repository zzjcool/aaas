import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentRunResult,
  JobSpec,
  RunRecord,
  RunStatus,
  RunSummary,
  RunTriggerKind,
  SseEvent,
} from "../shared/types.ts";
import type { Db } from "./db.ts";
import { toSummary } from "./db.ts";
import type { EventBus, LogStore } from "./events.ts";

export interface RunnerOptions {
  db: Db;
  logs: LogStore;
  bus: EventBus;
  maxConcurrency: number;
  retryDelayFloorMs?: number;
  now?: () => number;
}

export interface TriggerRunInput {
  job: JobSpec;
  triggerKind: RunTriggerKind;
  scheduledFor: number | null;
  payload?: unknown;
  /** Force ignoring the job's `allowOverlap` flag (manual "Run now"). */
  force?: boolean;
}

const RESULT_TEXT_LIMIT = 32 * 1024;

/**
 * Executes runs: queueing, per-job overlap policy, global concurrency, timeout,
 * retries and the full lifecycle record. Adapters only ever see one attempt.
 */
export class Runner {
  readonly #db: Db;
  readonly #logs: LogStore;
  readonly #bus: EventBus;
  readonly #maxConcurrency: number;
  readonly #retryDelayFloorMs: number;
  readonly #now: () => number;
  readonly #aborts = new Map<string, AbortController>();
  readonly #active = new Set<string>();
  readonly #queue: { run: RunRecord; spec: JobSpec }[] = [];
  #draining = false;

  constructor(options: RunnerOptions) {
    this.#db = options.db;
    this.#logs = options.logs;
    this.#bus = options.bus;
    this.#maxConcurrency = Math.max(1, options.maxConcurrency);
    this.#retryDelayFloorMs = options.retryDelayFloorMs ?? 0;
    this.#now = options.now ?? (() => Date.now());
  }

  get runningCount(): number {
    return this.#active.size;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  hasActiveRun(jobId: string): boolean {
    for (const id of this.#active) {
      const run = this.#db.getRun(id);
      if (run?.jobId === jobId) return true;
    }
    return this.#queue.some((q) => q.spec.id === jobId);
  }

  /**
   * Enqueue a run. Returns the record already written to the DB, or `null` when
   * the job is skipped because a previous run of the same job is still live and
   * `allowOverlap` is false.
   */
  triggerRun(input: TriggerRunInput, adapter: AgentAdapter): RunRecord | null {
    const { job } = input;
    const now = this.#now();

    if (!input.force && !job.allowOverlap && this.hasActiveRun(job.id)) {
      const skipped = this.#newRunRecord({
        job,
        triggerKind: input.triggerKind,
        scheduledFor: input.scheduledFor,
        payload: input.payload,
        now,
        status: "skipped",
      });
      skipped.error = "skipped: previous run still in progress";
      skipped.finishedAt = now;
      this.#db.insertRun(skipped);
      this.#emit({ type: "run", run: toSummary(skipped) });
      this.#logLine(skipped.id, "system", `skipped: previous run still in progress (job ${job.id})`, now);
      return null;
    }

    const record = this.#newRunRecord({
      job,
      triggerKind: input.triggerKind,
      scheduledFor: input.scheduledFor,
      payload: input.payload,
      now,
      status: "queued",
    });
    this.#db.insertRun(record);
    this.#logs.open(record.id);
    this.#logLine(record.id, "system", `queued job=${job.id} trigger=${input.triggerKind}`, now);
    this.#emit({ type: "run", run: toSummary(record) });
    this.#queue.push({ run: record, spec: job });
    void this.#drain(adapter);
    return record;
  }

  /**
   * Record a fire point that was never executed (engine down, restart, etc.)
   * without touching the queue. Used by the scheduler's missed-fire reporting.
   */
  recordSkipped(job: JobSpec, scheduledFor: number, reason: string): RunRecord {
    const now = this.#now();
    const record = this.#newRunRecord({
      job,
      triggerKind: "cron",
      scheduledFor,
      payload: null,
      now,
      status: "skipped",
    });
    record.finishedAt = now;
    record.durationMs = 0;
    record.error = reason;
    this.#db.insertRun(record);
    this.#logs.open(record.id);
    this.#logLine(record.id, "system", `skipped: ${reason} (scheduled for ${new Date(scheduledFor).toISOString()})`, now);
    this.#logs.close(record.id);
    this.#emit({ type: "run", run: toSummary(record) });
    return record;
  }

  /** Abort every live run of a job. Returns how many were cancelled. */
  cancelJob(jobId: string): number {
    let cancelled = 0;
    for (const [runId, controller] of this.#aborts) {
      const run = this.#db.getRun(runId);
      if (run?.jobId === jobId && !controller.signal.aborted) {
        controller.abort(new Error("cancelled by operator"));
        cancelled += 1;
      }
    }
    // Drop queued (not yet started) runs of that job too.
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      const entry = this.#queue[i];
      if (entry && entry.spec.id === jobId) {
        this.#queue.splice(i, 1);
        const now = this.#now();
        this.#db.updateRun(entry.run.id, {
          status: "cancelled",
          finishedAt: now,
          error: "cancelled before start",
        });
        this.#logLine(entry.run.id, "system", "cancelled before start", now);
        this.#emit({ type: "run", run: toSummary({ ...entry.run, status: "cancelled", finishedAt: now }) });
        this.#emit({ type: "end", runId: entry.run.id, status: "cancelled" });
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** Release everything on shutdown: abort live runs, resolve the drain loop. */
  async shutdown(graceMs = 5000): Promise<void> {
    this.#queue.length = 0;
    for (const controller of this.#aborts.values()) {
      if (!controller.signal.aborted) controller.abort(new Error("engine shutting down"));
    }
    const deadline = this.#now() + graceMs;
    while (this.#active.size > 0 && this.#now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.#logs.closeAll();
  }

  /* ---------------------------------------------------------------- */

  async #drain(adapter: AgentAdapter): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0 && this.#active.size < this.#maxConcurrency) {
        const entry = this.#queue.shift();
        if (!entry) break;
        // Fire and forget; the loop keeps filling free slots.
        void this.#execute(entry.run, entry.spec, adapter);
      }
    } finally {
      this.#draining = false;
    }
  }

  async #execute(initial: RunRecord, job: JobSpec, adapter: AgentAdapter): Promise<void> {
    this.#active.add(initial.id);
    const maxAttempts = 1 + Math.max(0, job.retries ?? 0);
    let attempt = 1;
    let run = initial;

    try {
      for (;;) {
        const outcome = await this.#attempt(run, job, adapter, attempt);
        if (outcome.status === "succeeded") break;
        const retryable = outcome.status === "failed";
        if (!retryable || attempt >= maxAttempts) break;
        const base = Math.max(job.retryBackoffMs ?? 0, this.#retryDelayFloorMs);
        const delay = Math.min(base * 2 ** (attempt - 1), 3600_000);
        attempt += 1;
        this.#logLine(
          run.id,
          "system",
          `attempt ${attempt - 1} ${outcome.status} (${outcome.error ?? "no detail"}); retrying in ${Math.round(delay)}ms`,
        );
        // Keep an abort controller registered *during* the backoff sleep.
        //
        // `#attempt` deletes its controller in its own finally, and cancelJob()
        // only scans #aborts and #queue — so without this, a retry wait (30s by
        // default) was an uncancellable window: POST /jobs/:id/cancel answered
        // {cancelled:0} and the retry fired anyway, flipping the run back from
        // failed to running. Backoff is not a neutral delay, it is part of the
        // run, and an operator must be able to stop it.
        const backoff = new AbortController();
        this.#aborts.set(run.id, backoff);
        this.#logLine(run.id, "system", `waiting ${Math.round(delay)}ms before retry (cancellable)`);
        try {
          await sleep(delay, backoff.signal);
        } finally {
          // Only remove our own entry: a concurrent cancel may have replaced it.
          if (this.#aborts.get(run.id) === backoff) this.#aborts.delete(run.id);
        }

        if (backoff.signal.aborted) {
          const now = this.#now();
          this.#db.updateRun(run.id, {
            status: "cancelled",
            finishedAt: now,
            error: "cancelled while waiting to retry",
          });
          this.#logLine(run.id, "system", "cancelled while waiting to retry", now);
          const record = this.#db.getRun(run.id);
          if (record) {
            this.#emit({ type: "end", runId: record.id, status: "cancelled" });
            this.#emit({ type: "run", run: toSummary(record) });
          }
          return;
        }

        run = { ...run, attempt };
        this.#db.updateRun(run.id, { attempt, status: "running" });
      }
    } finally {
      this.#active.delete(initial.id);
      this.#aborts.delete(initial.id);
      this.#logs.close(initial.id);
      const final = this.#db.getRun(initial.id);
      if (final) {
        this.#emit({ type: "end", runId: final.id, status: final.status });
        this.#emit({ type: "run", run: toSummary(final) });
      }
      void this.#drain(adapter);
    }
  }

  async #attempt(
    run: RunRecord,
    job: JobSpec,
    adapter: AgentAdapter,
    attempt: number,
  ): Promise<{ status: RunStatus; error?: string }> {
    const controller = new AbortController();
    this.#aborts.set(run.id, controller);
    const startedAt = this.#now();
    this.#db.updateRun(run.id, { status: "running", startedAt, attempt });
    this.#emit({
      type: "run",
      run: toSummary({ ...run, status: "running", startedAt, attempt }),
    });
    this.#logLine(run.id, "system", `attempt ${attempt} start (timeout ${job.timeoutMs}ms)`);

    const timer = setTimeout(() => {
      controller.abort(new Error(`timed out after ${job.timeoutMs}ms`));
    }, job.timeoutMs ?? 30 * 60_000);

    let result: AgentRunResult | null = null;
    let thrown: Error | null = null;

    try {
      result = await adapter.run(
        {
          runId: run.id,
          jobId: job.id,
          prompt: job.prompt,
          config: job.agent,
          timeoutMs: job.timeoutMs ?? 30 * 60_000,
          signal: controller.signal,
        },
        {
          log: (stream, line) => this.#logLine(run.id, stream, line),
        },
      );
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
      this.#aborts.delete(run.id);
    }

    const finishedAt = this.#now();
    const durationMs = finishedAt - startedAt;
    const timedOut = controller.signal.aborted && !isCancelled(controller.signal);

    let status: RunStatus;
    let error: string | null = null;

    if (thrown) {
      status = "failed";
      error = thrown.message;
    } else if (!result) {
      status = "failed";
      error = "adapter returned no result";
    } else if (result.aborted) {
      status = timedOut ? "timeout" : "cancelled";
      error = timedOut ? `timed out after ${job.timeoutMs}ms` : (result.error ?? "cancelled");
    } else if (result.ok) {
      status = "succeeded";
    } else if (result.timedOut) {
      status = "timeout";
      error = result.error ?? "timed out";
    } else {
      status = "failed";
      error = result.error ?? "run failed";
    }

    const patch: Partial<RunRecord> = {
      status,
      finishedAt,
      durationMs,
      error,
      exitCode: result?.exitCode ?? null,
      resultText: result?.text ? truncate(result.text, RESULT_TEXT_LIMIT) : null,
      tokens: result?.tokens ?? null,
      costTotal: result?.costTotal ?? null,
      sessionId: result?.sessionId ?? null,
    };
    this.#db.updateRun(run.id, patch);
    this.#logLine(run.id, "system", `attempt ${attempt} finished: ${status}${error ? ` (${error})` : ""} in ${durationMs}ms`);
    return { status, error: error ?? undefined };
  }

  #newRunRecord(input: {
    job: JobSpec;
    triggerKind: RunTriggerKind;
    scheduledFor: number | null;
    payload?: unknown;
    now: number;
    status: RunStatus;
  }): RunRecord {
    const id = `run_${randomUUID()}`;
    return {
      id,
      jobId: input.job.id,
      jobName: input.job.name ?? input.job.id,
      triggerKind: input.triggerKind,
      status: input.status,
      scheduledFor: input.scheduledFor,
      createdAt: input.now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      attempt: 1,
      exitCode: null,
      error: null,
      resultText: null,
      tokens: null,
      costTotal: null,
      sessionId: null,
      logPath: this.#logs.pathFor(id),
      payload: input.payload ?? null,
    };
  }

  /** Persist a log line to JSONL and fan it out to SSE in one step. */
  #logLine(runId: string, stream: string, line: string, at = this.#now()): void {
    const normalized = normalizeStream(stream);
    this.#logs.write(runId, normalized, line, at);
    this.#emit({ type: "log", runId, stream: normalized, line, at });
  }

  #emit(event: SseEvent): void {
    this.#bus.publish(event);
  }
}

function normalizeStream(stream: string): "stdout" | "stderr" | "event" | "system" {
  if (stream === "stdout" || stream === "stderr" || stream === "event" || stream === "system") return stream;
  return "stdout";
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated, ${text.length - limit} chars omitted)`;
}

/**
 * Sleep, optionally abortable.
 *
 * A plain `setTimeout` cannot be interrupted, and an uninterruptible retry
 * backoff turns "cancel" into a lie for the whole wait (30s by default).
 * With a signal, aborting resolves early and clears the timer.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

function isCancelled(signal: AbortSignal): boolean {
  const reason = signal.reason;
  if (reason instanceof Error) return /cancelled/i.test(reason.message);
  return false;
}

export type { RunSummary };
