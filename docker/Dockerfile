# trigger QA 容器
#
# 设计约束（决定了这个文件的形状）：
#
#  1. **不含本项目源码**。源码由 `make qa-up` 以只读 bind mount 挂到 /app，
#     这样 QA 每次拿到的都是当前工作区的最新代码，改一行不用重建镜像。
#  2. **含 pi + any-endpoint 插件**。宿主上 pi 是通过扩展注册 provider 的，
#     容器里必须装同一个插件，否则 `pi --provider any-endpoint` 不存在。
#  3. **rg/fd 预装**。否则 pi 每次会话启动都从 GitHub 下载静态二进制，
#     慢且依赖网络。
#  4. **依赖在启动时装**（entrypoint 里 npm install），缓存到 volume。
#     镜像本身不 COPY package.json，避免 npm 依赖一变就要重建镜像。
#  5. **--network=host**。模型的接入点在宿主进程上（localhost:3425），
#     桥接网络下容器访问不到。这是 SOP 里踩过的坑。
#
# 构建：make image
# 运行：make qa-up

FROM node:22-bookworm

ARG PI_VERSION=1.3.0
ARG ANY_ENDPOINT_VERSION=0.1.3

ENV DEBIAN_FRONTEND=noninteractive

# rg/fd (pi 的 read/grep 工具链依赖，缺了会每次联网下载)、curl (健康检查)、
# tzdata (Asia/Shanghai 等 cron 时区必须存在，否则 cron 求值直接失败)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      ripgrep fd-find curl ca-certificates tzdata \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# pi 本体。版本与宿主保持一致，避免 RPC 协议漂移。
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION} \
 && npm cache clean --force

# endpoint 插件：注册 any-endpoint provider（宿主也是这个包）
RUN pi install npm:pi-any-endpoint@${ANY_ENDPOINT_VERSION}

# /app  源码挂载点（只读 bind mount）
# /jobs 可写：源码只读，而 job 的真相源是 jobs/*.yaml，QA 必须能增删改
# /data 可写：SQLite + 运行日志
RUN mkdir -p /app /data /jobs

WORKDIR /app

COPY entrypoint.sh /usr/local/bin/trigger-entrypoint.sh
RUN chmod +x /usr/local/bin/trigger-entrypoint.sh

EXPOSE 7788

# 默认模型（HY4）。可被 docker run -e 覆盖。
ENV TRIGGER_E2E_MODEL=workbuddy/hy4-preview-ioa
ENV TRIGGER_E2E_PROVIDER=any-endpoint

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -sf http://127.0.0.1:${TRIGGER_PORT:-7788}/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/trigger-entrypoint.sh"]
