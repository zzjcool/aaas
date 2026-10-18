# trigger 架构

## 数据流

```
jobs/*.yaml
    │  JobStore.load()   （YAML 是唯一真相源）
    ▼
JobSpec ──┬─► Scheduler ──► Runner ──► AgentAdapter.run() ──► 子进程 / API
          │      │  tick 每秒                  │
          │      │  取 nextFire 最小值         │  每 attempt
          │      ▼                             ▼
          │   TriggerPlugin.nextFire()      LogStore（JSONL）
          │                                  Db（SQLite）
          │                                  EventBus（SSE）
          ▼
    GET /api/jobs ──► Web UI
```

## 三层职责

### 1. Trigger 插件：决定"什么时候"

```ts
interface TriggerPlugin<TConfig> {
  type: string;
  descriptor: PluginDescriptor;         // 自动生成 UI 表单
  validate(raw): TriggerValidation<TConfig>;
  describe(config): string;             // "Every weekday at 09:00"
  nextFire?(config, after, lastFire): number | null;   // 时间型
  start?(ctx, job, config): void;                      // 事件型
  stop?(jobId): void;
}
```

- **时间型**（cron、interval）只实现 `nextFire`。它是纯函数：给定 `after` 返回严格更大的时间戳，或 `null` 表示不再触发。
- **事件型**（未来的 GitHub webhook、文件监听）实现 `start`，在监听回调里 `ctx.emit({ jobId, firedAt, payload })`。引擎不需要知道事件的来源。
- 两种形态共用同一个 registry、同一个 Scheduler、同一条运行记录流水线。

### 2. Runner：决定"怎么跑、跑几次"

- 全局并发上限（默认 2），单 job 默认不并发（`allowOverlap: false` 时重复触发记为 `skipped`）。
- 每次 attempt 有独立 `AbortController` 和超时定时器；超时 → abort → 适配器负责清理子进程。
- 失败重试按 `retryBackoffMs * 2^(attempt-1)` 退避，上限 1 小时。
- 所有状态变更先写 DB，再推 SSE；日志同步写入 JSONL fd（不是异步流，崩溃不丢尾行）。

### 3. AgentAdapter：决定"怎么执行"

```ts
interface AgentAdapter {
  type: string;
  descriptor: PluginDescriptor;
  validate(raw): TriggerValidation<AgentConfig>;
  run(input: AgentRunInput, ctx: AgentRunContext): Promise<AgentRunResult>;
}
```

- `input.signal` 是硬约束：abort 时必须干净退出，不留子进程（pi 的 bash 工具会 detach 孙进程，见 `src/agents/pi/README.md`）。
- `ctx.log(stream, line)` 的 `stream` 只有四个合法值：`stdout` / `stderr` / `event` / `system`。`event` 是协议原始记录，UI 默认折叠。
- 适配器不自己计时；超时由 Runner 通过 abort 施加，这样「超时」与「人工取消」走同一条路径。

## 时间与时区

**后端只存 epoch 毫秒。** 时区在且仅在两处出现：

1. 把 cron 表达式翻译成下次触发时刻时（`CronTriggerConfig.timezone`，缺省 `TRIGGER_DEFAULT_TZ`）。
2. 前端渲染时（浏览器本地时区 + job 声明的时区并排展示）。

因此：

- 服务器 `TZ=UTC` 不影响任何 job 的语义。
- 换机器、换时区、夏令时切换都不会改写历史 `scheduledFor`。
- `every: "15m"` 这类间隔与 cron 的语义差异被 `NormalizedSchedule` 抹平：间隔锚定在上一次触发时刻，cron 锚定在墙钟。

## 重启与错过

进程启动时（`Scheduler.setJobs` → `#collectCatchUp`）：

1. 从 `job_state.last_fire` 往前推，枚举所有早于 `startedAt - missedGraceMs` 的触发点。
2. 这些点**不执行**，只折叠成**一条** `skipped` 运行记录（`error: "missed while engine was down"`），记录其中最新的那个时刻。
3. 落在宽限期（默认 60s）内的触发点会正常执行一次。

这样做的理由：定时任务的语义是「在时间点上做事」，不是「补做所有错过的事」。一次 3 天的停机如果补跑，会在重启瞬间炸出数百个并发 agent 进程，比漏跑更糟。

`missedGraceMs` 可调（`TRIGGER_MISSED_GRACE_MS`），想严格不补跑就设 0。

## 失败与恢复

| 场景 | 行为 |
|---|---|
| 进程在运行中被杀 | 启动时 `markStaleRuns` 把所有 `queued`/`running` 标成 `failed`，附 `engine restarted while this run was live` |
| 适配器抛异常 | 捕获为 `failed`，写进 `error`，按策略重试 |
| 模型返回错误 | 适配器返回 `ok:false`（pi：`stopReason !== "stop"`），同上 |
| 超时 | `abort` → 状态 `timeout`（不重试，因为重试通常会再次超时） |
| 人工取消 | `abort` → 状态 `cancelled` |
| 上一个 run 还在跑 | 记一条 `skipped`，不排队（避免雪崩） |

## 存储

- `data/trigger.db`：`runs`（运行记录）、`job_state`（每 job 的 `last_fire`）、`meta`。
- `data/runs/<runId>.jsonl`：每行 `{"at":epoch,"stream":"stdout","line":"..."}`，与 DB 里的 `log_path` 对应。
- 用 `node:sqlite`（Node 22+ 内置），**没有原生编译步骤**，换机器 `npm install` 不会卡在 node-gyp。

## 插件化的边界（故意不做的抽象）

- **没有**通用「事件总线」让插件互相通信。触发器和 agent 之间只通过 `JobSpec` 和运行记录耦合。
- **没有**插件热加载（`import()` 外部 .ts）。注册是编译期的事（`src/server/main.ts`）。
- **没有** job 文件的文件监听（无 `fs.watch`）：直接改 `jobs/*.yaml` 不会自动生效。
  `reloadJobs()` 只在通过 API 增改删 job 时被调用，**手改 YAML 需要重启服务**
  （或调用一次 API 触发重载）。
- **没有** DAG / 任务依赖。一期每个 job 独立。需要串联时，让 agent 自己去触发（或二期加 `dependsOn`）。

这几条都是刻意的：先把「一个触发器 + 一个 agent + 一条运行记录」的通路做扎实，扩展点留在此处足够的形状上。
