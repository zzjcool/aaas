/**
 * Parsing/serialising for the visual cron builder.
 *
 * The builder is a *view* over the cron string: it always produces a plain
 * string that the plugin validates server-side, never a private format. That
 * keeps the wire contract unchanged and means the builder degrades gracefully —
 * anything it cannot represent is edited as raw text.
 *
 * Supported subset (deliberately the part people actually use):
 *   minutes  `*`, `*\/n`, single minute
 *   hours    `*`, `*\/n`, single hour, comma list in ascending order
 *   days     `*`, single 1-31
 *   months   `*`, single 1-12
 *   weekdays `*`, single 0-7, `1-5`
 *
 * Anything else (ranges in minutes, steps elsewhere, multiple minutes, L/W/#,
 * six-field expressions with seconds) parses as `null`, and the editor falls
 * back to raw text so nothing is ever lost.
 */

/** `weekday: 1` = Monday … 7 = Sunday (7 is used for "every Sunday"). */
export type DayMode = "daily" | "weekdays" | "weekends" | "specific" | "custom";

export interface CronModel {
  everyMinute: boolean;
  /** Minute row: `*\/n` when `minuteStep` > 1, otherwise explicit minutes. */
  minuteMode: "every" | "step" | "at";
  minuteStep: number;
  minute: number;
  /** Hour row: `*\/n` or explicit hours. */
  hourMode: "every" | "step" | "at";
  hourStep: number;
  hours: number[];
  dayOfMonth: number | null;
  month: number | null;
  dayMode: DayMode;
  weekday: number | null;
  /** Set when the expression uses a shape the builder cannot model. */
  unsupported: boolean;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export { MONTH_LABELS, WEEKDAY_LABELS };

/** A fresh model: every day at 09:00 — a sensible, non-noisy default. */
export function defaultModel(): CronModel {
  return {
    everyMinute: false,
    minuteMode: "at",
    minuteStep: 15,
    minute: 0,
    hourMode: "at",
    hourStep: 6,
    hours: [9],
    dayOfMonth: null,
    month: null,
    dayMode: "daily",
    weekday: null,
    unsupported: false,
  };
}

/* ------------------------------------------------------------------ */
/* parse                                                              */
/* ------------------------------------------------------------------ */

interface Step {
  step: number;
}

function parseStep(field: string): Step | null {
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match?.[1]) return null;
  const step = Number.parseInt(match[1], 10);
  return Number.isFinite(step) && step > 0 ? { step } : null;
}

function intInRange(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number.parseInt(field, 10);
  return value >= min && value <= max ? value : null;
}

function intList(field: string, min: number, max: number): number[] | null {
  const parts = field.split(",");
  const values: number[] = [];
  for (const part of parts) {
    const value = intInRange(part, min, max);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

function weekdayToMode(field: string): { mode: DayMode; weekday: number | null } | null {
  if (field === "*") return { mode: "daily", weekday: null };
  if (field === "1-5") return { mode: "weekdays", weekday: null };
  if (field === "0,6" || field === "6,0") return { mode: "weekends", weekday: null };
  const single = intInRange(field, 0, 7);
  if (single === null) return null;
  // Normalise Sunday: 0 and 7 mean the same day; serialise as 7 for stability.
  return { mode: "specific", weekday: single === 0 ? 7 : single };
}

/**
 * Parse a cron string into a builder model, or `null` when it uses a shape the
 * builder cannot faithfully represent. Callers must fall back to raw editing.
 */
export function parseCron(expr: string): CronModel | null {
  const trimmed = expr.trim();
  if (trimmed === "" || trimmed.startsWith("@")) return null;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return null;

  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const model = defaultModel();
  model.unsupported = false;

  /* ---- minute ---- */
  if (minuteField === "*") {
    model.minuteMode = "every";
    model.everyMinute = true;
  } else {
    const step = parseStep(minuteField);
    if (step) {
      if (step.step < 1 || step.step > 59) return null;
      model.minuteMode = "step";
      model.minuteStep = step.step;
    } else {
      const single = intInRange(minuteField, 0, 59);
      if (single === null) return null;
      model.minuteMode = "at";
      model.minute = single;
    }
  }

  /* ---- hour ---- */
  if (hourField === "*") {
    model.hourMode = "every";
    // `* * * * *` is "every minute"; hour `*` alone is a legal shape too.
    model.everyMinute = model.minuteMode === "every";
  } else {
    const step = parseStep(hourField);
    if (step) {
      if (step.step < 1 || step.step > 23) return null;
      model.hourMode = "step";
      model.hourStep = step.step;
    } else {
      const list = intList(hourField, 0, 23);
      if (list === null || list.length === 0) return null;
      // Reject unsorted/duplicate lists: we always serialise ascending, so a
      // round-trip would otherwise silently rewrite the user's expression.
      const ascending = list.every((value, index) => index === 0 || value > (list[index - 1] as number));
      if (!ascending) return null;
      model.hourMode = "at";
      model.hours = list;
    }
  }

  if (model.minuteMode === "every" && model.hourMode !== "every") {
    // `* *\/2 * * *` — every minute within certain hours. Modellable, but the
    // UI has no affordance for it; send it to raw mode instead of pretending.
    return null;
  }

  /* ---- day of month / month ---- */
  if (domField !== "*") {
    const dom = intInRange(domField, 1, 31);
    if (dom === null) return null;
    model.dayOfMonth = dom;
  }
  if (monthField !== "*") {
    const month = intInRange(monthField, 1, 12);
    if (month === null) return null;
    model.month = month;
  }

  /* ---- weekday ---- */
  const weekday = weekdayToMode(dowField);
  if (weekday === null) return null;
  model.dayMode = weekday.mode;
  model.weekday = weekday.weekday;

  return model;
}

/* ------------------------------------------------------------------ */
/* serialise                                                          */
/* ------------------------------------------------------------------ */

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Render the model back to a 5-field cron expression. */
export function serializeCron(model: CronModel): string {
  let minuteField: string;
  if (model.everyMinute) {
    minuteField = "*";
  } else if (model.minuteMode === "every") {
    minuteField = "*";
  } else if (model.minuteMode === "step") {
    minuteField = `*/${model.minuteStep}`;
  } else {
    minuteField = String(model.minute);
  }

  let hourField: string;
  if (model.hourMode === "every") {
    hourField = "*";
  } else if (model.hourMode === "step") {
    hourField = `*/${model.hourStep}`;
  } else {
    const hours = [...model.hours].sort((a, b) => a - b);
    hourField = hours.length === 0 ? "*" : hours.join(",");
  }

  const domField = model.dayOfMonth === null ? "*" : String(model.dayOfMonth);
  const monthField = model.month === null ? "*" : String(model.month);

  let dowField: string;
  switch (model.dayMode) {
    case "weekdays":
      dowField = "1-5";
      break;
    case "weekends":
      dowField = "0,6";
      break;
    case "specific":
      dowField = model.weekday === null ? "*" : String(model.weekday);
      break;
    case "custom":
    case "daily":
    default:
      dowField = "*";
      break;
  }

  return [minuteField, hourField, domField, monthField, dowField].join(" ");
}

/* ------------------------------------------------------------------ */
/* human summary                                                      */
/* ------------------------------------------------------------------ */

/**
 * A plain-language summary rendered client-side so the editor can explain the
 * schedule before the (debounced) server round-trip returns. The server's
 * `scheduleText` remains the authority once it arrives.
 */
export function describeModel(model: CronModel): string {
  const when = describeTime(model);
  const day = describeDay(model);
  if (model.everyMinute) return model.dayOfMonth === null ? `Every minute, ${day}` : `Every minute on ${day.toLowerCase()}`;
  if (when === null) return "Every minute";
  return `${when} ${day}`.trim();
}

function describeTime(model: CronModel): string | null {
  if (model.minuteMode === "every" || model.everyMinute) return null;
  const minutePart = model.minuteMode === "step" ? `every ${model.minuteStep} minutes` : `at minute ${pad2(model.minute)}`;

  if (model.hourMode === "every") {
    return model.minuteMode === "step" ? `Every ${model.minuteStep} minutes` : `Every hour at :${pad2(model.minute)}`;
  }
  if (model.hourMode === "step") {
    return model.minuteMode === "step"
      ? `Every ${model.minuteStep} minutes, every ${model.hourStep} hours`
      : `At :${pad2(model.minute)} every ${model.hourStep} hours`;
  }
  const hours = [...model.hours].sort((a, b) => a - b);
  if (hours.length === 0) return null;
  if (hours.length === 1) {
    return `At ${pad2(hours[0] as number)}:${pad2(model.minute)}`;
  }
  return `At ${hours.map((hour) => `${pad2(hour)}:${pad2(model.minute)}`).join(", ")}`;
}

function describeDay(model: CronModel): string {
  const parts: string[] = [];
  if (model.dayMode === "weekdays") parts.push("on weekdays");
  else if (model.dayMode === "weekends") parts.push("on weekends");
  else if (model.dayMode === "specific" && model.weekday !== null) {
    parts.push(`on ${model.weekday === 7 ? "Sunday" : (WEEKDAY_LABELS[model.weekday as number] ?? "?")}`);
  }

  if (model.month !== null) {
    const monthName = MONTH_LABELS[model.month - 1] ?? `month ${model.month}`;
    if (model.dayOfMonth !== null) parts.push(`on ${monthName} ${model.dayOfMonth}`);
    else parts.push(`in ${monthName}`);
  } else if (model.dayOfMonth !== null) {
    parts.push(`on day ${model.dayOfMonth} of the month`);
  }

  return parts.length === 0 ? "every day" : parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* presets                                                            */
/* ------------------------------------------------------------------ */

export interface CronPreset {
  id: string;
  label: string;
  hint: string;
  /** Builds the model, or returns a raw expression for shapes we do not model. */
  apply: () => CronModel | string;
}

export const PRESETS: CronPreset[] = [
  {
    id: "every-15m",
    label: "Every 15 minutes",
    hint: "*/15 * * * *",
    apply: () => ({ ...defaultModel(), minuteMode: "step", minuteStep: 15, hourMode: "every" }),
  },
  {
    id: "hourly",
    label: "Every hour",
    hint: "0 * * * *",
    apply: () => ({ ...defaultModel(), minuteMode: "at", minute: 0, hourMode: "every" }),
  },
  {
    id: "daily-9",
    label: "Every day at 09:00",
    hint: "0 9 * * *",
    apply: () => defaultModel(),
  },
  {
    id: "weekdays-9",
    label: "Weekdays at 09:00",
    hint: "0 9 * * 1-5",
    apply: () => ({ ...defaultModel(), dayMode: "weekdays" }),
  },
  {
    id: "weekdays-9-18",
    label: "Weekdays at 09:00 and 18:00",
    hint: "0 9,18 * * 1-5",
    apply: () => ({ ...defaultModel(), hours: [9, 18], dayMode: "weekdays" }),
  },
  {
    id: "monday-9",
    label: "Every Monday at 09:00",
    hint: "0 9 * * 1",
    apply: () => ({ ...defaultModel(), dayMode: "specific", weekday: 1 }),
  },
  {
    id: "monthly-1",
    label: "1st of every month at 03:00",
    hint: "0 3 1 * *",
    apply: () => ({ ...defaultModel(), hours: [3], dayOfMonth: 1 }),
  },
  {
    id: "nightly-2",
    label: "Every night at 02:00",
    hint: "0 2 * * *",
    apply: () => ({ ...defaultModel(), hours: [2] }),
  },
];
