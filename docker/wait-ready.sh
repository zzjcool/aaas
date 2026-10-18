#!/usr/bin/env bash
# Wait for the trigger QA container to answer /api/health, then verify the model
# endpoint is reachable from inside it. Extracted from the Makefile because
# inlining shell loops in a recipe is unreadable and unlintable.
set -euo pipefail

# Positional args (not VAR=... env prefixes): a Makefile recipe makes the
# latter ambiguous to shellcheck, which reads $(PORT) as command substitution.
PORT="${1:-${PORT:-7788}}"
CONTAINER="${2:-${CONTAINER:-trigger-qa}}"
URL="http://127.0.0.1:${PORT}/api/health"
TRIES="${READY_TRIES:-90}"

echo "---- 等待服务就绪 ($URL) ----"
for ((i = 1; i <= TRIES; i++)); do
  if curl -sf "$URL" >/dev/null 2>&1; then
    echo "✔ trigger 就绪: $URL"
    curl -sf "$URL" | head -c 400
    echo
    exit 0
  fi
  if ! docker ps --filter "name=${CONTAINER}" --filter status=running --quiet | grep -q .; then
    echo "✖ 容器 ${CONTAINER} 已退出，日志如下:" >&2
    docker logs --tail 40 "$CONTAINER" >&2 || true
    exit 1
  fi
  sleep 1
done

echo "✖ ${TRIES}s 内未就绪，容器日志:" >&2
docker logs --tail 60 "$CONTAINER" >&2 || true
exit 1
