import { useEffect, useRef, useState } from "react";
import type { SseEvent } from "../types.ts";

export type SseStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface UseSseOptions {
  /** Called for every parsed event that is not a heartbeat. */
  onEvent: (event: SseEvent) => void;
  /** Set false to keep the source closed (e.g. panel closed). */
  enabled?: boolean;
  /** Stop reconnecting after an `end` event arrives from the server. */
  closeOnEnd?: boolean;
}

export interface UseSseResult {
  status: SseStatus;
  /** Close the stream manually (the component also closes on unmount). */
  close: () => void;
}

/**
 * `EventSource` wrapper for `/api/runs/:id/stream` (contract §5).
 *
 * The engine writes `data: <JSON of SseEvent>\n\n` frames plus a `ping` every
 * 15 s; `end` means the run is finished, so we close the source and stop
 * reconnecting. Any other disconnect is retried with a small backoff because
 * `EventSource`'s own retry can hammer a dead dev proxy.
 */
export function useSse(url: string | null, options: UseSseOptions): UseSseResult {
  const { onEvent, enabled = true, closeOnEnd = true } = options;

  const [status, setStatus] = useState<SseStatus>("idle");

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const endedRef = useRef(false);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!url || !enabled) {
      setStatus("idle");
      return;
    }

    endedRef.current = false;
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let disposed = false;
    let attempt = 0;

    const connect = (): void => {
      if (disposed || endedRef.current) return;
      setStatus("connecting");
      source = new EventSource(url);

      source.onopen = () => {
        attempt = 0;
        if (!disposed) setStatus("open");
      };

      source.onmessage = (message: MessageEvent<string>) => {
        const event = parseEvent(message.data);
        if (!event) return;
        if (event.type === "ping") return;
        onEventRef.current(event);
        if (event.type === "end" && closeOnEnd) {
          endedRef.current = true;
          source?.close();
          source = null;
          if (!disposed) setStatus("closed");
        }
      };

      source.onerror = () => {
        if (disposed || endedRef.current) return;
        source?.close();
        source = null;
        setStatus("error");
        // Exponential-ish backoff capped at 10 s.
        attempt += 1;
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    const close = (): void => {
      disposed = true;
      endedRef.current = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      source?.close();
      source = null;
      setStatus("closed");
    };
    closeRef.current = close;

    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      source?.close();
      source = null;
      closeRef.current = null;
    };
  }, [url, enabled, closeOnEnd]);

  return {
    status,
    close: () => {
      closeRef.current?.();
    },
  };
}

function parseEvent(raw: string): SseEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return null;
    const type = (parsed as { type: unknown }).type;
    switch (type) {
      case "log":
      case "run":
      case "job":
      case "ping":
      case "end":
        return parsed as SseEvent;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
