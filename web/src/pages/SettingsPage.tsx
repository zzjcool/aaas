import { useMemo } from "react";
import { errorMessage, http } from "../api.ts";
import { formatDuration, formatTime, LOCAL_TIMEZONE } from "../format.ts";
import { useNow, usePolling } from "../hooks/usePolling.ts";
import type { EngineStatus, HealthResponse } from "../types.ts";

/** Read-only engine introspection: `GET /api/health` + `GET /api/status`. */
export function SettingsPage() {
  const health = usePolling<HealthResponse>(() => http.get<HealthResponse>("/api/health"), [], { intervalMs: 10_000 });
  const status = usePolling<EngineStatus>(() => http.get<EngineStatus>("/api/status"), [], { intervalMs: 10_000 });
  const now = useNow(10_000);

  const zoneCount = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone").length;
    } catch {
      return null;
    }
  }, []);

  // Engine uptime: derived locally from `startedAt` so it ticks smoothly.
  const uptime = status.data ? formatDuration(Math.max(0, now - status.data.startedAt)) : "—";

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Settings</h1>
          <p className="page__sub">Read-only view of the engine’s health and status endpoints.</p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void health.refresh();
              void status.refresh();
            }}
            disabled={health.refreshing || status.refreshing}
          >
            {health.refreshing || status.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="settings-grid">
        <section className="card">
          <header className="card__head">
            <h2 className="card__title">Health</h2>
            <code className="card__endpoint">GET /api/health</code>
          </header>
          {health.error ? (
            <div className="banner banner--danger" role="alert">
              {errorMessage(health.error)}
            </div>
          ) : health.loading ? (
            <SkeletonRows rows={5} />
          ) : health.data ? (
            <dl className="kv kv--table">
              <Kv label="ok" value={health.data.ok ? "true" : "false"} tone={health.data.ok ? "success" : "danger"} />
              <Kv label="version" value={health.data.version} mono />
              <Kv label="now" value={formatTime(health.data.now)} />
              <Kv label="defaultTimezone" value={health.data.defaultTimezone} mono />
              <Kv label="jobs" value={String(health.data.jobs)} mono />
              <Kv label="running" value={String(health.data.running)} mono />
            </dl>
          ) : null}
        </section>

        <section className="card">
          <header className="card__head">
            <h2 className="card__title">Engine status</h2>
            <code className="card__endpoint">GET /api/status</code>
          </header>
          {status.error ? (
            <div className="banner banner--danger" role="alert">
              {errorMessage(status.error)}
            </div>
          ) : status.loading ? (
            <SkeletonRows rows={6} />
          ) : status.data ? (
            <dl className="kv kv--table">
              <Kv label="running" value={`${status.data.running.length} run(s)`} mono />
              <Kv label="queued" value={String(status.data.queued)} mono />
              <Kv label="jobs" value={String(status.data.jobs)} mono />
              <Kv label="enabledJobs" value={String(status.data.enabledJobs)} mono />
              <Kv label="maxConcurrency" value={String(status.data.maxConcurrency)} mono />
              <Kv label="defaultTimezone" value={status.data.defaultTimezone} mono />
              <Kv label="startedAt" value={`${formatTime(status.data.startedAt)} · up ${uptime}`} />
            </dl>
          ) : null}

          {status.data && status.data.running.length > 0 ? (
            <div className="card__sub">
              <h3 className="card__subtitle">In flight</h3>
              <ul className="mini-list">
                {status.data.running.map((run) => (
                  <li key={run.id}>
                    <span className="mono">{run.jobName}</span>
                    <span className="muted"> · {run.status} · {run.id}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className="card">
          <header className="card__head">
            <h2 className="card__title">Browser</h2>
            <code className="card__endpoint">local</code>
          </header>
          <dl className="kv kv--table">
            <Kv label="resolved timezone" value={LOCAL_TIMEZONE} mono />
            <Kv label="known timezones" value={zoneCount === null ? "unsupported" : String(zoneCount)} mono />
            <Kv label="locale" value={navigator.language} mono />
            <Kv label="now (local)" value={formatTime(Date.now())} />
          </dl>
          <p className="card__note">
            All times in this console render in the browser timezone. The engine stores epoch
            milliseconds only; job timezones apply to cron interpretation and to the job-timezone
            column in the schedule preview.
          </p>
        </section>
      </div>

      <p className="hint">
        Settings are read-only in this release — engine configuration lives in environment
        variables (see <code>docs/contract.md</code> §8).
      </p>
    </div>
  );
}

function Kv({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "success" | "danger";
}) {
  return (
    <div className="kv__item">
      <dt>{label}</dt>
      <dd className={`${mono ? "mono " : ""}${tone ? `text--${tone}` : ""}`.trim() || undefined} title={value}>
        {value}
      </dd>
    </div>
  );
}

function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="skeleton-rows" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="skeleton skeleton--line" />
      ))}
    </div>
  );
}

export default SettingsPage;
