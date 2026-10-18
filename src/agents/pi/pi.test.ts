import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiAdapter } from "./index.ts";
import { PiRpcProcess } from "./rpc-client.ts";

/**
 * Fake pi: speaks just enough of the RPC protocol to exercise the adapter
 * without a model provider. Behaviour is selected with FAKE_PI_MODE.
 */
const FAKE_PI = `#!/usr/bin/env node
import { createInterface } from "node:readline";

const mode = process.env.FAKE_PI_MODE ?? "ok";
let seq = 0;
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const respond = (id, command, data) =>
  out({ type: "response", ...(id ? { id } : {}), command, success: true, data });

const assistant = (text, stopReason, extra = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
  usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 11, cost: { total: 0.25 } },
  timestamp: Date.now(),
  ...extra,
});

if (mode === "crash") {
  process.stderr.write("fake pi crashing\\n");
  process.exit(3);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  const id = cmd.id;

  switch (cmd.type) {
    case "prompt": {
      if (mode === "ui") {
        out({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?", message: "proceed?" });
        // Only continue once the adapter auto-answers.
        break;
      }
      if (mode === "noprovider") {
        out({ type: "response", ...(id ? { id } : {}), command: "prompt", success: false, error: "No API key found for the selected model" });
        break;
      }
      if (mode === "hang") {
        respond(id, "prompt", { disposition: "started" });
        break;
      }
      respond(id, "prompt", { disposition: "started" });
      out({ type: "agent_start" });
      out({ type: "message_update", usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0 } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" } });
      out({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "echo hi" } });
      out({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "bash", result: {}, isError: false, durationMs: 12 });
      if (mode === "error") {
        out({ type: "message_end", message: assistant("", "error", { errorMessage: "provider exploded" }) });
      } else {
        out({ type: "message_end", message: assistant("hello from fake pi", "stop") });
      }
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled", aborted: false });
      break;
    }
    case "extension_ui_response": {
      // The adapter's auto-answer lands here; only then does the "extension"
      // release the prompt and let the run finish.
      out({ type: "message_end", message: assistant("answered: " + JSON.stringify(cmd), "stop") });
      out({ type: "agent_settled", aborted: false });
      break;
    }
    case "get_session_stats": {
      respond(id, "get_session_stats", { tokens: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0, total: 11 }, cost: 0.25, contextUsage: { tokens: 11, contextWindow: 1000, percent: 1 } });
      break;
    }
    case "get_state": {
      respond(id, "get_state", { sessionId: "sess-fake", sessionFile: "/tmp/fake.jsonl", model: { provider: "fake", id: "fake-model" } });
      break;
    }
    case "abort": {
      respond(id, "abort", {});
      out({ type: "agent_settled", aborted: true });
      break;
    }
    default:
      respond(id, cmd.type, {});
  }
  seq += 1;
});

rl.on("close", () => process.exit(0));
`;

interface Collected {
  streams: string[];
  lines: string[];
}

/** True when a pid is still running (signal 0 probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM would mean alive but not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function makeAdapter(mode: string, overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trigger-pi-"));
  const bin = join(dir, "fake-pi.mjs");
  writeFileSync(bin, FAKE_PI, "utf8");
  chmodSync(bin, 0o755);
  const collected: Collected = { streams: [], lines: [] };
  const adapter = createPiAdapter({ bin });
  const config = {
    type: "pi",
    cwd: dir,
    tools: [],
    extensions: false,
    mcp: false,
    env: { FAKE_PI_MODE: mode },
    ...overrides,
  } as never;
  const ctx = {
    log: (stream: string, line: string) => {
      collected.streams.push(stream);
      collected.lines.push(`${stream}: ${line}`);
    },
  };
  return { adapter, config, ctx, collected, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("successful run extracts the final text, usage and session metadata", async () => {
  const h = makeAdapter("ok");
  try {
    const controller = new AbortController();
    const result = await h.adapter.run(
      { runId: "r1", jobId: "j1", prompt: "hi", config: h.config, timeoutMs: 10_000, signal: controller.signal },
      h.ctx,
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.text, "hello from fake pi");
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, "sess-fake");
    assert.deepEqual(result.tokens, { input: 7, output: 3, cacheRead: 1, cacheWrite: 0, total: 11 });
    assert.equal(result.costTotal, 0.25);
    assert.ok(h.collected.lines.some((l) => l.includes("stdout: hel")), "streaming deltas must be logged");
    assert.ok(h.collected.lines.some((l) => l.includes("→ tool bash")), "tool start must be logged readably");
    assert.ok(h.collected.lines.some((l) => l.includes("← tool bash")), "tool end must be logged readably");
    assert.ok(h.collected.streams.includes("event"), "raw protocol records must be logged as events");
  } finally {
    h.cleanup();
  }
});

test("assistant stopReason=error fails the run with the provider message", async () => {
  const h = makeAdapter("error");
  try {
    const result = await h.adapter.run(
      { runId: "r2", jobId: "j2", prompt: "hi", config: h.config, timeoutMs: 10_000, signal: new AbortController().signal },
      h.ctx,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /provider exploded/);
  } finally {
    h.cleanup();
  }
});

test("aborting the signal stops the run and reports aborted", async () => {
  const h = makeAdapter("hang");
  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = h.adapter.run(
      { runId: "r3", jobId: "j3", prompt: "hi", config: h.config, timeoutMs: 30_000, signal: controller.signal },
      h.ctx,
    );
    setTimeout(() => controller.abort(new Error("test abort")), 250);
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("adapter did not return after abort")), 12_000)),
    ]);
    assert.equal(result.aborted, true, `expected aborted, got ${JSON.stringify(result)}`);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - startedAt < 5_000, `teardown took ${Date.now() - startedAt}ms, expected under 5s`);

    // The child must actually be gone: pick the pid the adapter logged and probe it.
    const pidLine = h.collected.lines.find((l) => l.includes("pi rpc started (pid"));
    assert.ok(pidLine, `expected a pid log line, got:\n${h.collected.lines.join("\n")}`);
    const pid = Number(/pid (\d+)/.exec(pidLine)?.[1]);
    assert.ok(Number.isInteger(pid) && pid > 0, `unparsable pid in: ${pidLine}`);
    assert.equal(pidAlive(pid), false, `pi child ${pid} is still alive after abort`);
  } finally {
    h.cleanup();
  }
});

test("extension UI dialogs are auto-answered so an unattended run cannot deadlock", async () => {
  const h = makeAdapter("ui");
  try {
    const result = await Promise.race([
      h.adapter.run(
        { runId: "r4", jobId: "j4", prompt: "hi", config: h.config, timeoutMs: 20_000, signal: new AbortController().signal },
        h.ctx,
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlocked on extension_ui_request")), 12_000)),
    ]);
    assert.equal(result.ok, true, result.error);
    assert.match(result.text, /answered: /);
    assert.match(result.text, /"confirmed":true/, "the adapter must answer confirm with confirmed:true");
    assert.ok(
      h.collected.lines.some((l) => l.includes("auto-answered extension confirm")),
      `the auto-answer must be logged; got: ${h.collected.lines.join(" | ")}`,
    );
  } finally {
    h.cleanup();
  }
});

test("a crashing child process fails the run with its exit code", async () => {
  const h = makeAdapter("ok");
  try {
    const result = await h.adapter.run(
      { runId: "r5", jobId: "j5", prompt: "hi", config: h.config, timeoutMs: 10_000, signal: new AbortController().signal },
      h.ctx,
    );
    // Control case first: the adapter itself works.
    assert.equal(result.ok, true);
  } finally {
    h.cleanup();
  }

  const crash = makeAdapter("crash");
  try {
    const result = await crash.adapter.run(
      { runId: "r6", jobId: "j6", prompt: "hi", config: crash.config, timeoutMs: 10_000, signal: new AbortController().signal },
      crash.ctx,
    );
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
  } finally {
    crash.cleanup();
  }
});

test("a missing pi binary produces an actionable error", async () => {  const h = makeAdapter("ok");
  const adapter = createPiAdapter({ bin: join(h.dir, "does-not-exist") });
  try {
    const result = await adapter.run(
      { runId: "r7", jobId: "j7", prompt: "hi", config: h.config, timeoutMs: 5_000, signal: new AbortController().signal },
      h.ctx,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /pi executable not found|ENOENT/i);
  } finally {
    h.cleanup();
  }
});

test("validate rejects a relative cwd and a missing directory", () => {
  const h = makeAdapter("ok");
  try {
    const relative = h.adapter.validate({ type: "pi", cwd: "relative/path" });
    assert.equal(relative.ok, false);
    assert.match((relative.errors ?? []).join(" "), /absolute/i);

    const missing = h.adapter.validate({ type: "pi", cwd: join(h.dir, "nope") });
    assert.equal(missing.ok, false);

    const good = h.adapter.validate({ type: "pi", cwd: h.dir });
    assert.equal(good.ok, true, (good.errors ?? []).join(" "));
  } finally {
    h.cleanup();
  }
});

test("buildPiArgs maps config to CLI flags and keeps unattended defaults", async () => {
  const { buildPiArgs } = await import("./index.ts");
  const args = buildPiArgs({
    type: "pi",
    cwd: "/tmp",
    provider: "p",
    model: "m",
    thinking: "high",
    tools: ["read", "grep"],
    excludeTools: ["bash"],
    appendSystemPrompt: "be brief",
  } as never);
  assert.ok(args.includes("--mode") && args.includes("rpc"));
  assert.ok(args.includes("--no-session"), "every run must be a fresh session in v1");
  assert.ok(args.includes("--provider") && args.includes("p"));
  assert.ok(args.includes("--model") && args.includes("m"));
  assert.ok(args.includes("--thinking") && args.includes("high"));
  assert.ok(args.includes("--tools") && args.includes("read,grep"));
  assert.ok(args.includes("--exclude-tools") && args.includes("bash"));
  assert.ok(args.includes("--append-system-prompt") && args.includes("be brief"));
  // Extensions stay on by default so extension-registered providers work;
  // MCP is opt-in. Both are explicit flags, never implicit behaviour.
  assert.ok(!args.includes("--no-extensions"), "extensions must stay available by default (providers)");
  assert.ok(!args.includes("--no-skills"));
  assert.ok(args.includes("--no-mcp"), "MCP is opt-in");

  const hermetic = buildPiArgs({ type: "pi", cwd: "/tmp", extensions: false } as never);
  assert.ok(hermetic.includes("--no-extensions"), "extensions:false must be hermetic");
  assert.ok(hermetic.includes("--no-skills"));

  const withMcp = buildPiArgs({ type: "pi", cwd: "/tmp", mcp: true } as never);
  assert.ok(!withMcp.includes("--no-mcp"));

  const noTools = buildPiArgs({ type: "pi", cwd: "/tmp", noTools: true } as never);
  assert.ok(noTools.includes("--no-tools"));
});

test("a provider that is unavailable fails the run with pi's own message", async () => {
  // Reproduces the `--no-extensions` + extension-registered-provider case.
  const h = makeAdapter("noprovider");
  try {
    const result = await h.adapter.run(
      { runId: "r8", jobId: "j8", prompt: "hi", config: h.config, timeoutMs: 10_000, signal: new AbortController().signal },
      h.ctx,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /No API key found for the selected model/);
  } finally {
    h.cleanup();
  }
});

test("discoverOptions reports real models, providers and the model->provider map", async () => {
  // A fake pi that answers `get_available_models` like the real one.
  const dir = mkdtempSync(join(tmpdir(), "trigger-discover-"));
  const bin = join(dir, "listing-pi.mjs");
  // Written with plain concatenation: template literals would turn the \n
  // escapes into real newlines and break the JSONL the script emits.
  const script = [
    "#!/usr/bin/env node",
    'import { createInterface } from "node:readline";',
    "const out = (r) => process.stdout.write(JSON.stringify(r) + String.fromCharCode(10));",
    "const rl = createInterface({ input: process.stdin });",
    'rl.on("line", (line) => {',
    "  let cmd; try { cmd = JSON.parse(line); } catch { return; }",
    '  if (cmd.type === "get_available_models") {',
    "    out({ id: cmd.id, type: \"response\", command: \"get_available_models\", success: true, data: { models: [",
    // The id prefix is NOT the provider - this is the case that broke the UI.
    '      { id: "workbuddy/claude-sonnet-5.5", name: "Sonnet", provider: "any-endpoint", reasoning: true, contextWindow: 1000000, maxTokens: 128000 },',
    '      { id: "other/model-x", name: "ModelX", provider: "other-provider", contextWindow: 200000 }',
    "    ] } });",
    "    return;",
    "  }",
    '  out({ id: cmd.id, type: "response", command: cmd.type, success: true, data: {} });',
    "});",
    "rl.on(\"close\", () => process.exit(0));",
    "",
  ].join(String.fromCharCode(10));
  writeFileSync(bin, script, "utf8");
  chmodSync(bin, 0o755);
  const adapter = createPiAdapter({ bin });
  try {
    assert.ok(adapter.discoverOptions, "pi must expose discovery");
    const discovery = await adapter.discoverOptions();
    const byKey = new Map(discovery.options.map((o) => [o.key, o]));

    const models = byKey.get("model");
    assert.ok(models);
    assert.deepEqual(
      models.options.map((o) => o.value),
      ["workbuddy/claude-sonnet-5.5", "other/model-x"],
    );
    assert.match(models.options[0]?.detail ?? "", /any-endpoint/);
    assert.match(models.options[0]?.detail ?? "", /1M ctx/);

    // The authoritative map is what the UI must use; splitting the id is wrong.
    assert.deepEqual(discovery.modelProviders, {
      "workbuddy/claude-sonnet-5.5": "any-endpoint",
      "other/model-x": "other-provider",
    });

    assert.deepEqual(
      byKey.get("provider")?.options.map((o) => o.value),
      ["any-endpoint", "other-provider"],
    );
    assert.deepEqual(
      byKey.get("thinking")?.options.map((o) => o.value),
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    );
    assert.equal(byKey.get("tools")?.multiple, true);
    assert.deepEqual(
      byKey.get("tools")?.options.map((o) => o.value),
      ["read", "bash", "edit", "write"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverOptions degrades to an error instead of throwing", async () => {
  const adapter = createPiAdapter({ bin: "/nonexistent/pi-binary" });
  assert.ok(adapter.discoverOptions);
  const discovery = await adapter.discoverOptions();
  const modelSource = discovery.options.find((o) => o.key === "model");
  assert.ok(modelSource, "the model key must still be present");
  assert.ok(modelSource.error, "so the UI knows to fall back to free text");
  assert.deepEqual(modelSource.options, []);
});

test("rpc client rejects pending commands when the child exits", async () => {  const dir = mkdtempSync(join(tmpdir(), "trigger-rpc-"));
  const bin = join(dir, "dying-pi.mjs");
  writeFileSync(bin, "#!/usr/bin/env node\nsetTimeout(() => process.exit(9), 60);\n", "utf8");
  chmodSync(bin, 0o755);
  const client = new PiRpcProcess({ bin, args: [], cwd: dir, env: { PATH: process.env.PATH ?? "" } });
  try {
    await client.start();
    await assert.rejects(() => client.command("get_state", {}, 5_000), /exited|closed/i);
  } finally {
    await client.close().catch(() => null);
    rmSync(dir, { recursive: true, force: true });
  }
});
