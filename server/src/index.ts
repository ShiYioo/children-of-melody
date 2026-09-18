import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import express from "express";
import { defineServer, defineRoom } from "colyseus";
import { IslandRoom } from "./IslandRoom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");

const server = defineServer({
  rooms: {
    island: defineRoom(IslandRoom),
  },
  // 生产环境：同一个端口顺带托管前端静态文件，部署只需暴露一个端口
  express: (app) => {
    if (existsSync(clientDist)) {
      app.use(express.static(clientDist));
    }
  },
});

const port = Number(process.env.PORT || 2567);
server.listen(port);
console.log(`[crescendo] 渐强之岛 · 服务端已启动 → ws://0.0.0.0:${port}`);
