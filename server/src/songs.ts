import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * 随身曲库：上传的歌只属于上传者的这一次会话。
 *
 * - 索引 index.json 记录 id → { owner: sessionId, name }
 * - 每个人在换歌面板里只看得到自己的歌（列表按 owner 过滤）
 * - 玩家离岛（房间 onLeave）自动删掉他名下的文件
 * - 服务器重启时清空全部——歌只活在一次房间生命周期里，不积压
 *
 * 文件本身仍按 id 下发：别人靠近你时能听到你正在播的歌（这是岛的玩法），
 * 只是他们自己的面板里看不见这首歌。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SONGS_DIR = path.resolve(__dirname, "../songs");
mkdirSync(SONGS_DIR, { recursive: true });
const INDEX_FILE = path.join(SONGS_DIR, "index.json");

const AUDIO_EXTS = [".mp3", ".m4a", ".aac", ".ogg", ".wav", ".flac"];

interface SongMeta {
  owner: string;
  name: string;
  addedAt: number;
}
type SongIndex = Record<string, SongMeta>;

function readIndex(): SongIndex {
  try {
    return JSON.parse(readFileSync(INDEX_FILE, "utf8")) as SongIndex;
  } catch {
    return {};
  }
}

function writeIndex(idx: SongIndex) {
  writeFileSync(INDEX_FILE, JSON.stringify(idx));
}

/** id 对应的音频文件名（含扩展名）；不存在返回 null */
export function songFileOf(id: number): string | null {
  const hit = readdirSync(SONGS_DIR).find(
    (f) => AUDIO_EXTS.some((e) => f.endsWith(e)) && path.basename(f, path.extname(f)) === String(id)
  );
  return hit ?? null;
}

/** 登记一首歌（文件已落盘后调用） */
export function addSong(id: number, name: string, owner: string) {
  const idx = readIndex();
  idx[String(id)] = { owner, name, addedAt: Date.now() };
  writeIndex(idx);
}

/** 某位玩家名下的歌（列表用；只报文件仍存在的） */
export function songsOfOwner(owner: string): { id: number; name: string; size: number }[] {
  const idx = readIndex();
  const out: { id: number; name: string; size: number }[] = [];
  for (const [id, meta] of Object.entries(idx)) {
    if (meta.owner !== owner) continue;
    const f = songFileOf(Number(id));
    if (!f) continue;
    out.push({ id: Number(id), name: meta.name, size: statSync(path.join(SONGS_DIR, f)).size });
  }
  return out;
}

/** 删除某位玩家名下的所有歌（离岛清理），返回删除数量 */
export function removeSongsOf(owner: string): number {
  const idx = readIndex();
  let n = 0;
  for (const [id, meta] of Object.entries(idx)) {
    if (meta.owner !== owner) continue;
    const f = songFileOf(Number(id));
    if (f) rmSync(path.join(SONGS_DIR, f), { force: true });
    delete idx[id];
    n++;
  }
  if (n > 0) writeIndex(idx);
  return n;
}

/** 清空曲库（服务器重启：上一轮会话的歌全部作废） */
export function clearAllSongs(): number {
  let n = 0;
  for (const f of readdirSync(SONGS_DIR)) {
    if (f === "index.json") continue;
    rmSync(path.join(SONGS_DIR, f), { force: true });
    n++;
  }
  writeIndex({});
  return n;
}
