import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import express from "express";
import { defineServer, defineRoom } from "colyseus";
import { IslandRoom } from "./IslandRoom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");

// 共享曲库目录：用户上传的歌曲落在这里，附近的人按需拉取本地同步播放
const SONGS_DIR = path.resolve(__dirname, "../songs");
mkdirSync(SONGS_DIR, { recursive: true });

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

const server = defineServer({
  rooms: {
    island: defineRoom(IslandRoom),
  },
  express: (app) => {
    // 上传：POST /songs/upload?name=歌名  (原始音频字节)
    app.post("/songs/upload", express.raw({ type: () => true, limit: "40mb" }), (req, res) => {
      const name = String(req.query.name ?? "未命名").slice(0, 40).replace(/[\\/:*?"<>|]/g, "_");
      const body = req.body as Buffer;
      if (!body || body.length < 1024) {
        res.status(400).json({ error: "文件为空或太小" });
        return;
      }
      const ext = path.extname(name).toLowerCase() || ".mp3";
      if (!MIME[ext]) {
        res.status(400).json({ error: "暂不支持这个格式，试试 mp3 / ogg / wav / m4a / flac" });
        return;
      }
      // 短数字 id：与房间里的 trackId(100+id) 直接互转
      let id = 0;
      for (let tries = 0; tries < 5; tries++) {
        const candidate = String(crypto.randomInt(1, 9000));
        if (!readdirSync(SONGS_DIR).some((f) => path.basename(f, path.extname(f)) === candidate)) {
          id = Number(candidate);
          break;
        }
      }
      if (!id) {
        res.status(500).json({ error: "曲库已满" });
        return;
      }
      const file = path.join(SONGS_DIR, id + ext);
      writeFile(file, body)
        .then(() => res.json({ id, name }))
        .catch((e: Error) => res.status(500).json({ error: e.message }));
    });

    // 曲库列表
    app.get("/songs/list", (_req, res) => {
      const songs = readdirSync(SONGS_DIR)
        .filter((f) => Object.keys(MIME).some((e) => f.endsWith(e)))
        .map((f) => ({
          id: Number(path.basename(f, path.extname(f))),
          name: path.basename(f),
          size: statSync(path.join(SONGS_DIR, f)).size,
        }));
      res.json(songs);
    });

    // 文件下发
    app.get("/songs/file/:id", (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).end();
        return;
      }
      const hit = readdirSync(SONGS_DIR).find((f) => Number(path.basename(f, path.extname(f))) === id);
      if (!hit) {
        res.status(404).end();
        return;
      }
      res.setHeader("Content-Type", MIME[path.extname(hit)] ?? "application/octet-stream");
      res.sendFile(path.join(SONGS_DIR, hit));
    });

    if (existsSync(clientDist)) {
      app.use(express.static(clientDist));
    }
  },
});

const port = Number(process.env.PORT || 2567);
server.listen(port);
console.log(`[crescendo] 渐强之岛 · 服务端已启动 → ws://0.0.0.0:${port}`);
