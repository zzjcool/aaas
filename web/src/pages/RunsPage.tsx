import { useCallback, useMemo, useState } from "react";
import { errorMessage, http } from "../api.ts";
import {
  formatCost,
  formatCount,
  formatDuration,
  formatRelativePast,
  formatTime,
  truncate,
} from "../format.ts";
import { useNow, usePolling } from "../hooks/usePolling.ts";
import type { JobView, RunStatus, RunSummary } from "../types.ts";
import { StatusBadge } from "../components/StatusBadge.tsx";

const STATUSES: RunStatus[] = ["queued", "running", "succeeded", "failed", "timeout", "cancelled", "skipped"];
const LIMITS = [25, 50, 100, 250, 500];

export interface RunsPageProps {
  onOpenRun: (runId: string) => void;
  /** Bumped by App to force a refetch after a cancel/run action. */
  refreshKey?: number;
}

export function RunsPage({ onOpenRun, refreshKey = 0 }: RunsPageProps) {
  const [jobId, setJobId] = useState("");
  const [statuses, setStatuses] = useState<RunStatus[]>([]);
  const [limit, setLimit] = useState(100);

  const jobs = usePolling<JobView[]>(() => http.get<JobView[]>("/api/jobs"), [], { intervalMs: 15_000 });

  const query = useMemo(() => buildQuery({ jobId, statuses, limit }), [jobId, statuses, limit]);
  const runs = usePolling<RunSummary[]>(
    () => http.get<RunSummary[]>(`/api/runs${query}`),
    [query, refreshKey],
    { intervalMs: 5_000 },
  );

  const now = useNow(10_000);
  const list = runs.data ?? [];

  const toggleStatus = useCallback((status: RunStatus) => {
    setStatuses((prev) => (prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]));
  }, []);

  const resetFilters = useCallback(() => {
    setJobId("");
    setStatuses([]);
    setLimit(100);
  }, []);

  const filtersDirty = jobId !== "" || statuses.length > 0 || limit !== 100;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Runs</h1>
          <p className="page__sub">
            {runs.loading ? "loading…" : `${list.length} run${list.length === 1 ? "" : "s"}`}
            {filtersDirty ? " (filtered)" : ""}
          </p>
        </div>
        <div className="page__actions">
          <button type="button" className="btn" onClick={() => void runs.refresh()} disabled={runs.refreshing}>
            {runs.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="filters" aria-label="Run filters">
        <label className="filters__field">
          <span className="filters__label">Job</span>
          <select className="input input--select" value={jobId} onChange={(event) => setJobId(event.currentTarget.value)}>
            <option value="">All jobs</option>
            {(jobs.data ?? []).map((job) => (
              <option key={job.spec.id} value={job.spec.id}>
                {job.spec.name || job.spec.id}
              </option>
            ))}
          </select>
        </label>

        <div className="filters__field filters__field--grow">
          <span className="filters__label">Status</span>
          <div className="chips">
            {STATUSES.map((status) => {
              const active = statuses.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  className={`chip chip--${status}${active ? " chip--active" : ""}`}
                  aria-pressed={active}
                  onClick={() => toggleStatus(status)}
                >
                  {status}
                </button>
              );
            })}
          </div>
        </div>

        <label className="filters__field filters__field--narrow">
          <span className="filters__label">Limit</span>
          <select
            className="input input--select"
            value={String(limit)}
            onChange={(event) => setLimit(Number(event.currentTarget.value))}
          >
            {LIMITS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="btn btn--sm filters__reset" onClick={resetFilters} disabled={!filtersDirty}>
          Reset
        </button>
      </section>

      {runs.error ? (
        <div className="banner banner--danger" role="alert">
          Could not load runs: {errorMessage(runs.error)}
        </div>
      ) : null}

      {runs.loading ? (
        <RunsSkeleton rows={8} />
      ) : list.length === 0 ? (
        <div className="empty">
          <p className="empty__title">No runs match these filters</p>
          <p className="empty__body">
            {filtersDirty
              ? "Try clearing the status or job filter."
              : "Runs appear here once a job fires or you use “Run now” on the Jobs page."}
          </p>
          {filtersDirty ? (
            <button type="button" className="btn" onClick={resetFilters}>
              Reset filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table table--runs">
            <thead>
              <tr>
                <th>Time</th>
                <th>Job</th>
                <th>Trigger</th>
                <th>Status</th>
                <th className="col-right">Duration</th>
                <th className="col-right">Tokens</th>
                <th className="col-right">Cost</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {list.map((run) => (
                <tr
                  key={run.id}
                  className="row--clickable"
                  tabIndex={0}
                  role="button"
                  aria-label={`Open run ${run.id}`}
                  onClick={() => onOpenRun(run.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenRun(run.id);
                    }
                  }}
                >
                  <td>
                    <div className="cell-time">
                      <span className="mono">{formatTime(run.startedAt ?? run.createdAt)}</span>
                      <span className="muted">
                        {formatRelativePast(run.startedAt ?? run.createdAt, now)}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="cell-name">
                      <span className="cell-name__main">{run.jobName}</span>
                      <code className="cell-name__id">{run.jobId}</code>
                    </div>
                  </td>
                  <td>
                    <span className="pill pill--ghost">{run.triggerKind}</span>
                  </td>
                  <td>
                    <StatusBadge
                      status={run.status}
                      small
                      pulse={run.status === "running"}
                    />
                    {run.attempt > 1 ? <span className="muted"> ×{run.attempt}</span> : null}
                  </td>
                  <td className="col-right mono">{formatDuration(run.durationMs)}</td>
                  <td className="col-right mono">{formatCount(run.tokens?.total)}</td>
                  <td className="col-right mono">{formatCost(run.costTotal)}</td>
                  <td>
                    {run.error ? (
                      <span className="cell-error" title={run.error}>
                        {truncate(run.error, 56)}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.length >= limit ? (
        <p className="hint">
          Showing the most recent {limit} runs. Raise the limit or filter by job to see more.
        </p>
      ) : null}
    </div>
  );
}

function buildQuery({ jobId, statuses, limit }: { jobId: string; statuses: RunStatus[]; limit: number }): string {
  const params = new URLSearchParams();
  if (jobId !== "") params.set("jobId", jobId);
  if (statuses.length > 0) params.set("status", statuses.join(","));
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

function RunsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="table-wrap" role="status" aria-busy="true" aria-label="Loading runs">
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Job</th>
            <th>Trigger</th>
            <th>Status</th>
            <th className="col-right">Duration</th>
            <th className="col-right">Tokens</th>
            <th className="col-right">Cost</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, index) => (
            <tr key={index}>
              {Array.from({ length: 8 }, (_, cell) => (
                <td key={cell}>
                  <span className="skeleton skeleton--line" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default RunsPage;
