FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/agents/package.json packages/agents/package.json
COPY packages/platform/package.json packages/platform/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json
COPY packages/prompts/package.json packages/prompts/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN corepack pnpm install --frozen-lockfile \
  --filter @ctf-agent/backend... --filter @ctf-agent/frontend... --ignore-scripts

COPY packages packages
COPY apps apps
RUN corepack pnpm --filter @ctf-agent/frontend build:client

FROM node:24-alpine AS dependencies

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/agents/package.json packages/agents/package.json
COPY packages/platform/package.json packages/platform/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json
COPY packages/prompts/package.json packages/prompts/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN corepack pnpm install --frozen-lockfile --prod \
  --filter @ctf-agent/backend... --ignore-scripts

COPY --from=build /app/packages packages
COPY --from=build /app/apps apps

FROM node:24-alpine

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' \
    /etc/apk/repositories \
  && apk add --no-cache docker-cli
WORKDIR /app
COPY --from=dependencies /app /app

EXPOSE 3000 1455 53692
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/health >/dev/null || exit 1

ENV WEBUI_FRONTEND_DIST=/app/apps/frontend/dist
ENTRYPOINT ["node", "--experimental-transform-types", "apps/backend/src/main.ts"]
CMD ["--root", "/data", "--host", "0.0.0.0", "--port", "3000", "--workspace-volume", "ctf-agent-data"]
