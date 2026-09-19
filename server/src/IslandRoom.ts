import { Room, Client } from "colyseus";
import { IslandState, Player } from "./state.js";

const ISLAND_RADIUS = 58;
const MAX_NAME_LEN = 12;
const AVATARS = new Set(["classic", "hooded", "minion", "corgi", "duck", "platypus", "seal", "owl"]);

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/**
 * 渐强之岛——单房间大岛。
 * 同步的内容刻意保持极小：位置、朝向、动作、正在听的曲目与起始时间。
 * 音频流不经过服务器，各客户端按 (trackId, startedAt) 本地对齐播放。
 */
export class IslandRoom extends Room {
  state = new IslandState();
  patchRate = 50; // 20Hz 状态广播

  onCreate() {
    this.maxClients = 64;

    // 周期性对时，客户端用它把别人的 startedAt 换算成本地播放相位
    this.clock.setInterval(() => {
      this.broadcast("time", { t: Date.now() });
    }, 5000);

    console.log("[island] 渐强之岛已就绪");
  }

  async onJoin(client: Client, options: any) {
    const name =
      typeof options?.name === "string" && options.name.trim().length > 0
        ? options.name.trim().slice(0, MAX_NAME_LEN)
        : "旅人";

    const angle = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * 5;

    const player = new Player();
    player.name = name;
    player.x = Math.cos(angle) * r;
    player.z = Math.sin(angle) * r;
    player.hue = Math.floor(Math.random() * 360);
    player.avatar = AVATARS.has(options?.avatar) ? options.avatar : "classic";
    this.state.players.set(client.sessionId, player);

    client.send("time", { t: Date.now() });
    console.log(`[island] ${name} 踏上了岛 (${this.clients.length} 人在岛上)`);
  }

  async onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    this.state.players.delete(client.sessionId);
    if (player) {
      console.log(`[island] ${player.name} 离开了岛 (${this.clients.length} 人在岛上)`);
    }
  }

  messages = {
    // 客户端 10Hz 上报自身位置；服务端只做岛屿边界约束
    pos: (client: Client, m: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m?.x !== "number") return;
      const r = Math.hypot(m.x, m.z);
      if (r > ISLAND_RADIUS) {
        m.x = (m.x / r) * ISLAND_RADIUS;
        m.z = (m.z / r) * ISLAND_RADIUS;
      }
      p.x = m.x;
      p.y = clamp(m.y, 0, 40);
      p.z = m.z;
      p.ry = m.ry ?? 0;
      p.mov = clamp(m.mov | 0, 0, 4); // 0静 1走 2跑 3滑翔 4扑翼
      p.sit = !!m.sit;
    },

    // 换歌：记录曲目与服务器时间，附近的人据此本地同步播放。
    // resumeMs: 从暂停恢复时带上已播进度，断点续播。
    track: (client: Client, m: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.trackId = clamp(m?.trackId | 0, -1, 9999);
      const resumeMs = clamp(m?.resumeMs | 0, 0, 24 * 3600 * 1000);
      p.startedAt = p.trackId >= 0 ? Date.now() - resumeMs : 0;
      p.songName =
        p.trackId >= 100 && typeof m?.name === "string"
          ? m.name.trim().slice(0, 40).replace(/[\\/:*?"<>|]/g, "_")
          : "";
    },

    time: (client: Client) => {
      client.send("time", { t: Date.now() });
    },
  };
}
