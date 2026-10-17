#!/usr/bin/env node
/**
 * aaas CLI — thin wrapper over the REST API so operators can script the
 * platform without the web UI.
 *
 *   aaas health
 *   aaas jobs [--json]
 *   aaas show <jobId>
 *   aaas run <jobId> [--wait]
 *   aaas runs [--job <id>] [--limit 20]
 *   aaas log <runId> [--follow]
 *   aaas cancel <jobId>
 *   aaas enable/disable <jobId>
 *   aaas delete <jobId>
 *   aaas preview --cron "0 9 * * 1-5" --tz Asia/Shanghai
 *
 * Base URL: AAAS_URL (default http://127.0.0.1:7788)
 */

const BASE = (process.env.AAAS_URL ?? "http://127.0.0.1:7788").replace(/\/$/, "");

type Json = Record<string, unknown>;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const c = {
  dim: (s: string) => `\u001b[2m${s}\u001b[0m`,
  bold: (s: string) => `\u001b[1m${s}\u001b[0m`,
  red: (s: string) => `\u001b[31m${s}\u001b[0m`,
  green: (s: string) => `\u001b[32m${s}\u001b[0m`,
  yellow: (s: string) => `\u001b[33m${s}\u001b[0m`,
  cyan: (s: string) => `\u001b[36m${s}\u001b[0m`,
};

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "-";
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function fmtRelative(ms: number | null | undefined): string {
  if (!ms) return "";
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60_000);
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}

function statusBadge(status: string): string {
  if (status === "succeeded") return c.green(status);
  if (status === "running" || status === "queued") return c.cyan(status);
  if (status === "skipped") return c.yellow(status);
  if (status === "failed" || status === "timeout") return c.red(status);
  return c.dim(status);
}

function table(rows: string[][], headers: string[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join("  ");
  return [c.dim(line(headers)), c.dim(widths.map((w) => "-".repeat(w)).join("  ")), ...rows.map(line)].join("\n");
}

/* ------------------------------------------------------------------ */

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const positional = rest.filter((a) => !a.startsWith("--"));

  switch (command) {
    case "health": {
      const health = await api<Json>("/api/health");
      const status = await api<Json>("/api/status");
      console.log(`${c.bold("aaas")} ${health.version} ${c.green("ok")}`);
      console.log(`  endpoint       ${BASE}`);
      console.log(`  server time    ${fmtTime(health.now as number)}`);
      console.log(`  default tz     ${health.defaultTimezone}`);
      console.log(`  jobs           ${status.jobs} (${status.enabledJobs} enabled)`);
      console.log(`  live runs      ${status.running ? (status.running as unknown[]).length : 0} running, ${status.queued} queued`);
      console.log(`  concurrency    ${status.maxConcurrency}`);
      return 0;
    }

    case "jobs": {
      const jobs = await api<Json[]>("/api/jobs");
      if (flags.json) {
        console.log(JSON.stringify(jobs, null, 2));
        return 0;
      }
      if (jobs.length === 0) {
        console.log(c.dim("no jobs declared — add a YAML file under jobs/ or POST /api/jobs"));
        return 0;
      }
      console.log(
        table(
          jobs.map((j) => {
            const spec = j.spec as Json;
            const lastRun = j.lastRun as Json | null;
            return [
              String(spec.id),
              spec.enabled ? c.green("on") : c.dim("off"),
              String(j.scheduleText ?? ""),
              fmtTime(j.nextFireAt as number | null),
              fmtRelative(j.nextFireAt as number | null),
              lastRun ? statusBadge(String(lastRun.status)) : c.dim("-"),
              j.problem ? c.red(String(j.problem).slice(0, 40)) : "",
            ];
          }),
          ["ID", "ON", "SCHEDULE", "NEXT FIRE", "WHEN", "LAST RUN", "PROBLEM"],
        ),
      );
      return 0;
    }

    case "show": {
      const id = positional[0];
      if (!id) return usage("show <jobId>");
      const job = await api<Json>(`/api/jobs/${id}`);
      console.log(JSON.stringify(job, null, 2));
      return 0;
    }

    case "run": {
      const id = positional[0];
      if (!id) return usage("run <jobId> [--wait]");
      const response = await api<{ run: Json }>(`/api/jobs/${id}/run`, { method: "POST", body: JSON.stringify({}) });
      const runId = String(response.run.id);
      console.log(`${c.green("queued")} ${runId}`);
      if (flags.wait) return followRun(runId);
      return 0;
    }

    case "runs": {
      const query = new URLSearchParams();
      if (flags.job) query.set("jobId", String(flags.job));
      query.set("limit", String(flags.limit ?? 20));
      const runs = await api<Json[]>(`/api/runs?${query.toString()}`);
      if (flags.json) {
        console.log(JSON.stringify(runs, null, 2));
        return 0;
      }
      if (runs.length === 0) {
        console.log(c.dim("no runs yet"));
        return 0;
      }
      console.log(
        table(
          runs.map((r) => [
            String(r.id).replace(/^run_/, "").slice(0, 8),
            String(r.jobId),
            String(r.triggerKind),
            statusBadge(String(r.status)),
            r.durationMs ? `${Math.round(Number(r.durationMs) / 1000)}s` : "-",
            r.tokens ? `${((r.tokens as Json).total as number).toLocaleString()}` : "-",
            fmtTime(r.createdAt as number),
          ]),
          ["RUN", "JOB", "TRIGGER", "STATUS", "DUR", "TOKENS", "CREATED"],
        ),
      );
      return 0;
    }

    case "log": {
      const id = positional[0];
      if (!id) return usage("log <runId> [--follow]");
      if (flags.follow) return followRun(id);
      const data = await api<{ lines: { at: number; stream: string; line: string }[] }>(`/api/runs/${id}/log?tail=500`);
      for (const line of data.lines) printLogLine(line);
      return 0;
    }

    case "cancel": {
      const id = positional[0];
      if (!id) return usage("cancel <jobId>");
      const result = await api<{ cancelled: number }>(`/api/jobs/${id}/cancel`, { method: "POST", body: "{}" });
      console.log(`cancelled ${result.cancelled} run(s)`);
      return 0;
    }

    case "enable":
    case "disable": {
      const id = positional[0];
      if (!id) return usage(`${command} <jobId>`);
      const job = await api<Json>(`/api/jobs/${id}/enabled`, {
        method: "POST",
        body: JSON.stringify({ enabled: command === "enable" }),
      });
      const spec = job.spec as Json;
      console.log(`${spec.id}: ${spec.enabled ? "enabled" : "disabled"}`);
      return 0;
    }

    case "delete": {
      const id = positional[0];
      if (!id) return usage("delete <jobId>");
      await api<void>(`/api/jobs/${id}`, { method: "DELETE" });
      console.log(`deleted ${id}`);
      return 0;
    }

    case "preview": {
      const body: Json = { count: Number(flags.count ?? 5) };
      if (flags.cron) body.cron = flags.cron;
      if (flags.every) body.every = flags.every;
      if (flags.tz) body.timezone = flags.tz;
      const preview = await api<Json>("/api/schedule/preview", { method: "POST", body: JSON.stringify(body) });
      if (preview.error) {
        console.error(c.red(String(preview.error)));
        return 1;
      }
      console.log(c.dim(String(preview.scheduleText)));
      for (const fire of preview.fires as number[]) {
        console.log(`  ${fmtTime(fire)}  ${c.dim(fmtRelative(fire))}`);
      }
      return 0;
    }

    case "types": {
      const [triggers, agents] = await Promise.all([api<Json[]>("/api/triggers"), api<Json[]>("/api/agents")]);
      console.log(c.bold("triggers"));
      for (const t of triggers) console.log(`  ${String(t.type).padEnd(10)} ${t.displayName} — ${t.description}`);
      console.log(c.bold("agents"));
      for (const a of agents) console.log(`  ${String(a.type).padEnd(10)} ${a.displayName} — ${a.description}`);
      return 0;
    }

    default:
      return usage();
  }
}

async function followRun(runId: string): Promise<number> {
  const response = await fetch(`${BASE}/api/runs/${runId}/stream`);
  if (!response.ok || !response.body) throw new Error(`stream failed: ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  let exitCode = 0;
  // SAFETY: WHATWG ReadableStream of the SSE body yields Uint8Array chunks in Node.
  const body = response.body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let event: Json;
      try {
        event = JSON.parse(line.slice(6)) as Json;
      } catch {
        // Tolerate a torn frame rather than aborting the whole stream.
        continue;
      }
      if (event.type === "log") {
        // SAFETY: the engine emits log frames with exactly this shape (src/core/events.ts).
        printLogLine(event as unknown as { at: number; stream: string; line: string });
      }
      if (event.type === "end") {
        const status = String(event.status);
        console.log(`\n${status === "succeeded" ? c.green(status) : c.red(status)}`);
        if (status !== "succeeded") exitCode = 1;
        return exitCode;
      }
    }
  }
  return exitCode;
}

function printLogLine(line: { at: number; stream: string; line: string }): void {
  const stamp = fmtTime(line.at).slice(11, 19);
  const tag =
    line.stream === "stderr" ? c.red("ERR") : line.stream === "system" ? c.dim("SYS") : line.stream === "event" ? c.dim("EVT") : c.dim("OUT");
  for (const chunk of line.line.split("\n")) {
    if (chunk.length === 0) continue;
    console.log(`${c.dim(stamp)} ${tag} ${chunk}`);
  }
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function usage(extra?: string): number {
  console.log(`aaas CLI — base ${BASE}`);
  console.log("");
  console.log("  health                      service + scheduler status");
  console.log("  jobs [--json]               list jobs");
  console.log("  show <jobId>                full job view (JSON)");
  console.log("  run <jobId> [--wait]        trigger a run now");
  console.log("  runs [--job id] [--limit n] recent runs");
  console.log("  log <runId> [--follow]      transcript");
  console.log("  cancel <jobId>              cancel live runs");
  console.log("  enable|disable <jobId>      toggle scheduling");
  console.log("  delete <jobId>              remove the YAML file");
  console.log("  preview --cron \"0 9 * * 1-5\" [--tz Asia/Shanghai] [--count 5]");
  console.log("  types                       registered triggers and agents");
  if (extra) console.log(`\n${c.red("missing argument:")} ${extra}`);
  return extra ? 2 : 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(c.red(message));
    if (/ECONNREFUSED|fetch failed/.test(message)) {
      console.error(c.dim(`is the server running? try: npm start   (base: ${BASE})`));
    }
    process.exit(1);
  });
