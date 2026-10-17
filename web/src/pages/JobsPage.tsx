import { useCallback, useMemo, useState } from "react";
import { errorMessage, http } from "../api.ts";
import {
  formatDuration,
  formatRelativeFuture,
  formatRelativePast,
  formatTime,
} from "../format.ts";
import { useNow, usePolling } from "../hooks/usePolling.ts";
import type { AgentInfo, JobView, RunJobResponse, TriggerInfo } from "../types.ts";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { Toggle } from "../components/Toggle.tsx";

export interface JobsPageProps {
  onEdit: (job: JobView) => void;
  onNew: () => void;
  notify: (tone: "success" | "warn" | "danger" | "info", message: string) => void;
  /** Run detail navigation lives in App (state-driven tab switch). */
  onOpenRun: (runId: string) => void;
  triggers: TriggerInfo[];
  agents: AgentInfo[];
}

export function JobsPage({ onEdit, onNew, notify, onOpenRun, triggers, agents }: JobsPageProps) {
  const jobs = usePolling<JobView[]>(() => http.get<JobView[]>("/api/jobs"), [], { intervalMs: 5_000 });
  const now = useNow(10_000);

  const [busyId, setBusyId] = useState<string | null>(null);

  const list = jobs.data ?? [];
  const runningTotal = useMemo(() => list.reduce((sum, job) => sum + job.runningCount, 0), [list]);

  const onToggle = useCallback(
    async (job: JobView, enabled: boolean) => {
      setBusyId(job.spec.id);
      // Optimistic flip; the poller reconciles with the server shortly after.
      jobs.mutate((prev) => prev?.map((item) => (item.spec.id === job.spec.id ? { ...item, spec: { ...item.spec, enabled } } : item)) ?? prev);
      try {
        const updated = await http.post<JobView>(`/api/jobs/${encodeURIComponent(job.spec.id)}/enabled`, { enabled });
        jobs.mutate((prev) => prev?.map((item) => (item.spec.id === updated.spec.id ? updated : item)) ?? prev);
        notify("success", `${job.spec.id} ${enabled ? "enabled" : "disabled"}`);
      } catch (err) {
        // Roll back on failure.
        jobs.mutate((prev) => prev?.map((item) => (item.spec.id === job.spec.id ? job : item)) ?? prev);
        notify("danger", `Could not ${enabled ? "enable" : "disable"} ${job.spec.id}: ${errorMessage(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [jobs, notify],
  );

  const onRunNow = useCallback(
    async (job: JobView) => {
      setBusyId(job.spec.id);
      try {
        const result = await http.post<RunJobResponse>(
          `/api/jobs/${encodeURIComponent(job.spec.id)}/run`,
          {},
        );
        if (!result.run) {
          // The engine returns no record when the run was skipped.
          notify("warn", `${job.spec.id} did not start a run (previous run still active)`);
          await jobs.refresh();
          return;
        }
        notify("success", `Queued run for ${job.spec.id}`);
        await jobs.refresh();
        onOpenRun(result.run.id);
      } catch (err) {
        notify("danger", `Run failed: ${errorMessage(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [jobs, notify, onOpenRun],
  );

  const onDelete = useCallback(
    async (job: JobView) => {
      if (!window.confirm(`Delete job "${job.spec.id}"? The YAML file is removed from disk.`)) return;
      setBusyId(job.spec.id);
      try {
        await http.del(`/api/jobs/${encodeURIComponent(job.spec.id)}`);
        jobs.mutate((prev) => prev?.filter((item) => item.spec.id !== job.spec.id) ?? prev);
        notify("success", `Deleted ${job.spec.id}`);
      } catch (err) {
        notify("danger", `Delete failed: ${errorMessage(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [jobs, notify],
  );

  const pluginLoaded = triggers.length > 0 && agents.length > 0;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">
            Jobs
            {runningTotal > 0 ? (
              <span className="running-pill" title={`${runningTotal} run(s) in flight`}>
                <span className="dot dot--accent dot--pulse" aria-hidden="true" />
                {runningTotal} running
              </span>
            ) : null}
          </h1>
          <p className="page__sub">
            {list.length} job{list.length === 1 ? "" : "s"} declared in <code>jobs/*.yaml</code>
            {!pluginLoaded ? " · plugin descriptors still loading" : null}
          </p>
        </div>
        <div className="page__actions">
          <button type="button" className="btn" onClick={() => void jobs.refresh()} disabled={jobs.refreshing}>
            {jobs.refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="btn btn--primary" onClick={onNew} disabled={!pluginLoaded}>
            New job
          </button>
        </div>
      </header>

      {jobs.error ? (
        <div className="banner banner--danger" role="alert">
          Could not load jobs: {errorMessage(jobs.error)}
        </div>
      ) : null}

      {jobs.loading ? (
        <TableSkeleton rows={5} />
      ) : list.length === 0 ? (
        <div className="empty">
          <p className="empty__title">No jobs yet</p>
          <p className="empty__body">
            Add a YAML file under <code>jobs/</code>, or create one here. A job pairs a trigger
            (when) with an agent (how) and a prompt (what).
          </p>
          <button type="button" className="btn btn--primary" onClick={onNew} disabled={!pluginLoaded}>
            Create the first job
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Schedule</th>
                <th className="col-center">Enabled</th>
                <th>Next fire</th>
                <th>Last run</th>
                <th className="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((job) => {
                const busy = busyId === job.spec.id;
                const lastRun = job.lastRun;
                const disabled = job.spec.enabled === false;
                return (
                  <JobRow
                    key={job.spec.id}
                    job={job}
                    now={now}
                    busy={busy}
                    disabled={disabled}
                    lastRun={lastRun}
                    onToggle={onToggle}
                    onRunNow={onRunNow}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onOpenRun={onOpenRun}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface JobRowProps {
  job: JobView;
  now: number;
  busy: boolean;
  disabled: boolean;
  lastRun: JobView["lastRun"];
  onToggle: (job: JobView, enabled: boolean) => Promise<void>;
  onRunNow: (job: JobView) => Promise<void>;
  onEdit: (job: JobView) => void;
  onDelete: (job: JobView) => Promise<void>;
  onOpenRun: (runId: string) => void;
}

function JobRow({
  job,
  now,
  busy,
  disabled,
  lastRun,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
  onOpenRun,
}: JobRowProps) {
  const problem = job.problem;
  return (
    <>
      <tr className={problem ? "row--warn" : undefined}>
        <td>
          <div className="cell-name">
            <span className="cell-name__main">{job.spec.name || job.spec.id}</span>
            <code className="cell-name__id">{job.spec.id}</code>
            {job.spec.tags && job.spec.tags.length > 0 ? (
              <span className="tags">
                {job.spec.tags.slice(0, 4).map((tag) => (
                  <span key={tag} className="pill pill--ghost">
                    {tag}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        </td>
        <td>
          <span className="mono cell-schedule">{job.scheduleText}</span>
        </td>
        <td className="col-center">
          <Toggle
            checked={!disabled}
            label={`${disabled ? "Enable" : "Disable"} ${job.spec.id}`}
            busy={busy}
            disabled={Boolean(problem)}
            onChange={(next) => void onToggle(job, next)}
          />
        </td>
        <td>
          {job.nextFireAt === null ? (
            <span className="muted">—</span>
          ) : (
            <div className="cell-time">
              <span className="mono">{formatTime(job.nextFireAt)}</span>
              <span className="muted">{formatRelativeFuture(job.nextFireAt, now)}</span>
            </div>
          )}
        </td>
        <td>
          {lastRun ? (
            <div className="cell-lastrun">
              <span className="cell-lastrun__top">
                <StatusBadge status={lastRun.status} small />
                {job.runningCount > 0 ? (
                  <span className="dot dot--accent dot--pulse" title={`${job.runningCount} running`} aria-hidden="true" />
                ) : null}
              </span>
              <button
                type="button"
                className="linkbtn"
                title={`Open run ${lastRun.id}`}
                onClick={() => onOpenRun(lastRun.id)}
              >
                <span className="mono">{formatRelativePast(lastRun.finishedAt ?? lastRun.startedAt ?? lastRun.createdAt, now)}</span>
                <span className="muted"> · {formatDuration(lastRun.durationMs)}</span>
              </button>
            </div>
          ) : (
            <span className="muted">never run</span>
          )}
        </td>
        <td className="col-right">
          <div className="row-actions">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void onRunNow(job)}
              disabled={busy || Boolean(problem)}
              title="POST /api/jobs/:id/run"
            >
              Run now
            </button>
            <button type="button" className="btn btn--sm" onClick={() => onEdit(job)} disabled={busy}>
              Edit
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger-ghost"
              onClick={() => void onDelete(job)}
              disabled={busy}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>
      {problem ? (
        <tr className="row--warn">
          <td colSpan={6}>
            <div className="warn-line">
              <span className="warn-line__icon" aria-hidden="true">⚠</span>
              <span>
                <strong>{job.spec.id}</strong> failed to load: {problem}
              </span>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function TableSkeleton({ rows }: { rows: number }) {
  return (
    <div className="table-wrap" role="status" aria-busy="true" aria-label="Loading">
      <table className="table table--skeleton">
        <thead>
          <tr>
            <th>Name</th>
            <th>Schedule</th>
            <th className="col-center">Enabled</th>
            <th>Next fire</th>
            <th>Last run</th>
            <th className="col-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, index) => (
            <tr key={index}>
              {Array.from({ length: 6 }, (_, cell) => (
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

export default JobsPage;
