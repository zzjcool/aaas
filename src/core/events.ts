import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { SseEvent } from "../shared/types.ts";

export type LogStream = "stdout" | "stderr" | "event" | "system";

export interface LogLine {
  at: number;
  stream: LogStream;
  line: string;
}

/**
 * Append-only JSONL transcript per run, in `data/runs/<runId>.jsonl`.
 * Also fans every line out to in-process subscribers (SSE).
 */
export class LogStore {
  readonly #dir: string;
  /** Open file descriptors, written synchronously so a crash never loses lines. */
  readonly #fds = new Map<string, number>();

  constructor(dir: string) {
    this.#dir = join(dir, "runs");
    mkdirSync(this.#dir, { recursive: true });
  }

  pathFor(runId: string): string {
    return join(this.#dir, `${runId}.jsonl`);
  }

  open(runId: string): void {
    if (this.#fds.has(runId)) return;
    try {
      this.#fds.set(runId, openSync(this.pathFor(runId), "a"));
    } catch {
      /* keep the run alive even if the FS complains */
    }
  }

  write(runId: string, streamName: LogStream, line: string, at = Date.now()): void {
    const record: LogLine = { at, stream: streamName, line };
    const payload = JSON.stringify(record) + "\n";
    const fd = this.#fds.get(runId);
    if (fd === undefined) {
      // The run may not have been opened explicitly (e.g. a skipped run).
      try {
        appendFileSync(this.pathFor(runId), payload);
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      writeSync(fd, payload);
    } catch {
      /* ignore */
    }
  }

  close(runId: string): void {
    const fd = this.#fds.get(runId);
    if (fd === undefined) return;
    this.#fds.delete(runId);
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  closeAll(): void {
    for (const id of [...this.#fds.keys()]) this.close(id);
  }

  /** Read the tail of a transcript; safe on missing files. */
  tail(runId: string, limit = 500): LogLine[] {
    const path = this.pathFor(runId);
    if (!existsSync(path)) return [];
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const slice = lines.slice(Math.max(0, lines.length - limit));
    const out: LogLine[] = [];
    for (const l of slice) {
      try {
        out.push(JSON.parse(l) as LogLine);
      } catch {
        /* skip torn line */
      }
    }
    return out;
  }

  appendRaw(runId: string, line: string): void {
    try {
      appendFileSync(this.pathFor(runId), line);
    } catch {
      /* ignore */
    }
  }
}

type Listener = (event: SseEvent) => void;

/** In-process event fan-out used by both `/api/events` and `/api/runs/:id/stream`. */
export class EventBus {
  readonly #listeners = new Set<Listener>();
  readonly #history = new Map<string, LogLine[]>();
  readonly #historyLimit = 2000;

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  publish(event: SseEvent): void {
    if (event.type === "log") {
      const buf = this.#history.get(event.runId) ?? [];
      buf.push({ at: event.at, stream: event.stream as LogStream, line: event.line });
      if (buf.length > this.#historyLimit) buf.splice(0, buf.length - this.#historyLimit);
      this.#history.set(event.runId, buf);
    }
    for (const fn of this.#listeners) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must not stall the engine */
      }
    }
  }

  history(runId: string): LogLine[] {
    return [...(this.#history.get(runId) ?? [])];
  }

  clearHistory(runId: string): void {
    this.#history.delete(runId);
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }
}
