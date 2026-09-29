# 音遇服务端 · 生产镜像
# 构建上下文 = 仓库根目录：docker build -f server/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npx tsc --noEmit && echo "typecheck passed"

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Colyseus 的 @type() 装饰器需要 legacy 语义：tsx 直跑时这两个必须显式开
# （本地 dev 走 tsconfig 没事；容器里 esbuild 编译 TS 不读 tsconfig 的这两个字段）
ENV TSX_TSCONFIG_PATH=/app/tsconfig.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
# 曲库持久化卷挂这里（上传的歌重启不丢）
RUN mkdir -p /app/songs
VOLUME /app/songs
EXPOSE 2567
# 健康检查：HTTP 根路径 200
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:2567/ >/dev/null || exit 1
CMD ["npx", "tsx", "src/index.ts"]
