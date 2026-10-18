import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, http } from "./api.ts";
import { formatNow, formatTime, LOCAL_TIMEZONE } from "./format.ts";
import { useNow, usePolling } from "./hooks/usePolling.ts";
import type { AgentInfo, HealthResponse, JobView, TriggerInfo } from "./types.ts";
import { JobEditor } from "./components/JobEditor.tsx";
import { RunDetail } from "./components/RunDetail.tsx";
import { ToastStack, type ToastItem, type ToastTone } from "./components/Toast.tsx";
import { JobsPage } from "./pages/JobsPage.tsx";
import { RunsPage } from "./pages/RunsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";

type Tab = "jobs" | "runs" | "settings";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "jobs", label: "Jobs", hint: "Scheduled tasks" },
  { id: "runs", label: "Runs", hint: "Execution history" },
  { id: "settings", label: "Settings", hint: "Engine status" },
];

const TOAST_TTL_MS = 6_000;

export function App() {
  const [tab, setTab] = useState<Tab>("jobs");
  const [editorJob, setEditorJob] = useState<JobView | null | undefined>(undefined);
  const [runId, setRunId] = useState<string | null>(null);
  const [runsRefreshKey, setRunsRefreshKey] = useState(0);

  /* ----------------------------- toasts ----------------------------- */

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const timers = useRef<number[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (tone: ToastTone, message: string, detail?: string) => {
      const id = ++toastSeq.current;
      setToasts((prev) => [...prev.slice(-4), { id, tone, message, ...(detail ? { detail } : {}) }]);
      const timer = window.setTimeout(() => dismiss(id), TOAST_TTL_MS);
      timers.current.push(timer);
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current = [];
    },
    [],
  );

  /* ------------------------ bootstrap data -------------------------- */

  const health = usePolling<HealthResponse>(() => http.get<HealthResponse>("/api/health"), [], {
    intervalMs: 15_000,
  });
  const triggers = usePolling<TriggerInfo[]>(() => http.get<TriggerInfo[]>("/api/triggers"), []);
  const agents = usePolling<AgentInfo[]>(() => http.get<AgentInfo[]>("/api/agents"), []);

  // Surface a persistent connectivity failure once, rather than on every poll.
  const reportedOffline = useRef(false);
  useEffect(() => {
    if (health.error && !reportedOffline.current) {
      reportedOffline.current = true;
      notify("danger", "Engine unreachable", errorMessage(health.error));
    }
    if (!health.error && reportedOffline.current) {
      reportedOffline.current = false;
      notify("success", "Engine reachable again");
    }
  }, [health.error, notify]);

  const defaultTimezone = health.data?.defaultTimezone ?? "UTC";
  const online = health.data?.ok === true && !health.error;
  const now = useNow(1_000);

  /* --------------------------- navigation --------------------------- */

  const openNewJob = useCallback(() => setEditorJob(null), []);
  const openEditJob = useCallback((job: JobView) => setEditorJob(job), []);
  const closeEditor = useCallback(() => setEditorJob(undefined), []);
  const openRun = useCallback((id: string) => {
    setRunId(id);
    setTab("runs");
  }, []);
  const closeRun = useCallback(() => setRunId(null), []);

  const onJobSaved = useCallback(() => {
    setEditorJob(undefined);
    setRunsRefreshKey((key) => key + 1);
  }, []);

  const onJobDeleted = useCallback(() => {
    setEditorJob(undefined);
  }, []);

  const editorOpen = editorJob !== undefined;

  const tabLabel = useMemo(() => TABS.find((item) => item.id === tab)?.label ?? "", [tab]);

  return (
    <div className="app">
      <nav className="nav" aria-label="Primary">
        <div className="nav__brand">
          <span className="nav__logo" aria-hidden="true">◈</span>
          <span className="nav__name">trigger</span>
        </div>
        <ul className="nav__list">
          {TABS.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`nav__link${tab === item.id ? " nav__link--active" : ""}`}
                aria-current={tab === item.id ? "page" : undefined}
                onClick={() => setTab(item.id)}
              >
                <span className="nav__label">{item.label}</span>
                <span className="nav__hint">{item.hint}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="nav__foot">
          <span className={`dot dot--${online ? "success" : "danger"}${online ? "" : " dot--pulse"}`} aria-hidden="true" />
          <span>{online ? "engine online" : "engine offline"}</span>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="topbar__left">
            <span className="topbar__crumb">{tabLabel}</span>
          </div>
          <div className="topbar__right">
            <span className="topbar__stat" title="GET /api/health">
              <span className={`dot dot--${online ? "success" : "danger"}${online ? "" : " dot--pulse"}`} aria-hidden="true" />
              {online ? "healthy" : "unreachable"}
            </span>
            <span className="topbar__stat" title="Browser local time">
              {formatNow(now)}
            </span>
            <span className="topbar__stat" title="Engine default timezone">
              <span className="muted">tz</span> {defaultTimezone}
            </span>
            <span className="topbar__stat topbar__stat--muted" title="Browser timezone">
              <span className="muted">local</span> {LOCAL_TIMEZONE}
            </span>
          </div>
        </header>

        <main className="content">
          {tab === "jobs" ? (
            <JobsPage
              onEdit={openEditJob}
              onNew={openNewJob}
              notify={notify}
              onOpenRun={openRun}
              triggers={triggers.data ?? []}
              agents={agents.data ?? []}
            />
          ) : null}
          {tab === "runs" ? (
            <RunsPage onOpenRun={openRun} refreshKey={runsRefreshKey} />
          ) : null}
          {tab === "settings" ? <SettingsPage /> : null}
        </main>

        <footer className="footer">
          <span>
            trigger console · engine {health.data?.version ?? "—"}
          </span>
          <span className="muted">
            {health.data ? `${health.data.jobs} jobs · ${health.data.running} running` : "connecting…"}
            {health.data ? ` · health at ${formatTime(health.data.now)}` : ""}
          </span>
        </footer>
      </div>

      {editorOpen ? (
        <JobEditor
          job={editorJob ?? null}
          triggers={triggers.data ?? []}
          agents={agents.data ?? []}
          defaultTimezone={defaultTimezone}
          onClose={closeEditor}
          onSaved={onJobSaved}
          onDeleted={onJobDeleted}
          notify={notify}
        />
      ) : null}

      {runId !== null ? (
        <RunDetail
          runId={runId}
          onClose={closeRun}
          onChanged={() => setRunsRefreshKey((key) => key + 1)}
          notify={notify}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

export default App;
