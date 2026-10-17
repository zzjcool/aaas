#!/usr/bin/env bash
# aaas QA 容器入口。
#
# 职责（按顺序）：
#   1. 自检宿主挂载是否齐全（源码 / pi 认证 / 模型目录）—— 缺一样就明确报错，
#      而不是让 QA 看到一个"能起来但 run 全失败"的服务。
#   2. 装依赖（缓存到 volume，第二次起秒开），并构建前端。
#   3. 校验 pi 可用 + 模型接入点可达。
#   4. exec 启动服务（保持 PID 1，这样 SIGTERM 能干净关停）。
set -euo pipefail

PORT="${AAAS_PORT:-7788}"
MODEL="${AAAS_E2E_MODEL:-workbuddy/hy4-preview-ioa}"
PROVIDER="${AAAS_E2E_PROVIDER:-any-endpoint}"

log()  { printf '[aaas-qa] %s\n' "$*"; }
fail() { printf '[aaas-qa] ✖ %s\n' "$*" >&2; exit 1; }

log "aaas QA container starting"

# ── 1. 挂载自检 ────────────────────────────────────────────────
[ -f /app/package.json ]     || fail "源码未挂载到 /app（make qa-up 会挂载 \$SRC:/app:ro）"
[ -f /root/.pi/agent/auth.json ] \
  || fail "pi 认证文件未挂载（期望 /root/.pi/agent/auth.json）。QA 容器靠宿主的凭据访问模型，不重新登录。"
[ -f /root/.pi/agent/models-store.json ] \
  || fail "模型目录未挂载（期望 /root/.pi/agent/models-store.json）。pi 的模型列表来自这份缓存。"
command -v pi >/dev/null 2>&1 || fail "pi 未安装（镜像构建失败？）"

log "pi $(pi --version 2>&1 | head -1)"

# ── 2. 依赖 + 前端 ─────────────────────────────────────────────
# node_modules 在 volume 上做缓存：源码是只读挂载，装不了也写不进去。
cd /app
if [ ! -d node_modules/.bin ] || [ ! -f node_modules/.aaas-install-stamp ]; then
  log "安装后端依赖（首次较慢，之后走 volume 缓存）"
  npm ci --no-audit --no-fund
  touch node_modules/.aaas-install-stamp
else
  log "复用已缓存的后端依赖"
fi

if [ ! -d web/node_modules/.bin ] || [ ! -f web/node_modules/.aaas-install-stamp ]; then
  log "安装前端依赖"
  npm --prefix web ci --no-audit --no-fund
  touch web/node_modules/.aaas-install-stamp
fi

# 前端永远现编：QA 要看的就是当前源码的 UI。
if [ ! -f web/dist/index.html ]; then
  log "构建前端"
  npm --prefix web run build
else
  log "复用 web/dist（make 目标会随源码重建）"
fi

# ── 3. 模型接入点自检 ──────────────────────────────────────────
# 接入点跑在宿主进程上（--network=host 才能访问到）。这里用 auth.json 里记录的
# baseUrl 直接探活，失败时给出可执行的排查提示而不是让第一次 run 神秘失败。
BASE_URL="$(node -e '
const fs = require("fs");
try {
  const auth = JSON.parse(fs.readFileSync("/root/.pi/agent/auth.json", "utf8"));
  const entry = auth["any-endpoint"] ?? auth;
  process.stdout.write(typeof entry?.baseUrl === "string" ? entry.baseUrl : "");
} catch { process.stdout.write(""); }
' 2>/dev/null || true)"

if [ -n "$BASE_URL" ]; then
  if curl -sf -m 8 "${BASE_URL%/}/models" >/dev/null 2>&1; then
    log "模型接入点可达: $BASE_URL"
  else
    log "⚠ 接入点不可达: $BASE_URL"
    log "  检查宿主进程是否在跑，且容器用了 --network=host（Makefile 已设置）"
    log "  job 仍能创建，但 run 会失败并写明原因"
  fi
else
  log "⚠ auth.json 里没有 baseUrl，跳过接入点探活"
fi

log "默认模型: $MODEL [$PROVIDER]"

# ── 3b. jobs 目录 ─────────────────────────────────────────────
# 源码只读挂载，而 job 的真相源是 jobs/*.yaml —— QA 通过 UI 建 job 需要写权限。
# 所以 jobs 落在可写 volume 上，启动时把仓库里的示例 job 播种进去（只补缺失
# 的，不覆盖 QA 已改过的）。
if [ -d /app/jobs ]; then
  mkdir -p /jobs
  seeded=0
  for f in /app/jobs/*.yaml /app/jobs/*.yml; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    if [ ! -e "/jobs/${base}" ]; then
      cp "$f" "/jobs/${base}"
      seeded=$((seeded + 1))
    fi
  done
  log "jobs 目录: /jobs（可写，已播种 ${seeded} 个示例）"
fi

# ── 4. 启动 ────────────────────────────────────────────────────
log "启动 aaas on 0.0.0.0:${PORT}"
exec node --import tsx src/server/main.ts
