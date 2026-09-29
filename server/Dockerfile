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
# tsx 直接跑 TS（服务端体量小，省掉编译产物同步问题）
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
# 曲库持久化卷挂这里（上传的歌重启不丢）
RUN mkdir -p /app/songs
VOLUME /app/songs
EXPOSE 2567
# 健康检查：HTTP 根路径 200
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:2567/ >/dev/null || exit 1
CMD ["npx", "tsx", "src/index.ts"]
