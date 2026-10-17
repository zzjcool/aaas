/**
 * Re-exports of the frozen shared contract types.
 *
 * The UI imports domain shapes from exactly one place so a contract bump only
 * touches this file. `import type` keeps the shared module out of the bundle.
 */
export type {
  AgentConfig,
  AgentInfo,
  AgentType,
  CronPreviewRequest,
  CronPreviewResponse,
  EngineStatus,
  EpochMs,
  FieldSchema,
  HealthResponse,
  JobSpec,
  JobView,
  PluginDescriptor,
  RunRecord,
  RunStatus,
  RunSummary,
  RunTriggerKind,
  SseEvent,
  TokenUsage,
  TriggerConfig,
  TriggerInfo,
  TriggerType,
  UpsertJobResponse,
} from "../../src/shared/types.ts";

import type { RunRecord } from "../../src/shared/types.ts";

/** Log line as returned by `GET /api/runs/:id/log` and the run SSE stream. */
export interface LogLine {
  at: number;
  stream: string;
  line: string;
}

/** Stream labels the engine emits (contract §4 / §7). */
export type LogStream = "stdout" | "stderr" | "event" | "system";

/** `GET /api/runs/:id/log` response. */
export interface RunLogResponse {
  runId: string;
  lines: LogLine[];
}

// SAFETY: these three are typed precisely so pages never hand-roll response
// shapes; they are shape-identical to the contract §5 responses.

/** `POST /api/jobs/:id/run` response (202). */
export interface RunJobResponse {
  run: RunRecord;
}

/** `POST /api/jobs/:id/cancel` response. */
export interface CancelJobResponse {
  cancelled: number;
}

/**
 * Error body shared by every non-2xx response (contract §5).
 * Shape-identical to `ApiError` in the shared contract.
 */
export interface ApiErrorBody {
  error: string;
  details?: { path: string; message: string }[];
}
