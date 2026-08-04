FROM node:24-alpine

RUN apk add --no-cache docker-cli \
  && corepack enable
WORKDIR /app
RUN corepack pnpm config set registry https://registry.npmmirror.com

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/agents/package.json packages/agents/package.json
COPY packages/platform/package.json packages/platform/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json
COPY packages/webui/package.json packages/webui/package.json
COPY examples/ctf/package.json examples/ctf/package.json
RUN corepack pnpm install --frozen-lockfile

COPY packages/agents packages/agents
COPY packages/platform packages/platform
COPY packages/core packages/core
COPY packages/sandbox packages/sandbox
COPY packages/webui packages/webui
COPY examples/ctf examples/ctf

ENV CTF_WEBUI_HOST=0.0.0.0
ENV CTF_WEBUI_PORT=3000
ENV CTF_WEBUI_POLL_INTERVAL_MS=1000
ENV CTF_DOCKER_WORKSPACE_VOLUME=ctf-agent-data

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["corepack", "pnpm", "webui"]
