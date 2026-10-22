# syntax=docker/dockerfile:1
# wevir-relay 的镜像（apps/relay/README.md）。在仓库根目录构建：
#   docker build -f apps/relay/Dockerfile -t wevir-relay .
# 构建阶段只装中继与它依赖的工作区包（加上根目录的构建工具），产物是 dist/ 里的一个打包好的 ESM，运行阶段不装任何依赖。

FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches ./patches
COPY packages/protocol/package.json packages/protocol/
COPY apps/relay/package.json apps/relay/
RUN pnpm install --frozen-lockfile --filter "@wevir/relay..." --filter wevir
COPY packages/protocol packages/protocol
COPY apps/relay apps/relay
RUN pnpm --filter "@wevir/relay..." build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /src/apps/relay/dist/ ./
ENV NODE_ENV=production \
    WEVIR_RELAY_PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${WEVIR_RELAY_PORT}/healthz" || exit 1
CMD ["node", "--enable-source-maps", "main.js"]
