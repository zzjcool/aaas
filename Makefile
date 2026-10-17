# aaas — QA 环境一键入口
#
# 设计目标：QA 每次跑 `make qa-up` 拿到的永远是**当前工作区的最新源码**。
# 因此镜像里不放源码副本 —— 源码以只读 bind mount 挂进去，依赖在容器启动时
# 装（缓存到 volume，第二次起秒开）。改一行代码 → `make qa-restart` → 就是新的。
#
# 模型接入点（宿主机 localhost:3425）通过 --network=host 暴露给容器，
# 宿主的 pi 认证与模型目录直接挂进去，容器里无需重新登录。

SHELL := /bin/bash

IMAGE      ?= aaas-qa
CONTAINER  ?= aaas-qa
PORT       ?= 7788
# 宿主机上的项目根目录（源码挂载点）
SRC        ?= $(CURDIR)

# 宿主机 pi 配置：认证 + 模型目录 + endpoint 插件
PI_DIR     ?= $(HOME)/.pi
PI_AUTH    ?= $(PI_DIR)/agent/auth.json
PI_MODELS  ?= $(PI_DIR)/agent/models-store.json
PI_NPM     ?= $(PI_DIR)/agent/npm/node_modules

# 默认模型（HY4）
MODEL      ?= workbuddy/hy4-preview-ioa
PROVIDER   ?= any-endpoint

DOCKER     := docker
RUN_ARGS   := --rm -it
COMPOSE    := $(DOCKER) compose

# 注：qa-ps 曾声明为 .PHONY 但没有对应规则，`make qa-ps` 静默成功，
# 让人以为容器有问题。已移除；容器状态请用 qa-status。
.PHONY: help qa-up qa-down qa-restart qa-logs qa-status qa-shell
.PHONY: image test typecheck unit e2e e2e-real smoke gate coverage
.PHONY: ci-local ci-local-full web-ci build web-build clean

## help: 列出所有目标
help:
	@grep -E '^## [a-zA-Z_-]+:' $(MAKEFILE_LIST) | sed 's/^## /  /' | sort

# ─────────────────────────────────────────────────────────────
# QA 容器
# ─────────────────────────────────────────────────────────────

## image: 构建 QA 镜像（内含 pi + endpoint 插件，不含本项目源码）
image:
	$(DOCKER) build -t $(IMAGE):latest -f docker/Dockerfile docker

## qa-up: 用**当前源码**启动 QA 环境并等待就绪（默认 http://127.0.0.1:7788）
qa-up: image
	@$(DOCKER) rm -f $(CONTAINER) >/dev/null 2>&1 || true
	$(DOCKER) run -d --name $(CONTAINER) \
		--network=host \
		-e AAAS_PORT=$(PORT) \
		-e AAAS_HOST=0.0.0.0 \
		-e AAAS_DATA_DIR=/data \
		-e AAAS_JOBS_DIR=/jobs \
		-e AAAS_WEB_DIR=/app/web/dist \
		-e AAAS_DEFAULT_TZ=Asia/Shanghai \
		-e AAAS_E2E_MODEL=$(MODEL) \
		-e AAAS_E2E_PROVIDER=$(PROVIDER) \
		-v "$(SRC):/app:ro" \
		-v "$(PI_AUTH):/root/.pi/agent/auth.json:ro" \
		-v "$(PI_MODELS):/root/.pi/agent/models-store.json" \
		-v "$(PI_NPM):/root/.pi/agent/npm/node_modules:ro" \
		-v aaas-qa-data:/data \
		-v aaas-qa-jobs:/jobs \
		-v aaas-qa-nm:/app/node_modules \
		-v aaas-qa-webnm:/app/web/node_modules \
		$(IMAGE):latest
	@bash docker/wait-ready.sh "$(PORT)" "$(CONTAINER)"
	@echo "  默认模型: $(MODEL) [$(PROVIDER)]"

## qa-down: 停止并删除 QA 容器
qa-down:
	-$(DOCKER) rm -f $(CONTAINER) >/dev/null 2>&1
	@echo "✔ 已停止 $(CONTAINER)"

## qa-restart: 用最新源码重建 QA 环境（改完代码跑这个）
qa-restart: qa-down qa-up

## qa-reset: 清空数据卷，回到全新环境（清掉所有 job 与运行记录）
qa-reset: qa-down
	-$(DOCKER) volume rm aaas-qa-data aaas-qa-jobs >/dev/null 2>&1
	@echo "✔ 数据卷已清空"

## qa-logs: 跟随 QA 容器日志
qa-logs:
	$(DOCKER) logs -f $(CONTAINER)

## qa-status: 容器状态 + 健康检查
qa-status:
	@$(DOCKER) ps --filter name=$(CONTAINER) --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
	@echo "--- health ---"
	@curl -sf http://127.0.0.1:$(PORT)/api/health | head -c 400; echo

## qa-shell: 进容器排查（模型/认证/pi 是否可用）
qa-shell:
	$(DOCKER) exec -it $(CONTAINER) bash

# ─────────────────────────────────────────────────────────────
# 质量门禁（本地 == CI，同一套命令）
# ─────────────────────────────────────────────────────────────

## typecheck: TypeScript 全量类型检查
typecheck:
	npm run typecheck

## unit: 单元测试
unit:
	npm test

## e2e: L1+L2 端到端（离线，用 fake pi 跑真实 adapter）
e2e:
	npm run e2e

## e2e-real: L3 端到端（真实 pi + 真实模型，需要宿主接入点）
e2e-real:
	AAAS_E2E_PI=real npm run e2e

## smoke: 引擎冒烟（stub adapter，不走 pi）
smoke:
	npm run smoke

## coverage: 跑单测并输出覆盖率
coverage:
	node scripts/coverage-gate.mjs

## gate: 覆盖率门禁（含基线比对）
gate:
	node scripts/coverage-gate.mjs

## test: 全部门禁 —— typecheck + 单元 + 覆盖率 + E2E
test: typecheck gate smoke e2e

## ci-local: 复现 GitHub Actions 的门禁（推代码前先跑这个）
#
# 以前这行名不副实：缺 web 依赖安装（新 clone 直接红）、缺前端构建、缺
# npm audit、缺镜像构建，还把单测跑了两遍（npm test + coverage-gate 内部
# 再跑一次）。本地绿灯 ≠ CI 绿灯，正是流程信任崩掉的方式。
ci-local: web-ci
	npm ci
	npm run typecheck
	node scripts/coverage-gate.mjs
	npm audit --audit-level=high
	npm run build
	npm run test:e2e
	npm run smoke

## ci-local-full: ci-local + 重建 QA 镜像（CI 第三个 job 的完整本地版）
ci-local-full: ci-local image

## web-ci: 安装前端依赖（CI 里每个 job 都做，本地容易忘）
web-ci:
	npm --prefix web ci

# ─────────────────────────────────────────────────────────────
# 杂项
# ─────────────────────────────────────────────────────────────

## build: 构建前端（QA 容器里也会构建）
build: web-build

web-build:
	npm run build

## clean: 清理覆盖率产物
clean:
	rm -rf coverage
