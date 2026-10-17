import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Minimal JSONL RPC client for `pi --mode rpc`.
 *
 * Deliberately dependency-free (no import of `@earendil-works/pi-coding-agent`):
 * the adapter only needs a subprocess, a line splitter and an id → pending map.
 *
 * Protocol facts this file encodes (see ./README.md for the full list):
 *  - stdin: one JSON command per line, terminated with a bare LF.
 *  - stdout: one JSON record per line. Split on `\n` ONLY — Node's `readline`
 *    also splits on U+2028 / U+2029, which are legal *inside* JSON strings.
 *  - commands may carry an `id`; the matching response echoes it.
 *  - stdout must be drained continuously or pi stalls on backpressure.
 */

export interface RpcResponse {
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  id?: string;
}

/** Any protocol record. `type` discriminates; everything else is passthrough. */
export type RpcRecord = { type: string; [key: string]: any };

export type RpcRecordListener = (record: RpcRecord) => void;
export type StderrListener = (line: string) => void;
export type ExitListener = (info: ExitInfo) => void;

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface PiRpcProcessOptions {
  /** Executable, e.g. `pi` or an absolute path. */
  bin: string;
  /** Arguments, e.g. `["--mode", "rpc", "--no-session"]`. */
  args: string[];
  /** Working directory for the child (pi has no `--cwd` flag). */
  cwd: string;
  /** Full environment for the child (nothing is inherited implicitly). */
  env: Record<string, string | undefined>;
}

/** A single record longer than this is discarded instead of buffered. */
const MAX_LINE_BYTES = 1024 * 1024;
/** After this much stdout we stop forwarding records (but keep draining). */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** `abort` only answers once the session is idle; don't wait forever. */
const ABORT_TIMEOUT_MS = 800;
const STDIN_CLOSE_GRACE_MS = 1_200;
const SIGTERM_GRACE_MS = 800;
const SIGKILL_GRACE_MS = 300;

interface Pending {
  command: string;
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class PiRpcProcess {
  readonly #opts: PiRpcProcessOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #started = false;
  #exited = false;
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;
  #closePromise: Promise<number | null> | null = null;
  #stdoutBuf = "";
  #stderrBuf = "";
  #discardingLine = false;
  #streamBytes = 0;
  #truncated = false;
  #seq = 0;
  readonly #pending = new Map<string, Pending>();
  readonly #recordListeners = new Set<RpcRecordListener>();
  readonly #stderrListeners = new Set<StderrListener>();
  readonly #exitListeners = new Set<ExitListener>();
  readonly #waiters = new Set<() => void>();

  constructor(opts: PiRpcProcessOptions) {
    this.#opts = opts;
  }

  get exited(): boolean {
    return this.#exited;
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get exitSignal(): NodeJS.Signals | null {
    return this.#exitSignal;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** Spawn the child and resolve once the process is live. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#opts.bin, this.#opts.args, {
        cwd: this.#opts.cwd,
        env: this.#opts.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.#markExited(null, null);
      throw this.#spawnError(err);
    }
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      child.on("spawn", () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      child.on("error", (err) => {
        const error = this.#spawnError(err);
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.#failAllPending(error);
        this.#markExited(null, null);
      });

      child.on("close", (code, signal) => {
        this.#markExited(code, signal);
        if (!settled) {
          // Died before `spawn` was observed — surface it as a startup failure.
          settled = true;
          reject(new Error(`pi process exited before startup completed (code ${code}, signal ${signal})`));
        }
      });

      child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
      child.stderr.on("data", (chunk: string) => this.#onStderr(chunk));
      // Ignore EPIPE when the child dies mid-write; exit handling reports it.
      child.stdin.on("error", () => {});
    });
  }

  /** Send a command and await its correlated response. */
  command(type: string, payload: Record<string, unknown> = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<RpcResponse> {
    if (this.#exited || !this.#child) {
      return Promise.reject(new Error(`pi process is not running (command: ${type})`));
    }
    const id = `aaas-${++this.#seq}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`pi command timed out after ${timeoutMs}ms: ${type}`));
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      this.#pending.set(id, { command: type, resolve, reject, timer });
      try {
        this.send({ ...payload, type, id });
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  onRecord(cb: RpcRecordListener): () => void {
    this.#recordListeners.add(cb);
    return () => this.#recordListeners.delete(cb);
  }

  onStderr(cb: StderrListener): () => void {
    this.#stderrListeners.add(cb);
    return () => this.#stderrListeners.delete(cb);
  }

  onExit(cb: ExitListener): () => void {
    this.#exitListeners.add(cb);
    return () => this.#exitListeners.delete(cb);
  }

  /** Raw record write, used for `extension_ui_response`. Never throws. */
  send(record: Record<string, unknown>): void {
    const stdin = this.#child?.stdin;
    if (!stdin || this.#exited || stdin.destroyed || stdin.writableEnded) return;
    try {
      stdin.write(`${JSON.stringify(record)}\n`);
    } catch {
      /* child went away between the checks and the write */
    }
  }

  /**
   * Orderly shutdown: close stdin (pi disposes the session and exits 0), then
   * escalate to SIGTERM and finally SIGKILL. Never SIGINT — pi leaves orphaned
   * grandchildren behind on SIGINT.
   */
  close(): Promise<number | null> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<number | null> {
    const child = this.#child;
    if (!child) return null;
    if (this.#exited) return this.#exitCode;

    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    if (await this.#waitExit(STDIN_CLOSE_GRACE_MS)) return this.#exitCode;

    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    if (await this.#waitExit(SIGTERM_GRACE_MS)) return this.#exitCode;

    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await this.#waitExit(SIGKILL_GRACE_MS);
    return this.#exitCode;
  }

  /** Best-effort `abort` command, then orderly close (with SIGTERM/SIGKILL fallback). */
  async abortAndClose(): Promise<void> {
    if (!this.#exited && this.#child) {
      try {
        await this.command("abort", {}, ABORT_TIMEOUT_MS);
      } catch {
        /* unresponsive child: fall through to close() */
      }
    }
    await this.close();
  }

  /* ---------------------------------------------------------------- */

  #waitExit(timeoutMs: number): Promise<boolean> {
    if (this.#exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(done);
        resolve(false);
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      this.#waiters.add(done);
    });
  }

  #markExited(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#exitCode = code;
    this.#exitSignal = signal;
    const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
    this.#failAllPending(new Error(`pi process exited (${detail})`));
    for (const waiter of [...this.#waiters]) waiter();
    this.#waiters.clear();
    for (const cb of [...this.#exitListeners]) {
      try {
        cb({ code, signal });
      } catch {
        /* listener bugs must not break teardown */
      }
    }
  }

  #failAllPending(error: Error): void {
    for (const [id, pending] of [...this.#pending]) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #spawnError(err: unknown): Error {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return new Error(`pi executable not found: ${this.#opts.bin}`);
    return err instanceof Error ? err : new Error(String(err));
  }

  #onStdout(chunk: string): void {
    this.#streamBytes += Buffer.byteLength(chunk);
    if (this.#streamBytes > MAX_STREAM_BYTES && !this.#truncated) {
      this.#truncated = true;
      this.#emitStderr(`[aaas] stdout exceeded ${MAX_STREAM_BYTES} bytes; further records are dropped (still draining)`);
    }
    this.#stdoutBuf += chunk;
    // LF-only framing. Never `readline`: it also splits on U+2028/U+2029.
    for (;;) {
      const idx = this.#stdoutBuf.indexOf("\n");
      if (idx < 0) break;
      const line = this.#stdoutBuf.slice(0, idx);
      this.#stdoutBuf = this.#stdoutBuf.slice(idx + 1);
      if (this.#discardingLine) {
        this.#discardingLine = false;
        continue;
      }
      this.#handleLine(line);
    }
    if (this.#stdoutBuf.length > MAX_LINE_BYTES) {
      // Bound memory: drop the oversized partial record and resync on the next LF.
      this.#discardingLine = true;
      this.#stdoutBuf = "";
      this.#emitStderr(`[aaas] dropped a stdout record longer than ${MAX_LINE_BYTES} bytes`);
    }
  }

  #onStderr(chunk: string): void {
    this.#stderrBuf += chunk;
    for (;;) {
      const idx = this.#stderrBuf.indexOf("\n");
      if (idx < 0) break;
      const line = this.#stderrBuf.slice(0, idx).replace(/\r$/, "");
      this.#stderrBuf = this.#stderrBuf.slice(idx + 1);
      this.#emitStderr(line);
    }
    if (this.#stderrBuf.length > MAX_LINE_BYTES) {
      this.#emitStderr(this.#stderrBuf.slice(0, 4096));
      this.#stderrBuf = "";
    }
  }

  #emitStderr(line: string): void {
    for (const cb of [...this.#stderrListeners]) {
      try {
        cb(line);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  #handleLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) return;
    if (this.#truncated) return;

    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch {
      this.#emitStderr(`[aaas] non-JSON stdout line ignored: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof record !== "object" || record === null) return;

    if (record.type === "response") {
      this.#settleResponse(record);
    }

    for (const cb of [...this.#recordListeners]) {
      try {
        cb(record);
      } catch {
        /* one bad listener must not kill the reader */
      }
    }
  }

  #settleResponse(record: RpcRecord): void {
    const id = typeof record.id === "string" ? record.id : null;
    let pending: Pending | undefined;
    let key: string | null = null;
    if (id) {
      pending = this.#pending.get(id);
      key = id;
    } else {
      // Response without an id: correlate by command name, oldest first.
      for (const [candidateKey, candidate] of this.#pending) {
        if (candidate.command === record.command) {
          pending = candidate;
          key = candidateKey;
          break;
        }
      }
    }
    if (!pending || !key) return;
    clearTimeout(pending.timer);
    this.#pending.delete(key);
    pending.resolve({
      type: "response",
      command: typeof record.command === "string" ? record.command : "",
      success: record.success === true,
      ...(record.data !== undefined ? { data: record.data } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      ...(id ? { id } : {}),
    });
  }
}
