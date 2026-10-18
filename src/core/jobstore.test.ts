import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore, validateJobSpec, withDefaults, JOB_ID_RE } from "./jobstore.ts";
import type { JobSpec } from "../shared/types.ts";

const TZ = "Asia/Shanghai";

function makeStore(dir: string): JobStore {
  return new JobStore({
    dir,
    validateTrigger: (raw) => {
      const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
      if (record.type !== "cron" && record.type !== "manual") {
        return { ok: false, errors: [`unknown trigger type: ${String(record.type)}`] };
      }
      if (record.type === "cron" && typeof record.cron !== "string" && typeof record.every !== "string") {
        return { ok: false, errors: ["cron or every is required"] };
      }
      return { ok: true };
    },
    validateAgent: (raw) => {
      const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
      if (record.type !== "pi") return { ok: false, errors: [`unknown agent type: ${String(record.type)}`] };
      if (typeof record.cwd !== "string") return { ok: false, errors: ["cwd is required"] };
      return { ok: true };
    },
    describeTrigger: (raw) => {
      const record = raw as Record<string, unknown>;
      return record.type === "cron" ? `Cron: ${String(record.cron ?? record.every)}` : "Manual only";
    },
  });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trigger-jobs-"));
}

const validSpec = (overrides: Partial<JobSpec> = {}): JobSpec => ({
  id: "demo",
  name: "Demo",
  enabled: true,
  trigger: { type: "cron", cron: "0 9 * * *", timezone: TZ },
  agent: { type: "pi", cwd: "/tmp" },
  prompt: "hello",
  timeoutMs: 60_000,
  retries: 0,
  retryBackoffMs: 1000,
  allowOverlap: false,
  ...overrides,
});

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

test("job id must be a lowercase slug", () => {
  assert.ok(JOB_ID_RE.test("nightly-report"));
  assert.ok(!JOB_ID_RE.test("Nightly Report"));
  assert.ok(!JOB_ID_RE.test("-leading"));
  assert.ok(!JOB_ID_RE.test(""));
  assert.ok(!JOB_ID_RE.test("a".repeat(65)));
});

test("validateJobSpec applies defaults", () => {
  const result = validateJobSpec({
    id: "x",
    trigger: { type: "manual" },
    agent: { type: "pi", cwd: "/tmp" },
    prompt: "p",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.spec.enabled, true);
  assert.equal(result.spec.name, "x");
  assert.equal(result.spec.timeoutMs, 1_800_000);
  assert.equal(result.spec.retries, 1);
  assert.equal(result.spec.retryBackoffMs, 30_000);
  assert.equal(result.spec.allowOverlap, false);
});

test("validateJobSpec rejects unknown top-level keys", () => {
  const result = validateJobSpec({
    id: "x",
    trigger: { type: "manual" },
    agent: { type: "pi", cwd: "/tmp" },
    prompt: "p",
    unexpected: true,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((i) => i.path === "unexpected"));
});

test("validateJobSpec reports missing prompt and bad numeric fields", () => {
  const noPrompt = validateJobSpec({ id: "x", trigger: { type: "manual" }, agent: { type: "pi", cwd: "/tmp" }, prompt: "" });
  assert.equal(noPrompt.ok, false);
  if (!noPrompt.ok) assert.ok(noPrompt.issues.some((i) => i.path === "prompt"));

  const badTimeout = validateJobSpec({
    id: "x",
    trigger: { type: "manual" },
    agent: { type: "pi", cwd: "/tmp" },
    prompt: "p",
    timeoutMs: -1,
  });
  assert.equal(badTimeout.ok, false);
});

test("withDefaults keeps explicit values", () => {
  const spec = withDefaults(validSpec({ retries: 5, enabled: false }));
  assert.equal(spec.retries, 5);
  assert.equal(spec.enabled, false);
});

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

test("store writes readable YAML with a stable key order", () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    const path = store.save(validSpec());
    const text = readFileSync(path, "utf8");
    assert.match(text, /^id: demo/m);
    assert.ok(text.indexOf("id:") < text.indexOf("trigger:"));
    assert.ok(text.indexOf("trigger:") < text.indexOf("agent:"));
    assert.ok(text.indexOf("agent:") < text.indexOf("prompt:"));
    assert.match(path, /demo\.yaml$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store round-trips a saved job", () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    store.save(validSpec({ tags: ["nightly"], description: "desc" }));
    const { jobs, errors } = store.load();
    assert.deepEqual(errors, []);
    assert.equal(jobs.length, 1);
    const loaded = jobs[0];
    assert.ok(loaded);
    assert.equal(loaded.problem, null);
    assert.equal(loaded.spec.description, "desc");
    assert.deepEqual(loaded.spec.tags, ["nightly"]);
    assert.equal(loaded.scheduleText, "Cron: 0 9 * * *");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store tolerates .yml and infers id from the file name", () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    writeFileSync(
      join(dir, "from-filename.yml"),
      `trigger:\n  type: manual\nagent:\n  type: pi\n  cwd: /tmp\nprompt: hi\n`,
      "utf8",
    );
    const { jobs } = store.load();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.spec.id, "from-filename");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store flags parse errors and invalid plugin configs without throwing", () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    writeFileSync(join(dir, "broken.yaml"), "id: broken\nprompt: [oops\n", "utf8");
    writeFileSync(join(dir, "empty.yaml"), "", "utf8");
    writeFileSync(
      join(dir, "bad-trigger.yaml"),
      `id: bad-trigger\ntrigger:\n  type: ghost\nagent:\n  type: pi\n  cwd: /tmp\nprompt: hi\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "bad-agent.yaml"),
      `id: bad-agent\ntrigger:\n  type: manual\nagent:\n  type: ghost\nprompt: hi\n`,
      "utf8",
    );

    const { jobs, errors } = store.load();
    const byId = new Map(jobs.map((j) => [j.spec.id, j]));
    assert.ok(byId.get("bad-trigger")?.problem?.includes("unknown trigger type"));
    assert.ok(byId.get("bad-agent")?.problem?.includes("unknown agent type"));
    assert.equal(errors.length, 2, `expected 2 file-level errors, got ${JSON.stringify(errors)}`);
    assert.ok(errors.some((e) => e.problem.includes("YAML parse error")));
    assert.ok(errors.some((e) => e.problem.includes("empty")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store delete removes both extensions", () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    store.save(validSpec({ id: "gone" }));
    assert.equal(store.delete("gone"), true);
    assert.equal(store.delete("gone"), false);
    assert.equal(store.load().jobs.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save overwrites an existing job idempotently", () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    store.save(validSpec({ prompt: "one" }));
    store.save(validSpec({ prompt: "two" }));
    const { jobs } = store.load();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.spec.prompt, "two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
