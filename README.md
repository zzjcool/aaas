# aaas — Agent as a Service

触发器（插件化）→ 任务定义（YAML）→ Agent 适配器（插件化）→ 运行记录 + Web 控制台。

第一期交付：**定时触发器**（cron 表达式 / 固定间隔）+ **pi coding agent** 适配器 + Web UI。

```
┌──────────────┐  TriggerEvent   ┌───────────────┐  spawn   ┌──────────────┐
│  Trigger     │ ──────────────▶ │  Scheduler    │ ───────▶ │  Agent       │
│  (plugin)    │                 │  + Runner     │          │  Adapter     │
│  cron    ✅  │  {jobId,        │  队列/并发/   │          │  pi (RPC) ✅ │
│  manual  ✅  │   scheduledFor, │  超时/重试    │          │  …           │
│  webhook ⤵   │   payload}      └───────┬───────┘          └──────┬───────┘
└──────────────┘                         │ RunRecord               │
                                         ▼                         ▼
                                 SQLite + JSONL 日志         pi --mode rpc
```

## 快速开始

```bash
npm install
npm run dev          # 后端 :7788 + 前端 :5173（热更新）
# 或
npm start            # 只跑后端（已有 web/dist 时会顺带托管 UI）
npm run cli -- health
```

打开 http://127.0.0.1:5173 （dev）或 http://127.0.0.1:7788 （生产构建后）。

创建一个任务：UI 里点 **New job**，或者直接写 `jobs/<id>.yaml`：

```yaml
id: nightly-repo-report
name: Nightly repo report
enabled: true
trigger:
  type: cron
  cron: "0 9 * * 1-5"     # 工作日 09:00
  timezone: Asia/Shanghai
agent:
  type: pi
  cwd: /root/code/some-repo
  tools: [read, grep, find, ls]
  # provider/model 可省略 —— 继承 pi 自己的默认（本机是扩展注册的 any-endpoint）
prompt: |
  检查本仓库昨天的提交，把风险点写进 reports/daily.md。
timeoutMs: 1800000
retries: 1
```

立刻验证：

```bash
npm run cli -- preview --cron "0 9 * * 1-5" --tz Asia/Shanghai
npm run cli -- run nightly-repo-report --wait    # 流式跟日志直到结束
```

## 设计要点

**后端只存时间戳。** 所有 `scheduledFor` / `nextFireAt` / `createdAt` 都是 epoch 毫秒。时区只在一处生效：把 cron 表达式翻译成时间戳的那一刻（job 级 `trigger.timezone`，默认 `AAAS_DEFAULT_TZ`）。UI 负责按浏览器本地时区渲染。

**插件化边界。**
- `TriggerPlugin`：`validate` / `describe` / `nextFire`（时间型）或 `start`（事件型）。加 GitHub webhook 只需实现 `start` 并通过 `ctx.emit()` 投递，引擎、Runner、UI 都不用改。
- `AgentAdapter`：`validate` / `run(input, ctx)`。加 Claude Code 或直连 API 只需实现 `run`。
- UI 表单由 `PluginDescriptor.fields` 驱动，新插件自带表单字段。

**pi 用 RPC 模式。** 不是 `--mode json`（assistant 报错时退出码仍是 0）、不是 print（拿不到工具事件与 usage）、不是 SDK 内嵌（扩展 provider 需要 services 装配，且与宿主共享异常面）。RPC 模式能同时拿到流式事件、真实 abort、session stats，并且可以拦截扩展弹窗（否则无人值守会永久阻塞）。详见 [src/agents/pi/README.md](src/agents/pi/README.md)。

**每次触发 = 全新会话。** 一期不做会话续跑，避免上下文污染跨次任务。

**默认继承 pi 的正常环境。** 不传 `--no-extensions`，所以扩展注册的 provider（如 `pi-any-endpoint`）开箱可用；扩展弹窗会被自动应答，无人值守不会卡死。需要封闭可复现运行时，在 job 里显式写 `extensions: false`。

**错过的时间点不补跑。** 进程重启后，早于启动时刻 60s 的历史触发点直接跳过并记日志，避免一次重启炸出上百个 pi 进程。

**YAML 是真相源。** API 写入也会回写 YAML，所以 `git diff jobs/` 就是平台配置变更史。

## 目录

```
src/shared/types.ts      冻结契约（前端/后端/插件共享）
src/core/schedule.ts     cron 解析、下次触发计算、人类可读描述
src/core/scheduler.ts    tick 循环、错过判定、插件生命周期
src/core/runner.ts       队列、并发、超时、重试、运行记录
src/core/db.ts           SQLite（node:sqlite，零原生编译）
src/core/events.ts       JSONL 日志 + SSE 事件总线
src/triggers/            cron / manual 插件
src/agents/pi/           pi RPC 适配器
src/server/              Fastify REST + SSE
src/cli.ts               运维 CLI
web/                     React 控制台
jobs/                    YAML 任务声明
docs/contract.md         冻结契约（并行施工依据）
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AAAS_PORT` | 7788 | HTTP 端口 |
| `AAAS_HOST` | 127.0.0.1 | 绑定地址 |
| `AAAS_DATA_DIR` | ./data | SQLite 与运行日志 |
| `AAAS_JOBS_DIR` | ./jobs | YAML 任务目录 |
| `AAAS_DEFAULT_TZ` | Asia/Shanghai | cron 默认时区 |
| `AAAS_MAX_CONCURRENCY` | 2 | 全局并发上限 |
| `AAAS_TICK_MS` | 1000 | 调度 tick |
| `AAAS_PI_BIN` | pi | pi 可执行文件 |
| `AAAS_WEB_DIR` | web/dist | 静态 UI 目录 |

## 开发

```bash
npm run typecheck    # tsc + web typecheck
npm test             # node --test（无网络、无真实模型）
npm run check        # 两者都跑
npm run build        # 构建 web/dist
```

## 下一期路线

- `github` 触发器（webhook + HMAC 校验 + 事件过滤）
- `http` / `file` / `mq` 触发器
- `claude-code` / 直连 API 适配器
- 会话续跑（同一 job 复用 pi session）
- API Token 鉴权、多用户、任务依赖（DAG）
# protection probe
