import type { AgentRegistry, TriggerRegistry } from "./registry.ts";
import type { AgentAdapter, JobSpec, TriggerEvent, TriggerPlugin } from "../shared/types.ts";

interface ScheduledEntry {
  spec: JobSpec;
  plugin: TriggerPlugin<unknown>;
  config: unknown;
  nextFireAt: number | null;
  lastFire: number | null;
}

export interface SchedulerOptions {
  triggers: TriggerRegistry;
  runner: {
    triggerRun: (input: TriggerRunInput, adapter: AgentAdapter) => unknown;
    recordSkipped: (job: JobSpec, scheduledFor: number, reason: string) => unknown;
  };
  agents: AgentRegistry;
  db: { getJobState(jobId: string): { lastFire: number | null }; setJobState(jobId: string, lastFire: number | null, now: number): void };
  defaultTimezone: string;
  tickMs: number;
  /** Fire times older than this at startup are recorded as skipped, never run. */
  missedGraceMs: number;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

interface TriggerRunInput {
  job: JobSpec;
  triggerKind: "cron" | "manual" | "webhook" | "retry";
  scheduledFor: number | null;
  payload?: unknown;
  force?: boolean;
}

/**
 * Owns the timer loop: every tick it looks for the earliest due job, fires it,
 * then recomputes that job's next fire time.
 *
 * Design notes:
 *  - One tick loop for all jobs (not one timer per job) keeps the clock
 *    deterministic and makes reconciliation after a config change trivial.
 *  - Missed fire times (engine was down) are never replayed; they are recorded
 *    once per job with the `missedGraceMs` cutoff so a restart cannot stampede.
 *  - `nextFire` is always recomputed from `max(now, lastFire)` so clocks that
 *    jump backwards cannot double-fire.
 */
export class Scheduler {
  readonly #triggers: TriggerRegistry;
  readonly #runner: SchedulerOptions["runner"];
  readonly #agents: AgentRegistry;
  readonly #db: SchedulerOptions["db"];
  readonly #tickMs: number;
  readonly #missedGraceMs: number;
  readonly #now: () => number;
  readonly #log: NonNullable<SchedulerOptions["log"]>;
  readonly #entries = new Map<string, ScheduledEntry>();
  #timer: NodeJS.Timeout | null = null;
  #startedAt: number | null = null;
  #ticking = false;
  /** Missed fire points discovered at startup, reported once when the loop starts. */
  #catchUp: { jobId: string; scheduledFor: number }[] = [];

  constructor(options: SchedulerOptions) {
    this.#triggers = options.triggers;
    this.#runner = options.runner;
    this.#agents = options.agents;
    this.#db = options.db;
    this.#tickMs = Math.max(100, options.tickMs);
    this.#missedGraceMs = options.missedGraceMs;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? (() => {});
  }

  get startedAt(): number | null {
    return this.#startedAt;
  }

  get jobCount(): number {
    return this.#entries.size;
  }

  /** Replace the whole job set (called on load and on every config mutation). */
  setJobs(jobs: { spec: JobSpec; problem: string | null }[]): void {
    const next = new Map<string, ScheduledEntry>();
    for (const { spec, problem } of jobs) {
      if (problem) continue;
      const plugin = this.#triggers.get(spec.trigger.type);
      if (!plugin) continue;
      const validated = plugin.validate(spec.trigger);
      if (!validated.ok) continue;
      const previous = this.#entries.get(spec.id);
      const state = this.#db.getJobState(spec.id);
      const lastFire = previous?.lastFire ?? state.lastFire ?? null;
      const entry: ScheduledEntry = {
        spec,
        plugin,
        config: validated.config,
        lastFire,
        nextFireAt: null,
      };
      const keepPrevious = previous !== undefined && sameSchedule(previous.spec, spec);
      entry.nextFireAt = keepPrevious
        ? previous.nextFireAt
        : this.#collectCatchUp(entry);
      next.set(spec.id, entry);
    }
    this.#entries.clear();
    for (const [id, entry] of next) {
      this.#entries.set(id, entry);
      this.#stopPlugin(id);
      if (!entry.spec.enabled) continue;
      if (entry.plugin.start) {
        try {
          void entry.plugin.start(this.#pluginContext(entry.spec.id), entry.spec, entry.config);
        } catch (err) {
          this.#log("error", `trigger start failed for ${id}`, err);
        }
      }
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#startedAt = this.#now();
    this.#reportCatchUp();
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#tickMs);
    this.#timer.unref();
    void this.tick();
    this.#log("info", `scheduler started (tick ${this.#tickMs}ms, ${this.#entries.size} jobs)`);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    for (const id of [...this.#entries.keys()]) this.#stopPlugin(id);
  }

  /** One scheduling pass. Public so tests can drive the clock deterministically. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      for (const entry of this.#entries.values()) {
        if (!entry.spec.enabled) continue;
        if (entry.nextFireAt === null) continue;
        if (entry.nextFireAt > now) continue;
        await this.#fire(entry, now);
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #fire(entry: ScheduledEntry, now: number): Promise<void> {
    const scheduledFor = entry.nextFireAt;
    if (scheduledFor === null) return;

    const adapter = this.#agents.get(entry.spec.agent.type);
    if (!adapter) {
      this.#log("error", `job ${entry.spec.id} references unknown agent ${entry.spec.agent.type}`);
      entry.nextFireAt = this.#computeNext(entry.plugin, entry.config, scheduledFor, scheduledFor);
      return;
    }

    this.#runner.triggerRun({ job: entry.spec, triggerKind: "cron", scheduledFor }, adapter);
    entry.lastFire = scheduledFor;
    this.#db.setJobState(entry.spec.id, scheduledFor, now);
    entry.nextFireAt = this.#computeNext(entry.plugin, entry.config, scheduledFor, scheduledFor);
  }

  /**
   * Where the schedule search starts: the last consumed fire time, or "just
   * before startup minus the grace window" so a fire that landed inside the
   * grace window still runs once after a restart.
   */
  #anchor(): number {
    const base = this.#startedAt ?? this.#now();
    return base - this.#missedGraceMs;
  }

  #computeNext(
    plugin: TriggerPlugin<unknown>,
    config: unknown,
    lastFire: number | null,
    after: number,
  ): number | null {
    if (!plugin.nextFire) return null;
    try {
      const from = Math.max(after, lastFire ?? Number.NEGATIVE_INFINITY);
      const next = plugin.nextFire(config, from, lastFire);
      return next !== null && Number.isFinite(next) ? next : null;
    } catch (err) {
      this.#log("error", `nextFire failed for ${plugin.type}`, err);
      return null;
    }
  }

  /**
   * Enumerates fire points that elapsed while the engine was down. Everything
   * older than the grace window collapses into a single `skipped` record per
   * job, so a long outage can never replay a burst of runs.
   */
  #collectCatchUp(entry: ScheduledEntry): number | null {
    const plugin = entry.plugin;
    if (!plugin.nextFire) return null;
    const cutoff = this.#anchor();
    let cursor = entry.lastFire;
    let missed = 0;
    let next = this.#computeNext(plugin, entry.config, cursor, cursor === null ? cutoff : cursor);
    // Walk forward from the last consumed fire; bounded so a 1s schedule over a
    // month of downtime cannot spin here.
    for (let guard = 0; guard < 1000 && next !== null; guard += 1) {
      if (next >= cutoff) break;
      missed += 1;
      cursor = next;
      next = this.#computeNext(plugin, entry.config, cursor, cursor);
    }
    if (missed > 0 && cursor !== null) {
      this.#catchUp.push({ jobId: entry.spec.id, scheduledFor: cursor });
      this.#log(
        "warn",
        `${entry.spec.id}: ${missed} fire(s) elapsed while the engine was down; latest at ${new Date(cursor).toISOString()} will be recorded as skipped`,
      );
    }
    return next;
  }

  #reportCatchUp(): void {
    const pending = this.#catchUp;
    this.#catchUp = [];
    for (const item of pending) {
      const entry = this.#entries.get(item.jobId);
      if (!entry) continue;
      this.#runner.recordSkipped(entry.spec, item.scheduledFor, "missed while engine was down");
      entry.lastFire = item.scheduledFor;
      this.#db.setJobState(item.jobId, item.scheduledFor, this.#now());
    }
  }

  /** Next fire time for a job, or null when it is unknown, disabled, or never fires. */
  nextFireFor(jobId: string): number | null {
    const entry = this.#entries.get(jobId);
    if (!entry || !entry.spec.enabled) return null;
    return entry.nextFireAt;
  }

  #pluginContext(jobId: string) {
    return {
      emit: (event: TriggerEvent) => {
        const entry = this.#entries.get(event.jobId);
        if (!entry || !entry.spec.enabled) return;
        const adapter = this.#agents.get(entry.spec.agent.type);
        if (!adapter) return;
        this.#runner.triggerRun(
          {
            job: entry.spec,
            triggerKind: event.triggerType === "cron" ? "cron" : "webhook",
            scheduledFor: event.scheduledFor,
            payload: event.payload,
          },
          adapter,
        );
        entry.lastFire = event.firedAt;
        this.#db.setJobState(event.jobId, event.firedAt, this.#now());
      },
      log: (level: "info" | "warn" | "error", message: string, detail?: unknown) => {
        this.#log(level, `[${jobId}] ${message}`, detail);
      },
    };
  }

  #stopPlugin(jobId: string): void {
    const entry = this.#entries.get(jobId);
    if (!entry?.plugin.stop) return;
    try {
      void entry.plugin.stop(jobId);
    } catch (err) {
      this.#log("warn", `trigger stop failed for ${jobId}`, err);
    }
  }
}

function sameSchedule(a: JobSpec, b: JobSpec): boolean {
  return JSON.stringify(a.trigger) === JSON.stringify(b.trigger) && a.enabled === b.enabled;
}
