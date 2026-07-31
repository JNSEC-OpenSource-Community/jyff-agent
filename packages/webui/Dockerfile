FROM node:24-alpine

RUN apk add --no-cache docker-cli \
  && corepack enable
WORKDIR /app
RUN corepack pnpm config set registry https://registry.npmmirror.com

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/solver/package.json packages/solver/package.json
COPY packages/platform-mock/package.json packages/platform-mock/package.json
COPY packages/webui/package.json packages/webui/package.json
COPY examples/mock-ctf/package.json examples/mock-ctf/package.json
RUN corepack pnpm install --frozen-lockfile

COPY packages/solver packages/solver
COPY packages/platform-mock packages/platform-mock
COPY packages/webui packages/webui
COPY examples/mock-ctf examples/mock-ctf

ENV CTF_WEBUI_HOST=0.0.0.0
ENV CTF_WEBUI_PORT=3000
ENV CTF_WEBUI_POLL_INTERVAL_MS=1000
ENV CTF_DOCKER_WORKSPACE_VOLUME=ctf-agent-data

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["corepack", "pnpm", "webui:mock"]
