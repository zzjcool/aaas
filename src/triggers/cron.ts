import type { CronTriggerConfig, PluginDescriptor, TriggerPlugin } from "../shared/types.ts";
import { describeSchedule, nextFire, normalizeSchedule, type NormalizedSchedule } from "../core/schedule.ts";

export interface CronTriggerOptions {
  defaultTimezone: string;
}

/**
 * Time-based trigger: cron expressions and simple intervals.
 *
 * This plugin only answers "when is the next fire?" — the Scheduler owns the
 * clock, overlap policy and retries, so this stays a pure function and is
 * trivially unit-testable.
 */
export function createCronTrigger(options: CronTriggerOptions, cache = new Map<string, NormalizedSchedule>()): TriggerPlugin<CronTriggerConfig> {
  const descriptor: PluginDescriptor = {
    type: "cron",
    displayName: "Schedule (cron / interval)",
    description: "Fires on a cron expression or a fixed interval. Times are evaluated in the job's timezone.",
    fields: [
      {
        key: "cron",
        label: "Cron expression",
        type: "string",
        placeholder: "0 9 * * 1-5",
        help: "5 fields (min hour dom mon dow), 6 fields (sec min hour dom mon dow), or a macro such as @daily.",
      },
      {
        key: "every",
        label: "…or interval",
        type: "string",
        placeholder: "15m",
        help: "Fixed interval: 30s, 15m, 2h, 1d. Mutually exclusive with the cron expression.",
      },
      {
        key: "timezone",
        label: "Timezone",
        type: "string",
        default: options.defaultTimezone,
        help: "IANA timezone used to interpret the cron expression. Stored schedules are always epoch milliseconds.",
      },
    ],
  };

  return {
    type: "cron",
    descriptor,

    validate(raw: unknown) {
      const normalized = normalizeSchedule(raw, options.defaultTimezone);
      if (!normalized.ok) return { ok: false, errors: normalized.errors };
      const config = toConfig(raw, normalized.value);
      cache.set(cacheKey(config), normalized.value);
      return { ok: true, config };
    },

    describe(config: CronTriggerConfig): string {
      const normalized = resolve(config, cache, options.defaultTimezone);
      return normalized ? describeSchedule(normalized) : "invalid schedule";
    },

    nextFire(config: CronTriggerConfig, after: number, lastFire: number | null): number | null {
      const normalized = resolve(config, cache, options.defaultTimezone);
      if (!normalized) return null;
      return nextFire(normalized, after, lastFire);
    },
  };
}

function cacheKey(config: CronTriggerConfig): string {
  return JSON.stringify([config.cron ?? null, config.every ?? null, config.timezone ?? null]);
}

function resolve(
  config: CronTriggerConfig,
  cache: Map<string, NormalizedSchedule>,
  defaultTimezone: string,
): NormalizedSchedule | null {
  const key = cacheKey(config);
  const hit = cache.get(key);
  if (hit) return hit;
  const normalized = normalizeSchedule(config, defaultTimezone);
  if (!normalized.ok) return null;
  cache.set(key, normalized.value);
  return normalized.value;
}

function toConfig(raw: unknown, normalized: NormalizedSchedule): CronTriggerConfig {
  const config: CronTriggerConfig = { type: "cron" };
  if (normalized.kind === "cron" && normalized.expr) config.cron = normalized.expr;
  if (normalized.kind === "interval" && normalized.everyMs) {
    config.every = `${Math.round(normalized.everyMs / 1000)}s`;
  }
  if (normalized.timezone) config.timezone = normalized.timezone;
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (typeof record.every === "string" && normalized.kind === "interval") config.every = record.every;
    if (typeof record.cron === "string" && normalized.kind === "cron") config.cron = record.cron;
  }
  return config;
}
