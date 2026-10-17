# aaas v1 — 冻结契约

> 本文件是并行施工的唯一接口依据。**不要自行修改本文件**；如遇矛盾，向父会话报告。

## 1. 产品形态

触发器（plugin）→ 任务定义（Job，YAML 声明）→ Agent 适配器（plugin）→ 运行记录（SQLite + JSONL）+ Web UI。

- 一期触发器：`cron`（cron 表达式 / interval）、`manual`（仅 API 触发）。
- 一期 Agent：`pi`。
- 时间：**后端全部存 epoch 毫秒**，时区仅作为 cron 表达式的解释参数与前端渲染参数存在。
- 周期任务用 cron 表达式；简单周期可用 `every: "15m"`。

## 2. 目录与文件归属（并行施工边界）

```
src/shared/types.ts              已冻结（父会话）
src/shared/*.ts                  父会话
src/core/cron.ts                 ★ Worker A
src/core/cron.test.ts            ★ Worker A
src/core/schedule.ts             ★ Worker A（把 cron / every 统一成 nextFire）
src/core/schedule.test.ts        ★ Worker A
src/core/db.ts                   父会话
src/core/jobstore.ts             父会话
src/core/runner.ts               父会话
src/core/scheduler.ts            父会话
src/core/registry.ts             父会话
src/core/events.ts               父会话
src/core/*.test.ts (除 cron/schedule)  父会话
src/triggers/cron.ts             父会话（调用 Worker A 的 schedule）
src/triggers/manual.ts           父会话
src/agents/pi/rpc-client.ts      ★ Worker B
src/agents/pi/index.ts           ★ Worker B
src/agents/pi/pi.test.ts         ★ Worker B
src/agents/pi/README.md          ★ Worker B（实测得到的坑位与选型结论）
src/server/**                    父会话
src/cli.ts                       父会话
web/**                           ★ Worker C
docs/**                          父会话
jobs/*.yaml                      父会话（示例任务）
```

**禁止**：修改 `package.json`、`tsconfig*.json`、`src/shared/types.ts`、别人名下的文件。需要新依赖 → 报告父会话。

### pi 适配器默认值（重要）

- `extensions` 不设 → **不传 `--no-extensions`**（继承 pi 正常环境，扩展注册的 provider 可用）。显式 `extensions: false` 才封闭。
- `mcp` 不设 → 传 `--no-mcp`（MCP 需显式开启）。
- 每次运行 `--no-session`（全新会话）。
- 所有扩展 UI 对话框自动应答，保证无人值守不阻塞。

## 3. Trigger 插件契约

```ts
interface TriggerPlugin<TConfig> {
  type: string;                                    // 'cron' | 'manual' | ...
  descriptor: PluginDescriptor;                    // UI 表单字段
  validate(raw: unknown): TriggerValidation<TConfig>;
  describe(config: TConfig): string;               // 'Every weekday at 09:00 (Asia/Shanghai)'
  nextFire?(config, after: EpochMs, lastFire: EpochMs | null): EpochMs | null;
  start?(ctx: TriggerPluginContext, job: JobSpec, config: TConfig): void | Promise<void>;
  stop?(jobId: string): void | Promise<void>;
}
```

- 时间型插件只实现 `nextFire`，引擎每秒 tick 一次，取所有 job 的 `nextFire` 最小值。
- 事件型插件（webhook）实现 `start`，通过 `ctx.emit(event)` 投递。
- `nextFire` 必须**严格大于** `after`，返回 `null` 表示永不再触发。
- cron 解析统一用 **`croner@9`**（已装，支持 5/6 段、`@hourly` 等宏、`{timezone}` 选项、`nextRuns(n, after)`）。不要自己手写 cron parser。

## 4. Agent 适配器契约

```ts
interface AgentAdapter {
  type: string;
  descriptor: PluginDescriptor;
  validate(raw: unknown): TriggerValidation<AgentConfig>;
  run(input: AgentRunInput, ctx: AgentRunContext): Promise<AgentRunResult>;
}
```

- `input.signal: AbortSignal` — 超时/取消时引擎会 abort；适配器**必须**在 abort 时干净地结束子进程（不留孤儿）。
- `ctx.log(stream, line)` — 每行都会落 JSONL 并推送 SSE。`stream ∈ {stdout, stderr, event, system}`。
- 返回 `ok:false` + `error` 表示本次运行失败（引擎据此重试）。

## 5. REST API（父会话实现，Worker C 对接）

服务器默认 `http://127.0.0.1:7788`。所有响应 `application/json`，错误 `{ error: string, details?: {path,message}[] }`。

| Method | Path | Body | 200 响应 |
|---|---|---|---|
| GET | `/api/health` | — | `HealthResponse` |
| GET | `/api/status` | — | `EngineStatus` |
| GET | `/api/triggers` | — | `TriggerInfo[]` |
| GET | `/api/agents` | — | `AgentInfo[]` |
| GET | `/api/jobs` | — | `JobView[]` |
| GET | `/api/jobs/:id` | — | `JobView` |
| POST | `/api/jobs` | `JobSpec` | `UpsertJobResponse` (201) |
| PUT | `/api/jobs/:id` | `JobSpec` | `UpsertJobResponse` |
| DELETE | `/api/jobs/:id` | — | 204 |
| POST | `/api/jobs/:id/enabled` | `{ enabled: boolean }` | `JobView` |
| POST | `/api/jobs/:id/run` | `{ payload?: unknown }` | `{ run: RunRecord }` (202) |
| POST | `/api/jobs/:id/cancel` | — | `{ cancelled: number }` |
| GET | `/api/jobs/:id/runs?limit=50` | — | `RunSummary[]` |
| GET | `/api/runs?jobId=&status=&limit=100` | — | `RunSummary[]` |
| GET | `/api/runs/:id` | — | `RunRecord` |
| GET | `/api/runs/:id/log?tail=500` | — | `{ runId, lines: { at, stream, line }[] }` |
| GET | `/api/runs/:id/stream` | — | SSE：`SseEvent`（`type:"log"`/`"end"`/`"ping"`） |
| GET | `/api/events` | — | SSE：全部 `SseEvent`（`log`/`run`/`job`/`ping`） |
| POST | `/api/schedule/preview` | `CronPreviewRequest` | `CronPreviewResponse` |

SSE 帧格式：`data: <JSON of SseEvent>\n\n`（每 15s 一个 ping）。校验失败返回 422。

**Web UI 开发代理**：vite dev server 把 `/api` 代理到 `http://127.0.0.1:7788`。

## 6. 引擎语义（默认值，勿改）

- 全局并发 2（`AAAS_MAX_CONCURRENCY`）；单 job 默认不并发（`allowOverlap:false`）。
- 单次超时 30min（`timeoutMs`），失败重试 1 次，指数退避 30s。
- 进程重启**不补跑**错过的时刻，只记一条 `skipped` 运行记录（`error: "missed while engine was down"`）。
  - 判定：`scheduledFor < engineStart - 60s` 的待触发点直接跳过。
- 每次触发 = 全新 pi 会话（一期不做会话续跑）。
- `enum RunStatus`: `queued | running | succeeded | failed | timeout | cancelled | skipped`。

## 7. 数据落盘

- SQLite：`data/aaas.db`（`node:sqlite`，无需原生编译）。
- 运行日志：`data/runs/<runId>.jsonl`，每行 `{"at":<epoch>,"stream":"stdout","line":"..."}`。
- Job 声明：`jobs/*.yaml`（可配置 `AAAS_JOBS_DIR`），文件即真相源；API 写入也回写 YAML。

## 8. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AAAS_PORT` | 7788 | HTTP 端口 |
| `AAAS_HOST` | 127.0.0.1 | 绑定地址 |
| `AAAS_DATA_DIR` | ./data | DB、日志 |
| `AAAS_JOBS_DIR` | ./jobs | YAML 目录 |
| `AAAS_DEFAULT_TZ` | Asia/Shanghai | cron 默认时区 |
| `AAAS_MAX_CONCURRENCY` | 2 | 全局并发 |
| `AAAS_PI_BIN` | `pi` | pi 可执行路径 |
| `AAAS_TICK_MS` | 1000 | 调度 tick |
| `AAAS_WEB_DIR` | web/dist | 静态资源目录（存在才挂载） |
