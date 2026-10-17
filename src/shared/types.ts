/**
 * aaas shared domain types — FROZEN CONTRACT (v1)
 *
 * Consumed by: core engine, trigger plugins, agent adapters, HTTP API, web UI.
 * Rules:
 *  - All timestamps are epoch milliseconds (number). Timezone rendering is a
 *    front-end concern only; the backend never stores wall-clock strings.
 *  - Everything here is serialisable JSON (no Date, no functions).
 *  - Additive changes only within v1. Breaking changes bump the contract.
 */

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

/** Epoch milliseconds. */
export type EpochMs = number;

/* ------------------------------------------------------------------ */
/* Trigger specs                                                       */
/* ------------------------------------------------------------------ */

/** Cron / interval schedule. Either `cron` or `every` is required. */
export interface CronTriggerConfig {
  type: "cron";
  /** 5-field (`m h dom mon dow`) or 6-field (`s m h dom mon dow`) cron, or a macro (@hourly …). */
  cron?: string;
  /** Interval shorthand: `30s`, `15m`, `2h`, `1d`. Mutually exclusive with `cron`. */
  every?: string;
  /** IANA timezone used to interpret `cron`. Defaults to server `AAAS_DEFAULT_TZ` (Asia/Shanghai). */
  timezone?: string;
}

/** Only fires through the API ("Run now"). */
export interface ManualTriggerConfig {
  type: "manual";
}

export type TriggerConfig = CronTriggerConfig | ManualTriggerConfig;

/** Trigger plugin identifier. `cron` and `manual` ship in v1. */
export type TriggerType = "cron" | "manual" | (string & {});

/* ------------------------------------------------------------------ */
/* Agent specs                                                         */
/* ------------------------------------------------------------------ */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** `pi` coding-agent adapter config. */
export interface PiAgentConfig {
  type: "pi";
  /** Provider name, e.g. `any-endpoint`. Passed as `--provider`. */
  provider?: string;
  /** Model id or pattern, e.g. `workbuddy/hy4-preview-ioa`. Passed as `--model`. */
  model?: string;
  thinking?: ThinkingLevel;
  /** Working directory for the agent process (required). */
  cwd: string;
  /** Tool allowlist (`--tools`). */
  tools?: string[];
  /** Tool denylist (`--exclude-tools`). */
  excludeTools?: string[];
  /** Disable all tools (`--no-tools`). */
  noTools?: boolean;
  /** Extra system prompt text (`--system-prompt` replaces, `--append-system-prompt` appends). */
  appendSystemPrompt?: string;
  /** Enable pi extension discovery. Default false → `--no-extensions` (deterministic unattended runs). */
  extensions?: boolean;
  /** Enable MCP servers. Default false → `--no-mcp`. */
  mcp?: boolean;
  /** Extra env vars for the agent process. */
  env?: Record<string, string>;
}

/** Agent plugin identifier. `pi` ships in v1. */
export type AgentType = "pi" | (string & {});

export type AgentConfig = PiAgentConfig;

/* ------------------------------------------------------------------ */
/* Job spec                                                            */
/* ------------------------------------------------------------------ */

export interface JobSpec {
  /** Stable slug, `^[a-z0-9][a-z0-9-_]{0,63}$`. Also the YAML file name. */
  id: string;
  /** Human label. Defaults to `id`. */
  name?: string;
  description?: string;
  /** Default true. */
  enabled?: boolean;
  trigger: TriggerConfig;
  agent: AgentConfig;
  /** The task text handed to the agent. */
  prompt: string;
  /** Hard wall-clock limit for one attempt. Default 1_800_000 (30 min). */
  timeoutMs?: number;
  /** Extra attempts after the first failure. Default 1. */
  retries?: number;
  /** Delay before attempt n+1. Default 30_000. */
  retryBackoffMs?: number;
  /** Allow a new run while the previous one is still running. Default false. */
  allowOverlap?: boolean;
  tags?: string[];
}

/** Defaults applied by the loader, so consumers never see `undefined` for these. */
export const JOB_DEFAULTS = {
  enabled: true,
  timeoutMs: 1_800_000,
  retries: 1,
  retryBackoffMs: 30_000,
  allowOverlap: false,
} as const;

/* ------------------------------------------------------------------ */
/* Runs                                                               */
/* ------------------------------------------------------------------ */

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled"
  | "skipped";

/** What caused a run. */
export type RunTriggerKind = "cron" | "manual" | "webhook" | "retry";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface RunRecord {
  id: string;
  jobId: string;
  jobName: string;
  triggerKind: RunTriggerKind;
  status: RunStatus;
  /** Intended fire time (cron), null for manual runs. */
  scheduledFor: EpochMs | null;
  createdAt: EpochMs;
  startedAt: EpochMs | null;
  finishedAt: EpochMs | null;
  durationMs: number | null;
  /** 1-based attempt counter. */
  attempt: number;
  exitCode: number | null;
  error: string | null;
  /** Final assistant text (truncated to 32 KiB for the API). */
  resultText: string | null;
  tokens: TokenUsage | null;
  costTotal: number | null;
  /** pi session id, when the adapter exposes one. */
  sessionId: string | null;
  /** Absolute path to the JSONL transcript for this run. */
  logPath: string | null;
  /** Trigger payload (webhook body etc.). Null for cron/manual. */
  payload: unknown;
}

/** Trimmed run shape for lists. */
export type RunSummary = Pick<
  RunRecord,
  | "id"
  | "jobId"
  | "jobName"
  | "triggerKind"
  | "status"
  | "scheduledFor"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "durationMs"
  | "attempt"
  | "exitCode"
  | "error"
  | "tokens"
  | "costTotal"
>;

/* ------------------------------------------------------------------ */
/* Job view (spec + runtime state)                                     */
/* ------------------------------------------------------------------ */

export interface JobView {
  spec: JobSpec;
  /** Absolute path of the YAML file that declares this job. */
  sourcePath: string;
  /** Human-readable schedule, e.g. `Every weekday at 09:00 (Asia/Shanghai)`. */
  scheduleText: string;
  /** Next computed fire time, null when the job never fires. */
  nextFireAt: EpochMs | null;
  lastRun: RunSummary | null;
  /** Runs currently running for this job. */
  runningCount: number;
  /** Last load/validation problem, if any. */
  problem: string | null;
}

/* ------------------------------------------------------------------ */
/* Plugin contracts                                                    */
/* ------------------------------------------------------------------ */

/** Minimal JSON-schema subset the UI knows how to render. */
export interface FieldSchema {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select" | "textarea" | "string[]";
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /**
   * Optional hint that the raw string has a structure worth editing with a
   * dedicated control instead of a free-text box. Purely presentational: the
   * wire value is still the plain string the plugin validates.
   *
   * - `cron`: render the visual schedule builder (the text stays editable and
   *   the value the plugin receives is whatever the builder writes out).
   * - `timezone`: render a timezone picker backed by `Intl.supportedValuesOf`.
   */
  format?: "cron" | "timezone";
}

export interface PluginDescriptor {
  type: string;
  displayName: string;
  description: string;
  fields: FieldSchema[];
}

export interface TriggerEvent {
  triggerType: string;
  jobId: string;
  firedAt: EpochMs;
  scheduledFor: EpochMs | null;
  payload?: unknown;
}

export interface TriggerValidation<T = unknown> {
  ok: boolean;
  config?: T;
  errors?: string[];
}

/**
 * A trigger plugin decides *when* a job fires.
 * `nextFire` is the only required scheduling hook for time-based plugins;
 * `start`/`stop` let event-based plugins (webhook, file watch) subscribe.
 */
export interface TriggerPlugin<TConfig = any> {
  readonly type: string;
  readonly descriptor: PluginDescriptor;
  validate(raw: unknown): TriggerValidation<TConfig>;
  describe(config: TConfig): string;
  /** Next fire strictly after `after` (epoch ms). Time-based plugins only. */
  nextFire?(config: TConfig, after: EpochMs, lastFire: EpochMs | null): EpochMs | null;
  /** Event-based plugins register listeners here. */
  start?(ctx: TriggerPluginContext, job: JobSpec, config: TConfig): Promise<void> | void;
  stop?(jobId: string): Promise<void> | void;
}

export interface TriggerPluginContext {
  /** Deliver a trigger event into the engine. */
  emit(event: TriggerEvent): void;
  /** Logger scoped to the plugin. */
  log(level: "info" | "warn" | "error", message: string, detail?: unknown): void;
}

export interface AgentRunInput {
  runId: string;
  jobId: string;
  prompt: string;
  config: AgentConfig;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface AgentRunContext {
  /** Append a transcript line. `stream` is a label persisted with the line. */
  log(stream: string, line: string): void;
}

export interface AgentRunResult {
  ok: boolean;
  /** Final assistant text. */
  text: string;
  error?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  tokens?: TokenUsage;
  costTotal?: number;
  sessionId?: string | null;
  sessionFile?: string | null;
  model?: string | null;
}

export interface AgentAdapter {
  readonly type: string;
  readonly descriptor: PluginDescriptor;
  /** Validate/normalise adapter config (used for both YAML load and UI forms). */
  validate(raw: unknown): TriggerValidation<AgentConfig>;
  run(input: AgentRunInput, ctx: AgentRunContext): Promise<AgentRunResult>;
}

/* ------------------------------------------------------------------ */
/* API payloads                                                        */
/* ------------------------------------------------------------------ */

export interface ApiError {
  error: string;
  /** Field-level detail for validators. */
  details?: { path: string; message: string }[];
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  now: EpochMs;
  defaultTimezone: string;
  jobs: number;
  running: number;
}

export interface EngineStatus {
  running: RunSummary[];
  queued: number;
  jobs: number;
  enabledJobs: number;
  maxConcurrency: number;
  defaultTimezone: string;
  startedAt: EpochMs;
}

export interface TriggerInfo extends PluginDescriptor {
  builtins: boolean;
}

export interface AgentInfo extends PluginDescriptor {
  builtins: boolean;
}

/** POST /api/jobs and PUT /api/jobs/:id accept a JobSpec (validated server side). */
export interface UpsertJobResponse {
  job: JobView;
}

export interface CronPreviewRequest {
  cron?: string;
  every?: string;
  timezone?: string;
  count?: number;
  after?: EpochMs;
}

export interface CronPreviewResponse {
  fires: EpochMs[];
  scheduleText: string;
  error?: string;
}

/** SSE event envelope for `/api/runs/:id/stream` and `/api/events`. */
export type SseEvent =
  | { type: "log"; runId: string; stream: string; line: string; at: EpochMs }
  | { type: "run"; run: RunSummary }
  | { type: "job"; job: JobView }
  | { type: "ping"; at: EpochMs }
  | { type: "end"; runId: string; status: RunStatus };
