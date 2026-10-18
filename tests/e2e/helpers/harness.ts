/**
 * E2E harness: boots the REAL engine (src/server/main.ts) as a subprocess and
 * talks to it over HTTP, exactly like the Web UI and `trigger` CLI do.
 *
 * Why a subprocess and not `app.inject()`:
 *   `app.inject()` bypasses listen(), TCP, SSE flushing, SIGTERM shutdown and
 *   static-file serving — precisely the things E2E exists to cover. Every test
 *   therefore gets a real port, a real data dir and a process that must exit
 *   cleanly.
 *
 * The pi binary is swappable via TRIGGER_PI_BIN, which the engine already honours:
 *   fake  — tests/e2e/fixtures/fake-pi.mjs; offline, deterministic, runs the
 *           real adapter (spawn + JSONL RPC) with the model stubbed out. CI-safe.
 *   real  — the `pi` on PATH; needs credentials and an endpoint. Local/QA only.
 *
 * A test never silently degrades: `requireRealPi()` throws when the environment
 * cannot provide a real model, instead of quietly passing with a fake.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root: tests/e2e/helpers -> ../../.. */
export const repoRoot = resolve(here, "..", "..", "..");

/** Deterministic stand-in for `pi` (speaks the RPC protocol, no model needed). */
export const FAKE_PI = join(repoRoot, "tests", "e2e", "fixtures", "fake-pi.mjs");

/**
 * The engine honours TRIGGER_PI_BIN, so the fake pi is handed over as a real
 * executable: chmod +x once, then spawn it directly. (It carries a `node`
 * shebang, so there is no wrapper script to keep in sync.)
 *
 * CI has no network and no provider, but it does have node — so this path is
 * the one that makes "the adapter really spawned pi and parsed the protocol"
 * assertable on every PR.
 */
export function useFakePi(): string {
  if (!existsSync(FAKE_PI)) throw new Error(`fake pi fixture missing: ${FAKE_PI}`);
  chmodSync(FAKE_PI, 0o755);
  return FAKE_PI;
}

/** Default model for real-pi runs; override per environment. */
export const DEFAULT_MODEL = process.env.TRIGGER_E2E_MODEL ?? "workbuddy/hy4-preview-ioa";
export const DEFAULT_PROVIDER = process.env.TRIGGER_E2E_PROVIDER ?? "any-endpoint";

export type PiMode = "fake" | "real";

/** True when the caller asked for real pi (TRIGGER_E2E_PI=real). */
export function wantsRealPi(): boolean {
  return process.env.TRIGGER_E2E_PI === "real";
}

/** Fail loudly instead of silently testing with a fake. */
export function requireRealPi(): void {
  if (!wantsRealPi()) throw new Error("this test needs TRIGGER_E2E_PI=real (a model endpoint)");
}

export interface BootOptions {
  /** Which pi binary the engine spawns. Defaults to fake, or real if TRIGGER_E2E_PI=real. */
  pi?: PiMode;
  /** Built web assets to serve; `null` forces "ui not built". Default: web/dist if present. */
  webDir?: string | null;
  env?: Record<string, string | undefined>;
  awaitReady?: boolean;
  readyTimeoutMs?: number;
}

export interface Engine {
  baseUrl: string;
  port: number;
  dataDir: string;
  jobsDir: string;
  /** Root of the temp dir (data/ and jobs/ live inside it). */
  root: string;
  /** Accumulated stdout+stderr, for failure diagnosis. */
  output(): string;
  /** SIGTERM, escalate to SIGKILL, remove temp dirs. Idempotent. */
  stop(): Promise<number | null>;
  readonly proc: ChildProcessByStdio<null, Readable, Readable>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): number {
  return 30_000 + Math.floor(Math.random() * 20_000);
}

export async function health(baseUrl: string, timeoutMs = 2000): Promise<{ ok: boolean } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    return (await res.json()) as { ok: boolean };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function bootEngine(options: BootOptions = {}): Promise<Engine> {
  const pi: PiMode = options.pi ?? (wantsRealPi() ? "real" : "fake");
  const dir = mkdtempSync(join(tmpdir(), "trigger-e2e-"));
  const dataDir = join(dir, "data");
  const jobsDir = join(dir, "jobs");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(jobsDir, { recursive: true });

  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const webDir = options.webDir === undefined ? join(repoRoot, "web", "dist") : options.webDir;

  const env: Record<string, string | undefined> = {
    ...process.env,
    TRIGGER_PORT: String(port),
    TRIGGER_HOST: "127.0.0.1",
    TRIGGER_DATA_DIR: dataDir,
    TRIGGER_JOBS_DIR: jobsDir,
    TRIGGER_TICK_MS: "200",
    TRIGGER_DEFAULT_TZ: "Asia/Shanghai",
    TRIGGER_MAX_CONCURRENCY: "4",
    NO_COLOR: "1",
    ...(pi === "fake"
      ? { TRIGGER_PI_BIN: useFakePi() }
      : { TRIGGER_PI_BIN: process.env.TRIGGER_E2E_PI_BIN || "pi" }),
    ...(webDir ? { TRIGGER_WEB_DIR: webDir } : { TRIGGER_WEB_DIR: "" }),
    ...options.env,
  };

  const proc = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "src", "server", "main.ts")], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";
  const cap = 200_000;
  const onData = (chunk: Buffer | string) => {
    buffer += String(chunk);
    if (buffer.length > cap) buffer = buffer.slice(buffer.length - cap);
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  let stopped = false;
  const engine: Engine = {
    baseUrl,
    port,
    dataDir,
    jobsDir,
    root: dir,
    proc,
    output: () => buffer,
    async stop() {
      if (stopped) return proc.exitCode;
      stopped = true;
      let code: number | null = proc.exitCode;
      if (code === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        const deadline = Date.now() + 5_000;
        while (code === null && proc.signalCode === null && Date.now() < deadline) {
          await sleep(50);
          code = proc.exitCode;
        }
        if (code === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
      proc.stdout.removeAllListeners();
      proc.stderr.removeAllListeners();
      rmSync(dir, { recursive: true, force: true });
      return code;
    },
  };

  if (options.awaitReady !== false) {
    const timeout = options.readyTimeoutMs ?? 25_000;
    const deadline = Date.now() + timeout;
    let ready = false;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        await engine.stop();
        throw new Error(`engine exited during boot (code ${proc.exitCode}):\n${buffer}`);
      }
      if ((await health(baseUrl, 1000))?.ok === true) {
        ready = true;
        break;
      }
      await sleep(100);
    }
    if (!ready) {
      await engine.stop();
      throw new Error(`engine not ready within ${timeout}ms:\n${buffer}`);
    }
  }

  return engine;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

export interface ApiResult {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

async function request(engine: Engine, path: string, init?: RequestInit): Promise<ApiResult> {
  const res = await fetch(`${engine.baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* SSE / HTML stays raw */
  }
  return { status: res.status, body, text, headers: res.headers };
}

export const get = (engine: Engine, path: string) => request(engine, path);

export const post = (engine: Engine, path: string, payload?: unknown) =>
  request(engine, path, { method: "POST", body: payload === undefined ? undefined : JSON.stringify(payload ?? {}) });

export const put = (engine: Engine, path: string, payload: unknown) =>
  request(engine, path, { method: "PUT", body: JSON.stringify(payload) });

/**
 * DELETE with no body and NO content-type header at all.
 * Fastify 415s an empty-string content-type and 400s an empty body when the
 * header says application/json, so the header has to be absent, not blank.
 */
export async function del(engine: Engine, path: string): Promise<ApiResult> {
  const res = await fetch(`${engine.baseUrl}${path}`, { method: "DELETE" });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* empty or non-JSON body is normal for 204 */
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** Poll until `done(last)` or throw with the last observed value. */
export async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (Date.now() < deadline) {
    if (done(last)) return last;
    await sleep(intervalMs);
    last = await read();
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms; last: ${JSON.stringify(last)}`);
}

/** Wait for a run to leave queued/running. Returns the final RunRecord. */
export function waitForRun(engine: Engine, runId: string, timeoutMs = 40_000): Promise<any> {
  return waitFor(
    `run ${runId} to settle`,
    async () => (await get(engine, `/api/runs/${runId}`)).body,
    (r) => r && r.status !== "queued" && r.status !== "running",
    timeoutMs,
  );
}

/** Write a job YAML straight into the jobs dir (the source of truth). */
export function writeJobFile(engine: Engine, id: string, yaml: string): void {
  writeFileSync(join(engine.jobsDir, `${id}.yaml`), yaml, "utf8");
}

export function jobFile(engine: Engine, id: string): string {
  const path = join(engine.jobsDir, `${id}.yaml`);
  if (!existsSync(path)) throw new Error(`job file missing: ${path}`);
  return readFileSync(path, "utf8");
}

export function jobFileExists(engine: Engine, id: string): boolean {
  return existsSync(join(engine.jobsDir, `${id}.yaml`));
}

