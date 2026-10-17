import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, http } from "../api.ts";
import {
  durationBetween,
  formatClock,
  formatCost,
  formatCount,
  formatDuration,
  formatTime,
  truncate,
} from "../format.ts";
import { useNow } from "../hooks/usePolling.ts";
import { useSse, type SseStatus } from "../hooks/useSse.ts";
import type { LogLine, LogStream, RunLogResponse, RunRecord, SseEvent } from "../types.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { Modal } from "./Modal.tsx";

const TAIL = 500;

const STREAMS: LogStream[] = ["stdout", "stderr", "event", "system"];

export interface RunDetailProps {
  runId: string;
  onClose: () => void;
  /** Lets the Runs list refetch after a cancel. */
  onChanged?: () => void;
  notify: (tone: "success" | "warn" | "danger" | "info", message: string) => void;
}

/** Run detail panel: header fields (contract §5 `RunRecord`) + live log tail. */
export function RunDetail({ runId, onClose, onChanged, notify }: RunDetailProps) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const loadRun = useCallback(async (): Promise<RunRecord | null> => {
    try {
      const record = await http.get<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`);
      setRun(record);
      setLoadError(null);
      return record;
    } catch (err) {
      setLoadError(errorMessage(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    setLoading(true);
    setRun(null);
    void loadRun();
  }, [loadRun]);

  const isLive = run?.status === "running" || run?.status === "queued";

  /* ------------------------------ logs ------------------------------ */

  const [lines, setLines] = useState<LogLine[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [visible, setVisible] = useState<Record<LogStream, boolean>>({
    stdout: true,
    stderr: true,
    event: false, // `event` folded away by default, per the task spec
    system: true,
  });

  /**
   * Lines that arrived over SSE before the `/log?tail=` snapshot resolved.
   * The snapshot is authoritative for history, but any live line that is not
   * already its tail must be appended — otherwise log lines that stream in
   * during the initial fetch are lost when the snapshot overwrites state.
   */
  const liveLinesRef = useRef<LogLine[]>([]);

  const loadLog = useCallback(async () => {
    setLogsLoading(true);
    try {
      const response = await http.get<RunLogResponse>(`/api/runs/${encodeURIComponent(runId)}/log?tail=${TAIL}`);
      setLines(mergeSnapshot(response.lines, liveLinesRef.current));
      liveLinesRef.current = [];
      setLogsError(null);
    } catch (err) {
      setLogsError(errorMessage(err));
    } finally {
      setLogsLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    setLines([]);
    liveLinesRef.current = [];
    void loadLog();
  }, [loadLog]);

  const onSseEvent = useCallback(
    (event: SseEvent) => {
      if (event.type === "log") {
        const line: LogLine = { at: event.at, stream: event.stream, line: event.line };
        liveLinesRef.current.push(line);
        setLines((prev) => [...prev, line]);
        return;
      }
      if (event.type === "end") {
        // Terminal frame: pull the final `RunRecord` so header fields settle.
        void loadRun().then(() => onChanged?.());
      }
    },
    [loadRun, onChanged],
  );

  const streamUrl = `/api/runs/${encodeURIComponent(runId)}/stream`;
  // Only subscribe while the run can still produce output. A finished run never
  // sends `end` again, so an unconditional EventSource would idle forever.
  const { status: sseStatus, close: closeSse } = useSse(streamUrl, { onEvent: onSseEvent, enabled: isLive });

  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => lines.filter((line) => visible[toStream(line.stream)]), [lines, visible]);

  // Follow mode: stick to the bottom as new lines arrive.
  useEffect(() => {
    if (!follow) return;
    const box = logBoxRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }, [filtered, follow]);

  const onScroll = useCallback(() => {
    const box = logBoxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    // Scrolling up pauses follow, scrolling back to the bottom resumes it.
    setFollow((prev) => (prev === atBottom ? prev : atBottom));
  }, []);

  const onClear = useCallback(() => setLines([]), []);

  const onCopy = useCallback(() => {
    const text = filtered.map((line) => `${formatClock(line.at)} [${line.stream}] ${line.line}`).join("\n");
    void navigator.clipboard
      .writeText(text)
      .then(() => notify("success", `Copied ${filtered.length} lines`))
      .catch((err: unknown) => notify("danger", `Copy failed: ${errorMessage(err)}`));
  }, [filtered, notify]);

  /* ----------------------------- actions ---------------------------- */

  const onCancel = useCallback(async () => {
    if (!run) return;
    setCancelling(true);
    try {
      const result = await http.post<{ cancelled: number }>(
        `/api/jobs/${encodeURIComponent(run.jobId)}/cancel`,
      );
      notify("warn", result.cancelled > 0 ? `Cancel requested for ${result.cancelled} run(s)` : "Nothing to cancel");
      await loadRun();
      onChanged?.();
    } catch (err) {
      notify("danger", `Cancel failed: ${errorMessage(err)}`);
    } finally {
      setCancelling(false);
    }
  }, [run, notify, loadRun, onChanged]);

  const now = useNow(1000, isLive);

  return (
    <Modal
      title={run ? `Run · ${run.jobName}` : "Run"}
      subtitle={runId}
      onClose={onClose}
      variant="panel"
      className="modal--run"
      footer={
        <>
          <span className="muted mono">
            stream: {sseLabel(sseStatus, isLive)}
          </span>
          <span className="grow" />
          {isLive ? (
            <button type="button" className="btn btn--danger" onClick={() => void onCancel()} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "Cancel run"}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {loading ? (
        <div className="skeleton skeleton--rows" role="status" aria-label="Loading run" />
      ) : loadError ? (
        <div className="banner banner--danger" role="alert">
          Could not load run: {loadError}
        </div>
      ) : run ? (
        <>
          <section className="run-head">
            <div className="run-head__status">
              <StatusBadge status={run.status} pulse={isLive} />
              {run.attempt > 1 ? <span className="pill">attempt {run.attempt}</span> : null}
              <span className="pill pill--ghost">{run.triggerKind}</span>
            </div>
            <dl className="kv kv--grid">
              <Kv label="id" value={run.id} mono />
              <Kv label="job" value={run.jobId} mono />
              <Kv label="trigger" value={run.triggerKind} />
              <Kv label="attempt" value={String(run.attempt)} />
              <Kv label="exit code" value={run.exitCode === null ? "—" : String(run.exitCode)} mono />
              <Kv label="scheduled for" value={formatTime(run.scheduledFor)} />
              <Kv label="started at" value={formatTime(run.startedAt)} />
              <Kv label="finished at" value={formatTime(run.finishedAt)} />
              <Kv
                label="duration"
                value={formatDuration(run.durationMs ?? durationBetween(run.startedAt, null, now))}
              />
              <Kv
                label="tokens"
                value={run.tokens ? `${formatCount(run.tokens.total)} (${formatCount(run.tokens.input)} in / ${formatCount(run.tokens.output)} out)` : "—"}
              />
              <Kv label="cost" value={formatCost(run.costTotal)} />
              <Kv label="session" value={run.sessionId ?? "—"} mono />
            </dl>
            {run.error ? (
              <div className="banner banner--danger" role="alert">
                <strong>Error</strong>
                <pre className="banner__pre">{run.error}</pre>
              </div>
            ) : null}
            {run.resultText ? (
              <details className="result">
                <summary>Result text ({run.resultText.length} chars)</summary>
                <pre className="code-block">{run.resultText}</pre>
              </details>
            ) : null}
          </section>

          {/* ------------------------- log panel ------------------------- */}
          <section className="logs">
            <header className="logs__bar">
              <h3 className="logs__title">
                Log
                <span className="muted"> · {filtered.length}/{lines.length} lines</span>
              </h3>
              <div className="logs__tools">
                <label className="check">
                  <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.currentTarget.checked)} />
                  <span>Follow</span>
                </label>
                <button type="button" className="btn btn--sm" onClick={onClear} disabled={lines.length === 0}>
                  Clear
                </button>
                <button type="button" className="btn btn--sm" onClick={onCopy} disabled={filtered.length === 0}>
                  Copy all
                </button>
                {isLive ? (
                  <button type="button" className="btn btn--sm" onClick={closeSse} disabled={sseStatus !== "open"}>
                    Disconnect
                  </button>
                ) : null}
              </div>
            </header>

            <div className="logs__filters">
              {STREAMS.map((stream) => (
                <label key={stream} className={`check check--${stream}`}>
                  <input
                    type="checkbox"
                    checked={visible[stream]}
                    onChange={(event) =>
                      setVisible((prev) => ({ ...prev, [stream]: event.currentTarget.checked }))
                    }
                  />
                  <span className="check__swatch" aria-hidden="true" />
                  <span>{stream}</span>
                  <span className="muted">{countStream(lines, stream)}</span>
                </label>
              ))}
            </div>

            {logsError ? (
              <div className="banner banner--danger" role="alert">
                Could not load logs: {logsError}
              </div>
            ) : null}

            <div className="logs__box" ref={logBoxRef} onScroll={onScroll}>
              {logsLoading ? (
                <div className="skeleton skeleton--log" role="status" aria-label="Loading log" />
              ) : filtered.length === 0 ? (
                <p className="empty empty--inline">
                  {lines.length === 0 ? "No log output yet." : "All streams are filtered out."}
                </p>
              ) : (
                filtered.map((line, index) => <LogRow key={`${line.at}-${index}`} line={line} />)
              )}
            </div>
          </section>
        </>
      ) : null}
    </Modal>
  );
}

function LogRow({ line }: { line: LogLine }) {
  const stream = toStream(line.stream);
  return (
    <div className={`logline logline--${stream}`}>
      <span className="logline__at">{formatClock(line.at)}</span>
      <span className="logline__stream">{stream}</span>
      <span className="logline__text" title={line.line}>
        {line.line}
      </span>
    </div>
  );
}

function Kv({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="kv__item">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined} title={value}>
        {mono ? truncate(value, 64) : value}
      </dd>
    </div>
  );
}

function toStream(raw: string): LogStream {
  switch (raw) {
    case "stdout":
    case "stderr":
    case "event":
    case "system":
      return raw;
    default:
      // Unknown labels keep their own colour bucket instead of being dropped.
      return "system";
  }
}

/**
 * Snapshot + live merge.
 *
 * The tail snapshot wins for history (it is the server's JSONL view), and live
 * lines that are not already the snapshot's tail are appended in arrival order.
 */
function mergeSnapshot(snapshot: LogLine[], live: LogLine[]): LogLine[] {
  if (live.length === 0) return snapshot;
  const key = (line: LogLine): string => `${line.at}\u0000${line.stream}\u0000${line.line}`;
  const seen = new Set(snapshot.map(key));
  const extra = live.filter((line) => !seen.has(key(line)));
  return extra.length === 0 ? snapshot : [...snapshot, ...extra];
}

function countStream(lines: LogLine[], stream: LogStream): number {
  return lines.reduce((total, line) => (toStream(line.stream) === stream ? total + 1 : total), 0);
}

function sseLabel(status: SseStatus, isLive: boolean): string {
  if (!isLive) return "finished";
  switch (status) {
    case "open":
      return "live";
    case "connecting":
      return "connecting…";
    case "error":
      return "reconnecting…";
    case "closed":
      return "disconnected";
    default:
      return "idle";
  }
}

export default RunDetail;