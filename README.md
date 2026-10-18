# trigger — 触发器驱动的 Agent 调度服务

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

## 前置要求

|依赖|要求|为什么|
|---|---|---|
|Node.js|**≥ 22.19**|用内置 `node:sqlite`，低版本跑不起来|
|前端依赖|`npm --prefix web install`|`web/` 是独立包，根目录 `npm install` **不会**装它|
|`pi`|已安装并认证|真实 run 通过 `pi --mode rpc` 子进程执行（`TRIGGER_PI_BIN` 可换路径）|
|Docker|可选|只有 `make qa-up`（QA 容器）需要|

> 示例里的 `cwd` 请改成你自己机器上的真实目录 —— 写不存在的路径会让 job
> 变成 `problem` 状态、永远不可运行。

## 快速开始

```bash
npm install
npm --prefix web install
npm run dev          # 后端 :7788 + 前端 :5173（热更新）
```

`npm run dev` 一条命令同时起后端（`tsx watch`）和前端（vite）。也可以拆成两个终端：

```bash
npm run dev:server   # 只后端 :7788
npm run dev:web      # 只前端 :5173（已配好 /api → :7788 代理）
```

生产模式（单端口，后端同时托管 UI）：

```bash
npm run build        # 生成 web/dist
npm start            # :7788
```

打开 http://127.0.0.1:5173 （dev）或 http://127.0.0.1:7788 （生产构建后）。
服务起来之后 CLI 才能连通：

```bash
npm run cli -- health
```

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
  cwd: /path/to/your/repo   # 必须存在：写错会让 job 变成 problem 且永不运行
  tools: [read, grep, find, ls]
  # provider/model 可省略 —— 继承 pi 自己的默认（本机是扩展注册的 any-endpoint）
prompt: |
  检查本仓库昨天的提交，把风险点写进 reports/daily.md。
timeoutMs: 1800000
retries: 1
```

> `cwd` 一定要换成你机器上的真实目录。路径不存在时 job 不会被拒绝，但会
> 带上 `problem: cwd: directory does not exist` 并且**永远不触发**。

立刻验证：

```bash
npm run cli -- preview --cron "0 9 * * 1-5" --tz Asia/Shanghai
npm run cli -- run nightly-repo-report --wait    # 流式跟日志直到结束
```

> 上面示例的 id 是 `nightly-repo-report`（与你新建的文件一致即可）。
> 仓库自带的示例在 `jobs/`：`hello-clock`、`nightly-repo-audit`、`weekly-report`
> （都默认 `enabled: false`，改 `true` 才会真的调度）。

## 设计要点

**后端只存时间戳。** 所有 `scheduledFor` / `nextFireAt` / `createdAt` 都是 epoch 毫秒。时区只在一处生效：把 cron 表达式翻译成时间戳的那一刻（job 级 `trigger.timezone`，默认 `TRIGGER_DEFAULT_TZ`）。UI 负责按浏览器本地时区渲染。

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

|变量|默认|说明|
|---|---|---|
|`TRIGGER_PORT`|7788|HTTP 端口|
|`TRIGGER_HOST`|127.0.0.1|绑定地址|
|`TRIGGER_DATA_DIR`|./data|SQLite 与运行日志|
|`TRIGGER_JOBS_DIR`|./jobs|YAML 任务目录|
|`TRIGGER_DEFAULT_TZ`|Asia/Shanghai|cron 默认时区|
|`TRIGGER_MAX_CONCURRENCY`|2|全局并发上限|
|`TRIGGER_TICK_MS`|1000|调度 tick|
|`TRIGGER_PI_BIN`|pi|pi 可执行文件|
|`TRIGGER_WEB_DIR`|web/dist|静态 UI 目录|

## 开发

```bash
npm run typecheck    # tsc + web typecheck
npm test             # node --test（无网络、无真实模型）
npm run check        # 两者都跑
npm run build        # 构建 web/dist
```

### 改动后怎么算验证通过

按成本递增，全绿才推：

```bash
make ci-local        # ≈ GitHub Actions：typecheck + 单测 + 覆盖率门禁
                     # + npm audit + 前端构建 + E2E + smoke
make ci-local-full   # 上面全部 + 重建 QA 镜像
```

只碰 pi 适配器 / provider / 模型参数时，额外跑真实模型：

```bash
make e2e-real        # TRIGGER_E2E_PI=real，走真实 pi（在宿主，需要接入点）
```

只碰前端或容器时：

```bash
make qa-restart      # 用当前源码重建 QA 环境
```

提交信息用 Conventional Commits（`feat:` / `fix:` / `chore:` …），正文写「为什么」。
改到 REST 路径、环境变量或引擎语义时，同一个 PR 里同步改 `docs/contract.md`。

## QA 怎么测

```bash
make qa-up           # 用当前工作区源码起环境（改完代码用 make qa-restart）
make qa-status       # 容器状态 + 健康检查
make qa-logs         # 容器日志（启动自检在这里）
make qa-shell        # 进容器排查
make qa-reset        # 清空数据卷，回到全新环境
```

起好后浏览器打开 http://127.0.0.1:7788 。

### 冒烟清单（改一次全过一遍，约 5 分钟）

|#|步骤|通过标准|
|---|---|---|
|1|打开 UI|顶栏显示版本号，`/api/health` 返回 `ok:true`|
|2|`make qa-logs`|出现「模型接入点可达」；若说不可达，job 仍能建但 run 会失败|
|3|建一个 job（UI **New job** 或写 `jobs/*.yaml`）|列表里出现，且显示下一次触发时间|
|4|点 **Run** 手动触发|run 进入 running，日志有 `spawn … --mode rpc` 行|
|5|等 run 结束|状态 `succeeded`，`resultText` 是模型的真实回答|
|6|看 run 详情|日志流完整（含工具调用 `→ tool …`），token 数 > 0|
|7|关掉再启用 job|关掉后 `nextFireAt` 为 null，不再触发|
|8|删掉 job|列表消失，`/jobs/*.yaml` 也被删除|
|9|非法输入（坏 cron、不存在的 `cwd`）|报字段级错误，不是 500，服务不崩|
|10|run 跑一半点 **Cancel**|状态变 `cancelled`，没有残留进程|

### 怎么判断「模型真的通了」

- `make qa-logs` 里 entrypoint 会打印「模型接入点可达: &lt;baseUrl&gt;」
- 跑一次真实 run，看 `resultText` 是不是模型回答（不是错误信息）
- `make qa-shell` 后 `pi --list-models` 应列出 `workbuddy/hy4-preview-ioa`

> 注意：QA 容器用 `--network=host` 且监听 `0.0.0.0`，而服务本身没有鉴权。
> 只在可信网络里跑，不要直接暴露到公网。

## 下一期路线

- `github` 触发器（webhook + HMAC 校验 + 事件过滤）
- `http` / `file` / `mq` 触发器
- `claude-code` / 直连 API 适配器
- 会话续跑（同一 job 复用 pi session）
- API Token 鉴权、多用户、任务依赖（DAG）
