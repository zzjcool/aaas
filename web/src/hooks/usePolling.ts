import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  /** True only for the very first load (no data yet) — drives skeletons. */
  loading: boolean;
  /** True while a refresh is in flight (including background refreshes). */
  refreshing: boolean;
  /** Force a refresh now; returns the fresh value when it resolves. */
  refresh: () => Promise<T | null>;
  /** Replace the local snapshot without a round-trip (optimistic updates). */
  mutate: (updater: T | ((prev: T | null) => T | null)) => void;
}

export interface PollingOptions {
  /** Milliseconds between refreshes; `0` disables the timer. */
  intervalMs?: number;
  /** Skip polling entirely (e.g. while the panel is closed). */
  enabled?: boolean;
}

export interface PollingResult<T> extends PollingState<T> {
  /** The dependency tuple this snapshot was produced for (diagnostics/tests). */
  revision: number;
}

/**
 * Polling primitive: one `fetch` per tick, no state writes after unmount.
 *
 * Staleness rule: every call takes a monotonically increasing token and only
 * the newest token may write state. That means a dependency change (new filter,
 * new run id) always wins over an older in-flight response, instead of being
 * dropped or overwritten by it.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  options: PollingOptions = {},
): PollingResult<T> {
  const { intervalMs = 0, enabled = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Latest fetcher without making identity a dependency-churn source.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const mountedRef = useRef(true);
  const tokenRef = useRef(0);
  const pendingRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (): Promise<T | null> => {
    const token = ++tokenRef.current;
    pendingRef.current += 1;
    setRefreshing(true);
    try {
      const value = await fetcherRef.current();
      if (mountedRef.current && token === tokenRef.current) {
        setData(value);
        setError(null);
      }
      return value;
    } catch (err) {
      if (mountedRef.current && token === tokenRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
      return null;
    } finally {
      pendingRef.current = Math.max(0, pendingRef.current - 1);
      if (mountedRef.current) {
        if (pendingRef.current === 0) setRefreshing(false);
        if (token === tokenRef.current) setLoading(false);
      }
    }
  }, []);

  // Re-fetch whenever the caller's dependency tuple changes. `deps` is the
  // dependency array by design (same contract as useEffect).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLoading(true);
    void run();
  }, deps);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void run();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, run]);

  // Catch up immediately when the tab becomes visible again.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, run]);

  const mutate = useCallback((updater: T | ((prev: T | null) => T | null)): void => {
    setData((prev) => (typeof updater === "function" ? (updater as (p: T | null) => T | null)(prev) : updater));
  }, []);

  return { data, error, loading, refreshing, refresh: run, mutate, revision: tokenRef.current };
}

/**
 * A ticking clock for relative timestamps. One interval per mount; `enabled`
 * lets a page pause it while nothing is visible.
 */
export function useNow(intervalMs = 10_000, enabled = true): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!enabled || intervalMs <= 0) {
      setNow(Date.now());
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);

  return now;
}

/** Debounce a value; used by the schedule preview (400 ms). */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value);
      return;
    }
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
