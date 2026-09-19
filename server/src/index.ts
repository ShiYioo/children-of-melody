import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import express from "express";
import { defineServer, defineRoom } from "colyseus";
import { IslandRoom } from "./IslandRoom.js";
import { SONGS_DIR, addSong, songsOfOwner, songFileOf } from "./songs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

// ---- 上传防滥用参数 ----
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // 单文件 20MB
const LIBRARY_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 全曲库 2GB
const LIBRARY_MAX_FILES = 500;
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟
const RATE_MAX_PER_IP = 3; // 每 IP 每 10 分钟最多 3 次

/** 魔数（文件头）校验：防止伪造扩展名上传可执行文件/网页等 */
function looksLikeAudio(buf: Buffer, ext: string): boolean {
  const head = buf.subarray(0, 12);
  const eq = (offset: number, s: string) => head.subarray(offset, offset + s.length).toString("latin1") === s;
  switch (ext) {
    case ".mp3":
      // ID3v2 标签或 MPEG 帧同步 (0xFF Ex)
      return eq(0, "ID3") || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case ".ogg":
      return eq(0, "OggS");
    case ".wav":
      return eq(0, "RIFF") && eq(8, "WAVE");
    case ".flac":
      return eq(0, "fLaC");
    case ".m4a":
    case ".aac":
      return eq(4, "ftyp");
    default:
      return false;
  }
}

/** 极简内存限频器（每 IP） */
const rateBuckets = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (rateBuckets.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX_PER_IP) {
    rateBuckets.set(ip, arr);
    return true;
  }
  arr.push(now);
  rateBuckets.set(ip, arr);
  return false;
}

/** 曲库当前占用 */
function libraryUsage(): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const f of readdirSync(SONGS_DIR)) {
    if (!Object.keys(MIME).some((e) => f.endsWith(e))) continue;
    bytes += statSync(path.join(SONGS_DIR, f)).size;
    files++;
  }
  return { bytes, files };
}

const server = defineServer({
  rooms: {
    island: defineRoom(IslandRoom),
  },
  express: (app) => {
    // 上传：POST /songs/upload?name=歌名&owner=会话id  (原始音频字节)
    app.post("/songs/upload", express.raw({ type: () => true, limit: `${UPLOAD_MAX_BYTES / 1024 / 1024}mb` }), (req, res) => {
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      if (rateLimited(ip)) {
        res.status(429).json({ error: "上传太频繁了，休息一下吧（10 分钟内最多 3 首）" });
        return;
      }
      const name = String(req.query.name ?? "未命名").slice(0, 40).replace(/[\\/:*?"<>|]/g, "_");
      const owner = String(req.query.owner ?? "anonymous").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "anonymous";
      const body = req.body as Buffer;
      if (!body || body.length < 1024) {
        res.status(400).json({ error: "文件为空或太小" });
        return;
      }
      if (body.length > UPLOAD_MAX_BYTES) {
        res.status(400).json({ error: "太大了，请上传 20MB 以内的歌曲" });
        return;
      }
      const ext = path.extname(name).toLowerCase() || ".mp3";
      if (!MIME[ext]) {
        res.status(400).json({ error: "暂不支持这个格式，试试 mp3 / ogg / wav / m4a / flac" });
        return;
      }
      if (!looksLikeAudio(body, ext)) {
        res.status(400).json({ error: "这个文件好像不是真正的音频哦" });
        return;
      }
      const usage = libraryUsage();
      if (usage.files >= LIBRARY_MAX_FILES || usage.bytes + body.length > LIBRARY_MAX_BYTES) {
        res.status(507).json({ error: "岛上的歌库满了，等管理员清理一下吧" });
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
        .then(() => {
          addSong(id, name, owner);
          res.json({ id, name });
        })
        .catch((e: Error) => res.status(500).json({ error: e.message }));
    });

    // 曲库列表：只返回 owner 自己上传的歌（随身曲库）
    app.get("/songs/list", (req, res) => {
      const owner = String(req.query.owner ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
      res.json(songsOfOwner(owner));
    });

    // 文件下发（任何人都可按 id 拉取——靠近你的人要能听见你正在播的歌）
    app.get("/songs/file/:id", (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).end();
        return;
      }
      const hit = songFileOf(id);
      if (!hit) {
        res.status(404).end();
        return;
      }
      res.setHeader("Content-Type", MIME[path.extname(hit)] ?? "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.sendFile(path.join(SONGS_DIR, hit));
    });

    if (existsSync(clientDist)) {
      app.use(express.static(clientDist));
    }
  },
});

const port = Number(process.env.PORT || 2567);
server.listen(port);
console.log(`[crescendo] 拾音岛 · 服务端已启动 → ws://0.0.0.0:${port}`);
