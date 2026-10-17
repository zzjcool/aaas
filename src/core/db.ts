import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RunRecord, RunStatus, RunSummary, TokenUsage } from "../shared/types.ts";

/**
 * SQLite persistence for run history + per-job scheduler state.
 * Uses Node's built-in `node:sqlite` (no native build step).
 */
export class Db {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id            TEXT PRIMARY KEY,
        job_id        TEXT NOT NULL,
        job_name      TEXT NOT NULL,
        trigger_kind  TEXT NOT NULL,
        status        TEXT NOT NULL,
        scheduled_for INTEGER,
        created_at    INTEGER NOT NULL,
        started_at    INTEGER,
        finished_at   INTEGER,
        duration_ms   INTEGER,
        attempt       INTEGER NOT NULL DEFAULT 1,
        exit_code     INTEGER,
        error         TEXT,
        result_text   TEXT,
        tokens_json   TEXT,
        cost_total    REAL,
        session_id    TEXT,
        log_path      TEXT,
        payload_json  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_job ON runs (job_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status, created_at DESC);
      CREATE TABLE IF NOT EXISTS job_state (
        job_id     TEXT PRIMARY KEY,
        last_fire  INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      /* already closed */
    }
  }

  /* ---------------------------------------------------------------- */

  insertRun(run: RunRecord): void {
    this.#db
      .prepare(
        `INSERT INTO runs (
          id, job_id, job_name, trigger_kind, status, scheduled_for, created_at, started_at,
          finished_at, duration_ms, attempt, exit_code, error, result_text, tokens_json,
          cost_total, session_id, log_path, payload_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.jobId,
        run.jobName,
        run.triggerKind,
        run.status,
        run.scheduledFor,
        run.createdAt,
        run.startedAt,
        run.finishedAt,
        run.durationMs,
        run.attempt,
        run.exitCode,
        run.error,
        run.resultText,
        run.tokens ? JSON.stringify(run.tokens) : null,
        run.costTotal,
        run.sessionId,
        run.logPath,
        run.payload === undefined || run.payload === null ? null : JSON.stringify(run.payload),
      );
  }

  updateRun(id: string, patch: Partial<RunRecord>): void {
    const current = this.getRun(id);
    if (!current) return;
    const next: RunRecord = { ...current, ...patch };
    this.#writeRun(next);
  }

  /** Static statement: every mutable column is written explicitly, no SQL is built at runtime. */
  #writeRun(run: RunRecord): void {
    this.#db
      .prepare(
        `UPDATE runs SET
           status = ?, scheduled_for = ?, started_at = ?, finished_at = ?, duration_ms = ?,
           attempt = ?, exit_code = ?, error = ?, result_text = ?, tokens_json = ?,
           cost_total = ?, session_id = ?, log_path = ?, payload_json = ?
         WHERE id = ?`,
      )
      .run(
        run.status,
        run.scheduledFor,
        run.startedAt,
        run.finishedAt,
        run.durationMs,
        run.attempt,
        run.exitCode,
        run.error,
        run.resultText,
        run.tokens ? JSON.stringify(run.tokens) : null,
        run.costTotal,
        run.sessionId,
        run.logPath,
        run.payload === undefined || run.payload === null ? null : JSON.stringify(run.payload),
        run.id,
      );
  }

  getRun(id: string): RunRecord | null {
    const row = this.#db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(filter: { jobId?: string; status?: string[]; limit?: number } = {}): RunSummary[] {
    const jobId = filter.jobId ?? null;
    const statuses = filter.status && filter.status.length > 0 ? JSON.stringify(filter.status) : null;
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
    const rows = this.#db
      .prepare(
        `SELECT * FROM runs
         WHERE (:jobId IS NULL OR job_id = :jobId)
           AND (:statuses IS NULL OR status IN (SELECT value FROM json_each(:statuses)))
         ORDER BY created_at DESC
         LIMIT :limit`,
      )
      .all({ jobId, statuses, limit }) as Row[];
    return rows.map((r) => toSummary(rowToRun(r)));
  }

  lastRunForJob(jobId: string): RunSummary | null {
    const row = this.#db
      .prepare(`SELECT * FROM runs WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(jobId) as Row | undefined;
    return row ? toSummary(rowToRun(row)) : null;
  }

  countRunningForJob(jobId: string): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE job_id = ? AND status = 'running'`)
      .get(jobId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  listRunning(): RunRecord[] {
    const rows = this.#db
      .prepare(`SELECT * FROM runs WHERE status IN ('queued','running') ORDER BY created_at ASC`)
      .all() as Row[];
    return rows.map(rowToRun);
  }

  /** Mark runs that were live when the process died, so the UI never shows ghost runs. */
  markStaleRuns(reason: string, now: number): number {
    const res = this.#db
      .prepare(
        `UPDATE runs SET status = 'failed', error = ?, finished_at = ?, duration_ms = CASE
           WHEN started_at IS NULL THEN NULL ELSE ? - started_at END
         WHERE status IN ('queued','running')`,
      )
      .run(reason, now, now);
    return Number(res.changes ?? 0);
  }

  /* ---------------------------------------------------------------- */

  getJobState(jobId: string): { lastFire: number | null } {
    const row = this.#db.prepare(`SELECT last_fire FROM job_state WHERE job_id = ?`).get(jobId) as
      | { last_fire: number | null }
      | undefined;
    return { lastFire: row?.last_fire ?? null };
  }

  setJobState(jobId: string, lastFire: number | null, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO job_state (job_id, last_fire, updated_at) VALUES (?,?,?)
         ON CONFLICT(job_id) DO UPDATE SET last_fire = excluded.last_fire, updated_at = excluded.updated_at`,
      )
      .run(jobId, lastFire, now);
  }

  getMeta(key: string): string | null {
    const row = this.#db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(`INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
}

type Row = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : v === null ? null : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function rowToRun(row: Row): RunRecord {
  const tokensJson = str(row.tokens_json);
  let tokens: TokenUsage | null = null;
  if (tokensJson) {
    try {
      tokens = JSON.parse(tokensJson) as TokenUsage;
    } catch {
      tokens = null;
    }
  }
  const payloadJson = str(row.payload_json);
  let payload: unknown = null;
  if (payloadJson) {
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      payload = payloadJson;
    }
  }
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    jobName: String(row.job_name),
    triggerKind: String(row.trigger_kind) as RunRecord["triggerKind"],
    status: String(row.status) as RunStatus,
    scheduledFor: num(row.scheduled_for),
    createdAt: num(row.created_at) ?? 0,
    startedAt: num(row.started_at),
    finishedAt: num(row.finished_at),
    durationMs: num(row.duration_ms),
    attempt: num(row.attempt) ?? 1,
    exitCode: num(row.exit_code),
    error: str(row.error),
    resultText: str(row.result_text),
    tokens,
    costTotal: num(row.cost_total),
    sessionId: str(row.session_id),
    logPath: str(row.log_path),
    payload,
  };
}

export function toSummary(run: RunRecord): RunSummary {
  return {
    id: run.id,
    jobId: run.jobId,
    jobName: run.jobName,
    triggerKind: run.triggerKind,
    status: run.status,
    scheduledFor: run.scheduledFor,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    attempt: run.attempt,
    exitCode: run.exitCode,
    error: run.error,
    tokens: run.tokens,
    costTotal: run.costTotal,
  };
}
