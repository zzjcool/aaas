import type { ApiErrorBody } from "./types.ts";

/**
 * Thrown for every non-2xx response. `details` carries validator paths
 * (`"id"`, `"prompt"`, `"trigger"`, …) so forms can attach messages to fields.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly details: { path: string; message: string }[];

  constructor(status: number, body: ApiErrorBody) {
    super(body.error);
    this.name = "ApiError";
    this.status = status;
    this.details = body.details ?? [];
  }

  /** Messages whose `path` matches the given field, or starts with `path.`. */
  detailsFor(path: string): string[] {
    return this.details
      .filter((d) => d.path === path || d.path.startsWith(`${path}.`))
      .map((d) => d.message);
  }

  /** Details that no field claimed — rendered at the top of a form. */
  unclaimedPaths(claimed: readonly string[]): { path: string; message: string }[] {
    return this.details.filter(
      (d) => !claimed.some((c) => d.path === c || d.path.startsWith(`${c}.`)),
    );
  }
}

/** Type guard used by callers that only have `unknown` (e.g. catch blocks). */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function readErrorBody(res: Response): Promise<ApiErrorBody> {
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const body = parsed as { error: unknown; details?: unknown };
      const details = Array.isArray(body.details)
        ? body.details.flatMap((d) => {
            if (typeof d !== "object" || d === null) return [];
            const entry = d as { path?: unknown; message?: unknown };
            return [
              {
                path: typeof entry.path === "string" ? entry.path : "",
                message: typeof entry.message === "string" ? entry.message : String(entry.message ?? ""),
              },
            ];
          })
        : undefined;
      return {
        error: typeof body.error === "string" ? body.error : res.statusText || "request failed",
        ...(details ? { details } : {}),
      };
    }
  } catch {
    /* non-JSON error body */
  }
  return { error: res.statusText || `request failed (${res.status})` };
}

/**
 * The one HTTP entry point. Adds JSON headers, unwraps JSON, and normalises
 * every failure into `ApiError`.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("accept", "application/json");

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (err) {
    throw new ApiError(0, { error: err instanceof Error ? err.message : "network error" });
  }

  if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (text.length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, { error: "invalid JSON in response" });
  }
}

/** Convenience wrappers; the bodies mirror contract §5 exactly. */
export const http = {
  get: <T>(path: string): Promise<T> => api<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    api<T>(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  put: <T>(path: string, body: unknown): Promise<T> =>
    api<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: (path: string): Promise<void> => api<void>(path, { method: "DELETE" }),
};
