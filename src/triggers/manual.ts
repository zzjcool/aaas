import type { ManualTriggerConfig, PluginDescriptor, TriggerPlugin } from "../shared/types.ts";

/**
 * Manual trigger: never fires on its own, only through `POST /api/jobs/:id/run`.
 * Kept as a real plugin so the scheduler's "no nextFire → dormant" path is
 * exercised by production code rather than only by tests.
 */
export const manualTrigger: TriggerPlugin<ManualTriggerConfig> = {
  type: "manual",
  descriptor: {
    type: "manual",
    displayName: "Manual only",
    description: "Runs only when started from the UI or API.",
    fields: [],
  } satisfies PluginDescriptor,

  validate(raw: unknown) {
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    if (record.type !== undefined && record.type !== "manual") {
      return { ok: false, errors: [`expected type "manual", got "${String(record.type)}"`] };
    }
    return { ok: true, config: { type: "manual" } };
  },

  describe(): string {
    return "Manual only";
  },

  nextFire(): number | null {
    return null;
  },
};
