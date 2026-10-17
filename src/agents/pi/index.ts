import { tmpdir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type {
  AgentAdapter,
  FieldOptionSource,
  AgentConfig,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  FieldSchema,
  PiAgentConfig,
  PluginDescriptor,
  ThinkingLevel,
  TokenUsage,
  TriggerValidation,
} from "../../shared/types.ts";
import { PiRpcProcess, type RpcRecord } from "./rpc-client.ts";

/**
 * `pi` coding-agent adapter.
 *
 * One run == one `pi --mode rpc --no-session` subprocess. The adapter sends a
 * single `prompt` command, streams every protocol record into the run
 * transcript, and treats `agent_settled` as the end of the run (never
 * `agent_end`, which fires again after retries/compaction).
 *
 * DESIGN NOTE — extension-dependent providers:
 *
 *   A provider registered by an extension (e.g. `pi-any-endpoint`) only exists
 *   when extensions are loaded. Closing extensions by default therefore turns a
 *   perfectly normal job into `No API key found for the selected model`, which
 *   is the single most confusing failure mode for a new user.
 *
 *   So the default is to inherit the operator's normal pi environment
 *   (extensions + skills on, MCP off). Unattended safety does not depend on
 *   disabling extensions: every extension dialog is auto-answered below, and
 *   the child runs in its own process with a wall-clock timeout. Set
 *   `extensions: false` explicitly when you want a hermetic, reproducible run.
 *
 * Providers come from extensions:
 *   On a stock install many providers (e.g. `any-endpoint`, custom gateways)
 *   are registered by a pi *extension*, not built in. This adapter therefore
 *   keeps extensions enabled unless a job sets `extensions: false`. Discovery
 *   (see `discoverOptions`) launches pi the same way, so the model list the UI
 *   offers is exactly the list a run will see. See ./README.md.
 */

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Extra time on top of the run timeout we allow for teardown. */
const PROMPT_TIMEOUT_SLACK_MS = 5_000;

/**
 * Accept `"true"`/`"false"`/`1`/`0` from YAML-ish input as well as real
 * booleans, and always yield a plain `boolean`.
 */
const booleanish = z.union([
  z.boolean(),
  z.literal(1).transform(() => true),
  z.literal(0).transform(() => false),
  z.enum(["true", "yes", "1"]).transform(() => true),
  z.enum(["false", "no", "0"]).transform(() => false),
]);

const configSchema = z.looseObject({
  type: z.literal("pi").optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
  cwd: z.string().trim().min(1),
  tools: z.array(z.string().trim().min(1)).optional(),
  excludeTools: z.array(z.string().trim().min(1)).optional(),
  noTools: booleanish.optional(),
  appendSystemPrompt: z.string().optional(),
  extensions: booleanish.optional(),
  mcp: booleanish.optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const descriptor: PluginDescriptor = {
  type: "pi",
  displayName: "pi coding agent",
  description:
    "Runs the `pi` coding agent in RPC mode. Each run is a fresh, non-interactive session in the configured working directory.",
  fields: [
    {
      key: "cwd",
      label: "Working directory",
      type: "string",
      required: true,
      placeholder: "/home/me/project",
      help: "Absolute path the agent runs in. Must already exist.",
    },
    {
      key: "provider",
      label: "Provider",
      type: "string",
      placeholder: "any-endpoint",
      help: "Passed as --provider. Leave empty to use the pi default.",
    },
    {
      key: "model",
      label: "Model",
      type: "string",
      placeholder: "workbuddy/hy4-preview-ioa",
      help: "Passed as --model.",
    },
    {
      key: "thinking",
      label: "Thinking level",
      type: "select",
      default: "off",
      options: [
        { value: "off", label: "off" },
        { value: "minimal", label: "minimal" },
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
        { value: "xhigh", label: "xhigh" },
        { value: "max", label: "max" },
      ],
      help: "Passed as --thinking.",
    },
    {
      key: "tools",
      label: "Allowed tools",
      type: "string[]",
      help: "Comma-joined into --tools. Empty means the pi defaults.",
    },
    {
      key: "excludeTools",
      label: "Excluded tools",
      type: "string[]",
      help: "Comma-joined into --exclude-tools.",
    },
    {
      key: "noTools",
      label: "Disable all tools",
      type: "boolean",
      default: false,
      help: "Passes --no-tools.",
    },
    {
      key: "appendSystemPrompt",
      label: "Extra system prompt",
      type: "textarea",
      help: "Appended via --append-system-prompt. Keeps pi's built-in prompt.",
    },
    {
      key: "extensions",
      label: "Load pi extensions",
      type: "boolean",
      default: true,
      help: "On by default, so extension-provided model providers work. Turn off (--no-extensions --no-skills) for a hermetic run.",
    },
    {
      key: "mcp",
      label: "Connect MCP servers",
      type: "boolean",
      default: false,
      help: "Off by default (--no-mcp): MCP servers add startup cost and side effects.",
    },
    {
      key: "env",
      label: "Environment",
      type: "string",
      help: "Extra environment variables as KEY=VALUE lines (secrets are redacted in logs).",
    },
  ] satisfies FieldSchema[],
};

function validate(raw: unknown): TriggerValidation<AgentConfig> {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }

  const value = parsed.data;
  const errors: string[] = [];

  if (!isAbsolute(value.cwd)) {
    errors.push(`cwd: must be an absolute path, got "${value.cwd}"`);
  } else if (!existsSync(value.cwd)) {
    errors.push(`cwd: directory does not exist: ${value.cwd}`);
  } else {
    try {
      if (!statSync(value.cwd).isDirectory()) errors.push(`cwd: not a directory: ${value.cwd}`);
    } catch (err) {
      errors.push(`cwd: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // pi's own CLI contract: "--provider <name> ... (requires --model)".
  if (value.provider !== undefined && value.model === undefined) {
    errors.push("model: required when provider is set (pi cannot select a model without one)");
  }

  if (errors.length > 0) return { ok: false, errors };

  const config: PiAgentConfig = { type: "pi", cwd: value.cwd };
  if (value.provider !== undefined) config.provider = value.provider;
  if (value.model !== undefined) config.model = value.model;
  if (value.thinking !== undefined) config.thinking = value.thinking;
  if (value.tools !== undefined && value.tools.length > 0) config.tools = value.tools;
  if (value.excludeTools !== undefined && value.excludeTools.length > 0) config.excludeTools = value.excludeTools;
  if (value.noTools === true) config.noTools = true;
  if (value.appendSystemPrompt !== undefined && value.appendSystemPrompt.length > 0) {
    config.appendSystemPrompt = value.appendSystemPrompt;
  }
  // `undefined` stays undefined so the adapter falls back to its defaults.
  if (value.extensions !== undefined) config.extensions = value.extensions;
  if (value.mcp !== undefined) config.mcp = value.mcp;
  if (value.env !== undefined && Object.keys(value.env).length > 0) config.env = value.env;

  return { ok: true, config };
}

/* ------------------------------------------------------------------ */
/* argv / env                                                          */
/* ------------------------------------------------------------------ */

/** Build the `pi` argv for one run. Always `--mode rpc --no-session`. */
export function buildPiArgs(config: PiAgentConfig): string[] {
  const args: string[] = ["--mode", "rpc", "--no-session"];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));
  if (config.excludeTools && config.excludeTools.length > 0) {
    args.push("--exclude-tools", config.excludeTools.join(","));
  }
  if (config.noTools) args.push("--no-tools");
  if (config.appendSystemPrompt) args.push("--append-system-prompt", config.appendSystemPrompt);
  // Extensions stay ON unless explicitly disabled: extension-registered model
  // providers are the norm, and dialogs are auto-answered so they cannot hang
  // an unattended run. MCP is opt-in (startup cost, external side effects).
  if (config.extensions === false) args.push("--no-extensions", "--no-skills");
  if (config.mcp !== true) args.push("--no-mcp");
  return args;
}

const SECRET_ENV = /key|token|secret|password|passwd|credential|auth/i;

/** `KEY=***` for anything that looks like a credential. */
function redactEnv(env: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    parts.push(`${key}=${SECRET_ENV.test(key) ? "***" : value}`);
  }
  return parts.join(" ");
}

function buildEnv(config: PiAgentConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...config.env };
  // Deterministic, colourless, non-interactive child.
  env.CI = "1";
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  return env;
}

/* ------------------------------------------------------------------ */
/* protocol helpers                                                    */
/* ------------------------------------------------------------------ */

interface AssistantMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  provider?: unknown;
  model?: unknown;
}

function asAssistantMessage(record: RpcRecord): AssistantMessage | null {
  const message = record.message;
  if (typeof message !== "object" || message === null) return null;
  const candidate = message as AssistantMessage;
  return candidate.role === "assistant" ? candidate : null;
}

/** Concatenate every `text` content block of an assistant message. */
export function messageText(message: AssistantMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
  }
  return parts.join("");
}

function toTokens(usage: AssistantMessage["usage"]): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  const total = num(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === 0) return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}


/**
 * `agent_end` carries the entire message array, including the full system
 * prompt — hundreds of KB per run. Keep a structural summary so transcripts
 * stay readable and the 64 MiB log guard is not spent on boilerplate.
 */
function summarizeRecord(record: RpcRecord): string {
  const type = typeof record.type === "string" ? record.type : "?";
  if (type === "agent_end" && Array.isArray(record.messages)) {
    const roles = record.messages
      .map((message) => (typeof message === "object" && message !== null ? String((message as { role?: unknown }).role ?? "?") : "?"))
      .join(",");
    return JSON.stringify({ type, messageCount: record.messages.length, roles, willRetry: record.willRetry === true });
  }
  const serialized = JSON.stringify(record);
  return serialized.length <= 8_000 ? serialized : `${serialized.slice(0, 8_000)}… (${serialized.length} chars truncated)`;
}

/** Answer extension dialogs so `ctx.ui.*` cannot deadlock an unattended run. */
function autoAnswerUiRequest(client: PiRpcProcess, record: RpcRecord, log: (line: string) => void): void {
  const id = typeof record.id === "string" ? record.id : undefined;
  const method = typeof record.method === "string" ? record.method : "";
  if (!id) return;
  switch (method) {
    case "confirm":
      log(`auto-answered extension confirm "${String(record.title ?? "")}" → confirmed:true`);
      client.send({ type: "extension_ui_response", id, confirmed: true });
      break;
    case "select": {
      const options = Array.isArray(record.options) ? record.options : [];
      const first = typeof options[0] === "string" ? (options[0] as string) : "";
      log(`auto-answered extension select "${String(record.title ?? "")}" → ${JSON.stringify(first)}`);
      client.send({ type: "extension_ui_response", id, value: first });
      break;
    }
    case "input":
    case "editor":
      log(`auto-answered extension ${method} "${String(record.title ?? "")}" → ""`);
      client.send({ type: "extension_ui_response", id, value: "" });
      break;
    default:
      // notify / setStatus / setWidget / setTitle / set_editor_text are fire-and-forget.
      break;
  }
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export interface PiAdapterOptions {
  /** Executable to spawn. Defaults to `AAAS_PI_BIN` or `pi`. */
  bin?: string;
  /** Default per-command RPC timeout (prompt uses the run timeout instead). */
  defaultTimeoutMs?: number;
}

/**
 * Everything the record callback writes and the result builder reads.
 * Kept in one object because TypeScript cannot narrow closure assignments to
 * separate `let` bindings.
 */
interface RunState {
  finalMessage: AssistantMessage | null;
  lastStreamUsage: TokenUsage | undefined;
  settled: { aborted: boolean } | null;
  sessionId: string | null;
  sessionFile: string | null;
  model: string | null;
  abortedBySignal: boolean;
}

export function createPiAdapter(opts: PiAdapterOptions = {}): AgentAdapter {
  const bin = opts.bin ?? process.env.AAAS_PI_BIN ?? "pi";
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;

  const run = async (input: AgentRunInput, ctx: AgentRunContext): Promise<AgentRunResult> => {
    const config = input.config as PiAgentConfig;
    const args = buildPiArgs(config);
    const env = buildEnv(config);

    ctx.log("system", `spawn ${bin} ${args.join(" ")} (cwd=${config.cwd})`);
    const extraEnv = config.env ?? {};
    if (Object.keys(extraEnv).length > 0) {
      ctx.log("system", `extra env: ${redactEnv(extraEnv)}`);
    }

    const client = new PiRpcProcess({ bin, args, cwd: config.cwd, env });

    // Mutable run state lives in one object: TypeScript cannot narrow closure
    // assignments to separate `let` bindings, so keep it dereferenced through
    // a stable holder.
    const state: RunState = {
      finalMessage: null,
      lastStreamUsage: undefined,
      settled: null,
      sessionId: null,
      sessionFile: null,
      model: null,
      abortedBySignal: false,
    };

    let resolveSettled: () => void = () => {};
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });

    const offRecord = client.onRecord((record) => {
      const type = typeof record.type === "string" ? record.type : "";
      try {
        ctx.log("event", summarizeRecord(record));
      } catch {
        /* unserialisable record; the event stream is best-effort */
      }

      switch (type) {
        case "message_end": {
          const message = asAssistantMessage(record);
          if (message) {
            state.finalMessage = message;
            const usage = toTokens(message.usage);
            if (usage) state.lastStreamUsage = usage;
            if (typeof message.model === "string") state.model = message.model;
          }
          break;
        }
        case "message_update": {
          const usage = toTokens(record.usage as AssistantMessage["usage"]);
          if (usage) state.lastStreamUsage = usage;
          const assistantEvent = record.assistantMessageEvent;
          if (
            typeof assistantEvent === "object" &&
            assistantEvent !== null &&
            (assistantEvent as { type?: unknown }).type === "text_delta"
          ) {
            const delta = (assistantEvent as { delta?: unknown }).delta;
            if (typeof delta === "string" && delta.length > 0) ctx.log("stdout", delta);
          }
          break;
        }
        case "tool_execution_start": {
          const name = String(record.toolName ?? "?");
          ctx.log("stdout", `→ tool ${name} ${safeJson(record.args)}`);
          break;
        }
        case "tool_execution_end": {
          const name = String(record.toolName ?? "?");
          const meta: string[] = [];
          if (typeof record.durationMs === "number") meta.push(`${Math.round(record.durationMs)}ms`);
          if (record.isError === true) meta.push("error");
          ctx.log("stdout", `← tool ${name}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}`);
          break;
        }
        case "agent_settled": {
          state.settled = { aborted: record.aborted === true };
          resolveSettled();
          break;
        }
        case "extension_ui_request": {
          autoAnswerUiRequest(client, record, (line) => ctx.log("event", line));
          break;
        }
        case "extension_error": {
          ctx.log("stderr", `extension error: ${String(record.error ?? record.message ?? "unknown")}`);
          break;
        }
        default:
          break;
      }
    });

    const offStderr = client.onStderr((line) => {
      ctx.log("stderr", line);
    });

    const onAbort = () => {
      state.abortedBySignal = true;
      ctx.log("system", `abort requested${input.signal.reason ? `: ${String(input.signal.reason)}` : ""}`);
      // Graceful teardown: `abort` command first, then close/kill escalation.
      void client.abortAndClose().catch(() => {});
      resolveSettled();
    };

    const promptTimeoutMs = Math.max(1_000, input.timeoutMs) + PROMPT_TIMEOUT_SLACK_MS;
    let exitCode: number | null = null;

    try {
      await client.start();
      ctx.log("system", `pi rpc started (pid ${client.pid ?? "?"})`);
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Prompt first, but never block on the response alone: pi can settle a
      // fast run before the prompt response reaches us (the docs warn that
      // clients must subscribe before prompting for exactly this reason).
      if (!state.abortedBySignal) {
        const promptPromise = client.command("prompt", { message: input.prompt }, promptTimeoutMs);
        const raced = await Promise.race([
          promptPromise.then((response) => ({ kind: "response" as const, response })),
          settledPromise.then(() => ({ kind: "settled" as const })),
        ]);

        if (raced.kind === "response") {
          const promptResponse = raced.response;
          if (!promptResponse.success) {
            const detail = promptResponse.error ?? "unknown error";
            ctx.log("system", `prompt rejected: ${detail}`);
            return {
              ok: false,
              text: "",
              error: `prompt rejected: ${detail}`,
              exitCode: null,
              sessionId: state.sessionId,
              sessionFile: state.sessionFile,
              model: state.model,
            };
          }
          const disposition = (promptResponse.data as { disposition?: string } | undefined)?.disposition;
          if (disposition) ctx.log("system", `prompt disposition: ${disposition}`);
          if (disposition === "handled") {
            // No run started for this prompt, so nothing will ever settle.
            state.settled = { aborted: false };
            resolveSettled();
          }
        } else {
          // Settled first: the run is over, record a late prompt answer for the audit trail.
          void promptPromise
            .then((response) => {
              if (!response.success) ctx.log("system", `prompt rejected after settle: ${response.error ?? "unknown"}`);
            })
            .catch((err: unknown) => {
              ctx.log("system", `prompt command failed after settle: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
      }

      if (!state.settled) await settledPromise;

      // Session facts are nice-to-have; never fail the run over them.
      if (!state.abortedBySignal && !client.exited) {
        state.sessionId = await readSessionId(client, defaultTimeoutMs, ctx);
        state.sessionFile = await readSessionFile(client, defaultTimeoutMs, ctx);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log("system", `run failed: ${message}`);
      return {
        ok: false,
        text: state.finalMessage ? messageText(state.finalMessage) : "",
        error: message,
        exitCode: client.exited ? client.exitCode : null,
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        model: state.model,
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      offRecord();
      offStderr();
      // Any exit path tears the child down: stdin close → SIGTERM → SIGKILL.
      exitCode = await client.close().catch(() => null);
      ctx.log("system", `pi exited with code ${String(exitCode)}`);
    }

    return buildResult(state, exitCode);
  };

  const discoverOptions = async (): Promise<FieldOptionSource[]> => {
    const sources: FieldOptionSource[] = [];

    /* ---- models: authoritative, straight from pi ---- */
    const discovered = await discoverModels(bin);
    if ("error" in discovered) {
      sources.push({ key: "model", options: [], source: "pi get_available_models", error: discovered.error });
    } else {
      const options = discovered.models.map((model) => {
        const bits: string[] = [];
        if (model.provider) bits.push(model.provider);
        if (model.contextWindow) bits.push(`${formatTokens(model.contextWindow)} ctx`);
        if (model.maxTokens) bits.push(`${formatTokens(model.maxTokens)} out`);
        if (model.reasoning) bits.push("thinking");
        return {
          value: model.id,
          label: model.name && model.name !== model.id ? `${model.name} — ${model.id}` : model.id,
          ...(bits.length > 0 ? { detail: bits.join(" · ") } : {}),
        };
      });
      sources.push({
        key: "model",
        options,
        source: "pi get_available_models",
        // The provider is implied by the model id, so the UI can set both.
      });
      const providers = [...new Set(discovered.models.map((m) => m.provider).filter((p): p is string => typeof p === "string"))];
      if (providers.length > 0) {
        sources.push({
          key: "provider",
          options: providers.map((provider) => ({ value: provider, label: provider })),
          source: "pi get_available_models",
        });
      }
    }

    /* ---- thinking: static, mirrors pi's --thinking levels ---- */
    sources.push({
      key: "thinking",
      options: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
      source: "pi --thinking",
    });

    /* ---- tools: pi's documented defaults, multi-select ---- */
    sources.push({
      key: "tools",
      multiple: true,
      options: DEFAULT_PI_TOOLS.map((tool) => ({ value: tool, label: tool })),
      source: "pi default tools",
    });

    return sources;
  };

  return {
    type: "pi",
    descriptor,
    validate,
    run,
    discoverOptions,
  };
}

/**
 * Tools pi enables by default (docs/cli.md: "Default enabled tools are `read`,
 * `bash`, `edit`, and `write`, unless `defaultTools` changes them"). Extension
 * and MCP tools are extra and cannot be enumerated without loading them, so the
 * picker offers these plus a free-text escape hatch in the UI.
 */
const DEFAULT_PI_TOOLS = ["read", "bash", "edit", "write"] as const;

interface DiscoveredModel {
  id: string;
  name?: string;
  provider?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Ask pi which models it actually has, by starting it once in RPC mode and
 * issuing `get_available_models`. This is authoritative: it reflects installed
 * extensions, credentials and `models.json`, so the UI cannot offer a model
 * that a run would reject.
 *
 * Returns `{ error }` instead of throwing: discovery failing must degrade the
 * form to free text, never break the editor.
 */
async function discoverModels(bin: string): Promise<{ models: DiscoveredModel[] } | { error: string }> {
  const client = new PiRpcProcess({
    bin,
    // Extensions on (providers live there) and no MCP (not needed to list models).
    args: ["--mode", "rpc", "--no-session", "--no-mcp"],
    cwd: tmpdir(),
    env: { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb" } as Record<string, string | undefined>,
  });
  try {
    await client.start();
    const response = await client.command("get_available_models", {}, 20_000);
    if (!response.success) return { error: response.error ?? "get_available_models failed" };
    const raw = (response.data as { models?: unknown } | undefined)?.models;
    if (!Array.isArray(raw)) return { error: "unexpected response shape from get_available_models" };
    const models: DiscoveredModel[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || record.id === "") continue;
      models.push({
        id: record.id,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
        ...(record.reasoning === true ? { reasoning: true } : {}),
        ...(typeof record.contextWindow === "number" ? { contextWindow: record.contextWindow } : {}),
        ...(typeof record.maxTokens === "number" ? { maxTokens: record.maxTokens } : {}),
      });
    }
    return { models };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.close().catch(() => null);
  }
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

/** Default singleton adapter, used by the engine registry. */
export const piAgent: AgentAdapter = createPiAdapter();

/**
 * Translate collected run state into the frozen `AgentRunResult` shape.
 * Success requires all three: pi did not abort, the assistant stopped cleanly,
 * and the process exited 0 (`--mode json` can report 0 on failure; RPC plus the
 * stop reason is what makes this trustworthy).
 */
function buildResult(state: RunState, exitCode: number | null): AgentRunResult {
  const finalMessage = state.finalMessage;
  const text = finalMessage ? messageText(finalMessage) : "";

  if (state.abortedBySignal) {
    return {
      ok: false,
      text,
      error: "aborted by signal",
      aborted: true,
      exitCode,
      ...(state.lastStreamUsage ? { tokens: state.lastStreamUsage } : {}),
      sessionId: state.sessionId,
      sessionFile: state.sessionFile,
      model: state.model,
    };
  }

  const stopReason = finalMessage?.stopReason ?? null;
  const usage = toTokens(finalMessage?.usage) ?? state.lastStreamUsage;
  const costTotal = costOf(finalMessage?.usage);
  const settledAborted = state.settled?.aborted === true;
  const okay = !settledAborted && stopReason === "stop" && exitCode === 0;
  const error = okay ? undefined : explainFailure(stopReason, finalMessage, exitCode, settledAborted);

  return {
    ok: okay,
    text,
    ...(error !== undefined ? { error } : {}),
    exitCode,
    aborted: settledAborted,
    ...(usage !== undefined ? { tokens: usage } : {}),
    ...(costTotal !== undefined ? { costTotal } : {}),
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    model: state.model,
  };
}

/** One-sentence reason for a non-successful run, preferring pi's own message. */
function explainFailure(
  stopReason: string | null,
  finalMessage: AssistantMessage | null,
  exitCode: number | null,
  settledAborted: boolean,
): string {
  if (settledAborted) return "pi aborted the run";
  switch (stopReason) {
    case "error":
      return finalMessage?.errorMessage ?? "assistant stopped with an error";
    case "aborted":
      return finalMessage?.errorMessage ?? "assistant stopped: aborted";
    case "length":
      return "assistant stopped: output length limit reached";
    case null:
      return `pi produced no assistant message (exit code ${String(exitCode)})`;
    case "toolUse":
    case "pending":
    case "deferred":
      return `run did not finish (stopReason ${stopReason})`;
    default:
      return exitCode !== 0
        ? `pi exited with code ${String(exitCode)}`
        : `assistant stopped with ${String(stopReason)}`;
  }
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return "";
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return String(value);
  }
}

function costOf(usage: AssistantMessage["usage"]): number | undefined {
  const total = usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

async function readSessionId(client: PiRpcProcess, timeoutMs: number, ctx: AgentRunContext): Promise<string | null> {
  try {
    const response = await client.command("get_state", {}, timeoutMs);
    if (!response.success) return null;
    const data = response.data as { sessionId?: unknown; model?: unknown } | undefined;
    if (typeof data?.model === "string") ctx.log("system", `pi model: ${data.model}`);
    return typeof data?.sessionId === "string" ? data.sessionId : null;
  } catch {
    return null;
  }
}

async function readSessionFile(client: PiRpcProcess, timeoutMs: number, ctx: AgentRunContext): Promise<string | null> {
  try {
    const response = await client.command("get_session_stats", {}, timeoutMs);
    if (!response.success) return null;
    const data = response.data as { sessionFile?: unknown } | undefined;
    if (typeof data?.sessionFile !== "string") return null;
    ctx.log("system", `pi session file: ${data.sessionFile}`);
    return data.sessionFile;
  } catch {
    return null;
  }
}

export type { PiAgentConfig, ThinkingLevel };
