# `pi` agent adapter

Runs the [`pi`](https://github.com/earendil-works/pi) coding agent as a child
process and folds its output into an trigger `AgentRunResult`.

```text
src/agents/pi/index.ts       AgentAdapter (validate → buildPiArgs → run)
src/agents/pi/rpc-client.ts  minimal JSONL RPC client (PiRpcProcess)
src/agents/pi/pi.test.ts     protocol-replay tests (no model, no network)
```

One run = one `pi --mode rpc --no-session` subprocess. The adapter sends one
`prompt` command, mirrors every protocol record into the run transcript, and
waits for `agent_settled`.

---

## Why RPC (and not json / print / SDK)

| Option | Why it was rejected |
|---|---|
| `--mode json` | **The exit code is 0 even when the assistant fails.** No abort path, no session stats, no tool lifecycle. A failing run would look successful to the engine. |
| `--print` / `-p` | One-shot stdout text only. No usage, no tool events, no abort, no session metadata. |
| SDK / in-process embed | Reaching extension-registered providers requires `createAgentSessionServices`, and the agent then shares the host's exception surface and lifecycle. A crashed agent would take the engine down with it. |
| **`--mode rpc`** | Long-lived JSONL session on stdio: typed `response` records with ids, streaming events (`message_update`, `tool_execution_*`), explicit `agent_settled`, `abort` command, `get_session_stats`, `get_state`, and a real exit code. Process isolation gives us clean teardown. |

The client is hand-written instead of importing `@earendil-works/pi-coding-agent`
so the adapter has **zero new dependencies** and no coupling to pi's internal
package layout. Only `node:child_process`, `node:fs`, `node:path` are used.

## Protocol essentials

- **Start:** `pi --mode rpc --no-session [--provider P] [--model M] [--thinking L]
  [--tools a,b] [--exclude-tools x] [--no-tools] [--append-system-prompt '...']
  [--no-extensions] [--no-mcp] [--no-skills]`.
  The working directory comes from the spawn `cwd` — pi has **no `--cwd` flag**.
- **Framing:** one JSON object per line, `\n` terminated, **both directions**.
- **Correlation:** commands may carry `id`; the matching
  `{"type":"response","command":...,"success":...,"data":...,"error":...}` echoes it.
- **Prompt:** `{"type":"prompt","message":"..."}` →
  `data.disposition ∈ started | queued | handled`. `handled` means no run
  started, so `agent_settled` will never arrive.
- **End of run:** `{"type":"agent_settled","aborted":<bool>}`.
- **Final text:** the last `message_end` whose `message.role === "assistant"`,
  concatenating the `text` blocks of `message.content`.
- **Success:** that message's `stopReason === "stop"`. `error` / `aborted` /
  `length` are failures; details live in `message.errorMessage`.
- **Usage:** `message.usage = {input, output, cacheRead, cacheWrite, totalTokens, cost:{total}}`.
- **Metadata:** `get_session_stats` → `data.tokens` + `data.cost`;
  `get_state` → `data.sessionId` / `data.sessionFile`.
- **Abort:** send `{"type":"abort"}` (it answers only once idle), then close
  stdin. Best-effort only: the adapter also escalates to signals.

## Pitfall list (each one cost a debugging session)

1. **`--mode json` always exits 0.** `stopReason: "error"` arrives on stdout with
   exit code 0. Any supervisor that trusts the exit code reports success on
   provider failures. The adapter therefore keys success off `stopReason` **and**
   the exit code.
2. **Wait for `agent_settled`, never `agent_end`.** `agent_end` closes one
   low-level run; pi may still retry, recover from overflow, compact the
   context, steer, or run queued follow-ups afterwards. `agent_settled` is the
   only "pi will not continue automatically" signal.
3. **A fast run can settle before the `prompt` response is read.** If the
   adapter awaited the prompt response first, a fast completion would deadlock.
   `run()` races the prompt response against the settle promise. (Same reason
   the pi docs say to subscribe *before* prompting.)
4. **Never `SIGINT`.** Measured: `SIGINT` leaves orphaned grandchildren behind
   (pi's backgrounded `bash` processes survive). Teardown order is
   `stdin.end()` → `SIGTERM` (pi cleans up its detached children) → `SIGKILL`.
5. **Extension UI calls block forever in RPC mode.** `ctx.hasUI === true` in RPC
   mode, so `ctx.ui.select/confirm/input/editor` emit an
   `extension_ui_request` and block until an `extension_ui_response` with the
   same `id` arrives. An unattended run would hang. The adapter auto-answers:
   `confirm → {confirmed:true}`, `select → {value: <first option>}`,
   `input`/`editor → {value:""}`, and logs each decision as an `event`.
   Fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`,
   `set_editor_text`) need no response.
6. **stdout backpressure stalls the child.** pi honours stdout backpressure: if
   the client stops reading, the agent freezes. The reader always drains, with
   guards: a single record over 1 MiB is dropped (and the reader resyncs on the
   next LF), and after 64 MiB of stdout further records are dropped while
   draining continues.
7. **Do not use `readline`.** It splits on `U+2028` / `U+2029` as well as `\n`,
   and both are legal *inside* JSON strings. The client splits the buffer on
   `\n` by hand (tolerating a trailing `\r`).
8. **`--resume` (`-r`) opens the TUI.** Never pass it from an adapter; every v1
   run is a fresh `--no-session` process.
9. **`--no-session` makes `sessionFile` null.** `get_state` still returns a
   `sessionId`; a persisted transcript path only exists for saved sessions.
10. **Most model providers come from an extension — so extensions stay on.**
    On a stock install, many providers (e.g. `any-endpoint` or custom gateways)
    are registered by a pi *extension*, not built in. An earlier revision of
    this adapter defaulted to `--no-extensions` for determinism, which turned a
    normal job into `No API key found for the selected model` — the single most
    confusing failure for a new user. The default is now to inherit the
    operator's environment; set `extensions: false` when you want a hermetic
    run. Unattended safety does not depend on it (pitfall 5 auto-answers every
    dialog, and the child is a separate process with a wall-clock timeout).

## Config → argv

| `PiAgentConfig` | argv |
|---|---|
| *(always)* | `--mode rpc --no-session` |
| `provider` | `--provider <v>` |
| `model` | `--model <v>` |
| `thinking` | `--thinking <v>` |
| `tools[]` | `--tools a,b` |
| `excludeTools[]` | `--exclude-tools a,b` |
| `noTools` | `--no-tools` |
| `appendSystemPrompt` | `--append-system-prompt <v>` |
| `extensions !== true` | `--no-extensions --no-skills` |
| `mcp !== true` | `--no-mcp` |
| `env` | merged into the child env (plus `CI=1`, `NO_COLOR=1`, `TERM=dumb`) |

Secrets in `env` are redacted (`***`) in the `system` log line; the full value
still reaches the child.

## Run result mapping

| `AgentRunResult` | Source |
|---|---|
| `ok` | `settled.aborted === false && stopReason === "stop" && exitCode === 0` |
| `text` | concatenated `text` blocks of the last assistant `message_end` |
| `error` | `message.errorMessage` for `stopReason: "error"`, plus explicit reasons for `aborted` / `length` / missing message / non-zero exit |
| `aborted` | `agent_settled.aborted` (or our own `signal` abort) |
| `exitCode` | child exit code after teardown |
| `tokens` | `message.usage`, falling back to the last streamed `message_update.usage` |
| `costTotal` | `message.usage.cost.total` |
| `sessionId` / `sessionFile` | `get_state` / `get_session_stats` (non-fatal if they fail) |
| `model` | `message.model` |

`stream` labels used in the transcript: `system` (lifecycle, argv, exit),
`event` (raw JSON record), `stdout` (streamed text deltas and readable
`→ tool bash {...}` / `← tool bash (12ms, error)` lines), `stderr` (pi's own
diagnostics).

## Manual debugging

Talk the protocol by hand — the fastest way to see what the adapter sees:

```bash
cd /some/project
pi --mode rpc --no-session --provider any-endpoint --model <model> \
  | tee /tmp/pi-rpc.log
# in another shell, type one JSON command per line:
#   {"id":"1","type":"get_state"}
#   {"id":"2","type":"prompt","message":"Say OK"}
#   {"id":"3","type":"get_session_stats"}
#   {"type":"abort"}
```

Notes:
- Type commands into that terminal's stdin; the first pane shows the stream.
- Press `Ctrl-D` (EOF) to shut down cleanly instead of `Ctrl-C`.
- To inspect a single record type: `... | jq -c 'select(.type=="message_end")'`.
- Watch `/tmp/pi-rpc.log` to confirm the exact shape of records for your
  installed pi version; `pi --help` is authoritative for flags.

## Tests

```bash
node --import tsx --test src/agents/pi/pi.test.ts
```

The suite generates a `fake-pi.mjs` in a temp dir that replays the RPC protocol;
`FAKE_PI_MODE ∈ {ok, error, crash, hang, ui}` selects the scenario. No model, no
network, no API key. Covered: success + usage/text parsing, `stopReason: "error"`,
abort, extension-UI auto-answer, crash with `exitCode 3`, missing binary,
`validate` path checks, argv mapping, and pending-command rejection on child exit.
