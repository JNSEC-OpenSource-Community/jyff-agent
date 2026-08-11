# syntax=docker/dockerfile:1

# Vite+ 负责按 package.json 的 engines.node 解析并安装 Node.js。
FROM ghcr.io/voidzero-dev/vite-plus:0.2.8 AS build
WORKDIR /app

# 先只复制 workspace 清单，以复用依赖安装层。
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version* ./
COPY --chown=vp:vp apps/backend/package.json apps/backend/package.json
COPY --chown=vp:vp apps/frontend/package.json apps/frontend/package.json
COPY --chown=vp:vp packages/agents/package.json packages/agents/package.json
COPY --chown=vp:vp packages/core/package.json packages/core/package.json
COPY --chown=vp:vp packages/platform/package.json packages/platform/package.json
COPY --chown=vp:vp packages/prompts/package.json packages/prompts/package.json
COPY --chown=vp:vp packages/sandbox/package.json packages/sandbox/package.json
COPY --chown=vp:vp packages/web-access/package.json packages/web-access/package.json
RUN vp install --frozen-lockfile --ignore-scripts

COPY --chown=vp:vp tsconfig.json vite.config.ts ./
COPY --chown=vp:vp apps ./apps
COPY --chown=vp:vp packages ./packages
RUN vp build
RUN cp "$(vp env which node | head -1)" /tmp/node

# 运行时不需要 Vite+ 或任何开发依赖；必须在全新阶段执行 --prod 安装。
FROM ghcr.io/voidzero-dev/vite-plus:0.2.8 AS deps
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version* ./
COPY --chown=vp:vp apps/backend/package.json apps/backend/package.json
COPY --chown=vp:vp apps/frontend/package.json apps/frontend/package.json
COPY --chown=vp:vp packages/agents/package.json packages/agents/package.json
COPY --chown=vp:vp packages/core/package.json packages/core/package.json
COPY --chown=vp:vp packages/platform/package.json packages/platform/package.json
COPY --chown=vp:vp packages/prompts/package.json packages/prompts/package.json
COPY --chown=vp:vp packages/sandbox/package.json packages/sandbox/package.json
COPY --chown=vp:vp packages/web-access/package.json packages/web-access/package.json
RUN vp install --frozen-lockfile --prod --filter @ctf-agent/backend... --ignore-scripts

# 仅从安装阶段提取 Docker CLI，避免把 daemon 与包管理器带入运行时镜像。
FROM debian:bookworm-slim AS docker-cli
RUN apt-get update \
    && apt-get install --no-install-recommends -y docker.io \
    && rm -rf /var/lib/apt/lists/*

# 运行时镜像不包含 vp；仅保留解析出的 Node.js、应用和生产依赖。
FROM debian:bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV WEBUI_FRONTEND_DIST=/app/apps/frontend/dist

COPY --from=build /tmp/node /usr/local/bin/node
COPY --from=docker-cli /usr/bin/docker /usr/bin/docker
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages
# 生产依赖阶段也会带有 apps 目录；最后显式恢复前端产物，避免静态资源被
# 该层的 workspace 元数据覆盖而让所有请求落到 SPA fallback。
COPY --from=build /app/apps/frontend/dist ./apps/frontend/dist
RUN test -f /app/apps/frontend/dist/index.html

EXPOSE 3000 1455 53692
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "--experimental-transform-types", "apps/backend/src/main.ts"]
CMD ["--root", "/data", "--host", "0.0.0.0", "--port", "3000", "--workspace-volume", "ctf-agent-data"]
