#!/usr/bin/env node
/**
 * Fake `pi` for E2E: speaks just enough of `pi --mode rpc` to drive the REAL
 * adapter (src/agents/pi) end to end without a model provider.
 *
 * Why not a stub AgentAdapter instead?
 *   Because a stub adapter would stop testing the adapter. Pointing
 *   `AAAS_PI_BIN` at this file keeps every layer real — spawn, argv building,
 *   the JSONL protocol, abort/timeout escalation, transcript logging, token
 *   accounting, session reads — and only replaces the model at the very end of
 *   the chain. That is the difference between "the API works" and "aaas works".
 *
 * Behaviour is selected with FAKE_PI_MODE (default "ok"):
 *   ok          streams text, one tool call, settles successfully
 *   tool        same, but echoes the prompt so the transcript is assertable
 *   fail        settles then reports failure via an error response
 *   noprovider  rejects `prompt` like pi does with no credentials
 *   crash       exits 3 immediately (startup failure path)
 *   hang        never settles (exercises the run timeout)
 *   slow        settles after FAKE_PI_DELAY_MS (default 5s)
 *   ui          raises an extension dialog that must be auto-answered
 *   models      only answers get_available_models (discovery path)
 *
 * Any line written to FAKE_PI_ARGV_FILE records argv, so tests can assert what
 * aaas actually passed to pi (--model, --provider, --tools, ...).
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_PI_MODE ?? "ok";
const delayMs = Number(process.env.FAKE_PI_DELAY_MS ?? 5000);

if (process.env.FAKE_PI_ARGV_FILE) {
  writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(process.argv.slice(2)) + "\n", "utf8");
}
if (process.env.FAKE_PI_CWD_FILE) {
  writeFileSync(process.env.FAKE_PI_CWD_FILE, process.cwd() + "\n", "utf8");
}

const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const respond = (id, command, data) => out({ type: "response", ...(id ? { id } : {}), command, success: true, data });

const usage = (input, output, total) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: total ?? input + output,
  cost: { total: 0.001 },
});

const assistant = (text, model = "fake/model-1") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  model,
  usage: usage(11, 7, 18),
  timestamp: Date.now(),
});

if (mode === "crash") {
  process.stderr.write("fake pi: deliberate crash\n");
  process.exit(3);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  const id = cmd.id;

  switch (cmd.type) {
    case "get_available_models":
      respond(id, "get_available_models", {
        models: [
          { id: "fake/model-1", name: "Fake One", provider: "fake-provider" },
          { id: "fake/model-2", name: "Fake Two", provider: "fake-provider", reasoning: true },
        ],
      });
      return;

    case "get_state":
      respond(id, "get_state", { sessionId: "fake-session-id", model: "fake/model-1" });
      return;

    case "get_session_stats":
      respond(id, "get_session_stats", { sessionFile: "/tmp/fake-session.jsonl" });
      return;

    case "abort":
      respond(id, "abort", {});
      out({ type: "agent_settled", aborted: true });
      return;

    case "prompt": {
      const message = typeof cmd.message === "string" ? cmd.message : "";

      if (mode === "noprovider") {
        out({
          type: "response",
          ...(id ? { id } : {}),
          command: "prompt",
          success: false,
          error: "No API key found for the selected model",
        });
        return;
      }
      if (mode === "ui") {
        out({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?", message: "proceed?" });
        return; // only proceeds once the adapter auto-answers
      }
      if (mode === "hang") {
        respond(id, "prompt", { disposition: "started" });
        return; // never settles: the run must time out
      }

      respond(id, "prompt", { disposition: "started" });
      out({ type: "agent_start" });

      const finish = () => {
        const body = mode === "tool" ? `echo:${message}` : "fake pi answer";
        for (const chunk of body.split(/(?<=\s)/)) {
          out({
            type: "message_update",
            usage: usage(11, 3, 14),
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk },
          });
        }
        out({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "echo hi" } });
        out({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "bash", isError: false, durationMs: 12 });
        out({ type: "message_end", message: assistant(body) });
        out({ type: "agent_end", messages: [{ role: "user" }, { role: "assistant" }] });
        out(mode === "fail" ? { type: "agent_settled", aborted: false, error: "fake failure" } : { type: "agent_settled", aborted: false });
      };

      if (mode === "slow") setTimeout(finish, delayMs).unref?.();
      else finish();
      return;
    }

    case "extension_ui_response":
      // The adapter answered our dialog: continue the run as normal.
      if (mode === "ui") {
        out({ type: "agent_start" });
        out({ type: "message_end", message: assistant("fake pi answer after dialog") });
        out({ type: "agent_settled", aborted: false });
      }
      return;

    default:
      respond(id, cmd.type, {});
      return;
  }
});

// Some modes need a side channel the test can read (e.g. proving a run started).
if (process.env.FAKE_PI_RUN_FILE) {
  appendFileSync(process.env.FAKE_PI_RUN_FILE, `${process.pid}\n`, "utf8");
}
