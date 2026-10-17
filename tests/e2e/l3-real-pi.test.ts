/**
 * L3 E2E — the real `pi` binary against a real model endpoint.
 *
 * Runs ONLY when AAAS_E2E_PI=real. Everything here would be a lie with the fake
 * pi, so the suite refuses to run rather than silently passing: a green L3 means
 * aaas really drove `pi --mode rpc` to a real model and stored its answer.
 *
 * Why it exists:
 *   L1/L2 prove the plumbing. They cannot prove that argv, extension loading,
 *   credentials and the provider handshake still line up with the pi release
 *   that is actually installed. That is exactly what breaks on upgrade.
 *
 * Local:      AAAS_E2E_PI=real npm run e2e:real
 * Container:  make e2e-real   (mounts the host's pi config + endpoint auth)
 *
 * Default model: workbuddy/hy4-preview-ioa (override with AAAS_E2E_MODEL).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { bootEngine, DEFAULT_MODEL, DEFAULT_PROVIDER, get, post, waitForRun, type Engine } from "./helpers/harness.ts";

/** Skips the whole suite (rather than each test) when real pi was not requested. */
const real = process.env.AAAS_E2E_PI === "real";

let engine: Engine;

before(async () => {
  if (!real) return;
  engine = await bootEngine({ pi: "real", webDir: null, readyTimeoutMs: 40_000 });
});

after(async () => {
  await engine?.stop();
});

describe("L3 · real pi, real model", { skip: !real && "set AAAS_E2E_PI=real" }, () => {
  test("pi is installed and reachable", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const bin = process.env.AAAS_E2E_PI_BIN || "pi";
    const { stdout } = await run(bin, ["--version"], { timeout: 30_000 });
    assert.match(stdout, /\d+\.\d+\.\d+/, "pi --version should print a version");
  });

  test("the engine can enumerate real models via pi", async () => {
    const res = await get(engine, "/api/agents/pi/options?refresh=1");
    assert.equal(res.status, 200, res.text);

    const models = res.body.options?.find((o: any) => o.key === "model");
    assert.ok(models, "the pi adapter must expose model choices");

    // KNOWN UPSTREAM LIMITATION (pi 1.3.0): `get_available_models` over RPC
    // answers success with an empty list even though `pi --list-models` lists
    // them. The adapter turns that into an explicit error so the UI degrades
    // to a free-text field instead of offering an empty picker. Assert the
    // contract (never an unexplained empty list), not pi's inconsistency.
    if (models.options.length === 0) {
      assert.ok(
        typeof models.error === "string" && models.error.length > 0,
        "an empty model list must be accompanied by an error explaining why",
      );
    } else {
      assert.equal(models.error, undefined, `discovery error: ${models.error ?? ""}`);
      const ids = models.options.map((m: any) => m.value);
      assert.ok(ids.includes(DEFAULT_MODEL), `expected ${DEFAULT_MODEL}; pi offers: ${ids.join(", ")}`);
    }
  });

  test("a real run reaches the model and stores its answer", async () => {
    const res = await post(engine, "/api/jobs", {
      id: "l3-real",
      name: "L3 real pi",
      enabled: false,
      trigger: { type: "cron", every: "1h", timezone: "Asia/Shanghai" },
      agent: {
        type: "pi",
        cwd: "/tmp",
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        tools: [],
        timeoutMs: 120_000,
      },
      prompt: "Reply with exactly one line: aaas-l3-ok",
      timeoutMs: 120_000,
      retries: 0,
    });
    assert.equal(res.status, 201, res.text);

    const started = await post(engine, "/api/jobs/l3-real/run", {});
    assert.equal(started.status, 202, started.text);

    const record = await waitForRun(engine, started.body.run.id, 180_000);
    assert.equal(record.status, "succeeded", `${record.error ?? ""}\n${engine.output().slice(-2000)}`);
    assert.match(record.resultText ?? "", /aaas-l3-ok/i, "the model's answer must be stored verbatim");
    assert.ok((record.tokens?.total ?? 0) > 0, "a real run reports real token usage");
    // `record.model` is populated from pi's get_state, which does not always
    // answer; the model we asked for is asserted via the transcript below.
    assert.ok(record.exitCode === 0 || record.exitCode === null, `exit ${record.exitCode}`);
  });

  test("the transcript shows the real spawn line and provider", async () => {
    const runs = await get(engine, "/api/runs?jobId=l3-real&limit=1");
    assert.ok(runs.body.length > 0);
    const log = await get(engine, `/api/runs/${runs.body[0].id}/log`);
    const lines = log.body.lines.map((l: any) => l.line).join("\n");
    assert.match(lines, /--mode rpc --no-session/, "real argv is recorded");
    // Plain substring checks: building a RegExp from a model id (which contains
    // `/` and `.`) is both unnecessary and an injection-shaped habit.
    assert.ok(lines.includes(`--provider ${DEFAULT_PROVIDER}`), "provider is passed through");
    assert.ok(lines.includes(DEFAULT_MODEL), "model is passed through");
  });
});
