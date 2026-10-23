# syntax=docker/dockerfile:1
# wevir-push 的镜像（apps/push/README.md）。在仓库根目录构建：
#   docker build -f apps/push/Dockerfile -t wevir-push .
# 构建阶段只装网关与它依赖的工作区包（加上根目录的构建工具），产物是 dist/ 里的一个打包好的 ESM，运行阶段不装任何依赖。
# APNs 与 FCM 的凭据不进镜像：运行时挂载文件或用环境变量（README 的“配置”）。

FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches ./patches
COPY packages/protocol/package.json packages/protocol/
COPY apps/push/package.json apps/push/
RUN pnpm install --frozen-lockfile --filter "@wevir/push..." --filter wevir
COPY packages/protocol packages/protocol
COPY apps/push apps/push
RUN pnpm --filter "@wevir/push..." build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /src/apps/push/dist/ ./
COPY --from=build /src/apps/push/LICENSES ./LICENSES
ENV NODE_ENV=production \
    WEVIR_PUSH_PORT=8080 \
    WEVIR_PUSH_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${WEVIR_PUSH_PORT}/healthz" || exit 1
CMD ["node", "--enable-source-maps", "main.js"]
