FROM node:24-alpine AS dependencies

RUN corepack enable
WORKDIR /app
RUN corepack pnpm config set registry https://registry.npmmirror.com

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/agents/package.json packages/agents/package.json
COPY packages/platform/package.json packages/platform/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json
COPY packages/webui/package.json packages/webui/package.json
RUN corepack pnpm install --frozen-lockfile --prod \
  --filter @ctf-agent/webui... --ignore-scripts

COPY packages packages

FROM node:24-alpine

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' \
    /etc/apk/repositories \
  && apk add --no-cache docker-cli
WORKDIR /app
COPY --from=dependencies /app /app

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/health >/dev/null || exit 1

ENTRYPOINT ["node", "--experimental-transform-types", "packages/webui/src/main.ts"]
CMD ["--root", "/data", "--host", "0.0.0.0", "--port", "3000", "--workspace-volume", "ctf-agent-data"]
