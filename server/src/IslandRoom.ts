import { Room, Client } from "colyseus";
import { IslandState, Player, Furniture } from "./state.js";
import { clearAllSongs, removeSongsOf } from "./songs.js";

const ISLAND_RADIUS = 58;
const MAX_NAME_LEN = 12;
const AVATARS = new Set(["classic", "hooded", "minion", "corgi", "duck", "platypus", "seal", "owl", "elaina"]);

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/**
 * 音遇——单房间大岛。
 * 同步的内容刻意保持极小：位置、朝向、动作、正在听的曲目与起始时间。
 * 音频流不经过服务器，各客户端按 (trackId, startedAt) 本地对齐播放。
 */
export class IslandRoom extends Room {
  state = new IslandState();
  patchRate = 50; // 20Hz 状态广播
  /** 牵手邀请：被邀人 sessionId → { from, at }；15 秒未回应自动失效 */
  private pendingHands = new Map<string, { from: string; at: number }>();
  /** 聊天防刷屏：sessionId → 上次发言时间 */
  private lastChatOf = new Map<string, number>();
  /** 表情防刷屏 */
  private lastEmoteOf = new Map<string, number>();
  /** 乐器音符限流窗口：sessionId → {窗口起点, 计数} */
  private noteWindow = new Map<string, { at: number; n: number }>();

  onCreate() {
    this.maxClients = 64;

    // 随身曲库：服务器重启即清空——歌只活在一次房间生命周期里
    const cleared = clearAllSongs();
    if (cleared > 0) console.log(`[island] 清理了上一轮遗留的 ${cleared} 首歌`);

    // 周期性对时，客户端用它把别人的 startedAt 换算成本地播放相位
    this.clock.setInterval(() => {
      this.broadcast("time", { t: Date.now() });
      // 顺手清理过期的牵手邀请
      const now = Date.now();
      for (const [k, v] of this.pendingHands) if (now - v.at > 15000) this.pendingHands.delete(k);
    }, 5000);

    console.log("[island] 音遇已就绪");
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
    this.unlinkHands(client.sessionId);
    for (const [k, v] of this.pendingHands) if (k === client.sessionId || v.from === client.sessionId) this.pendingHands.delete(k);
    this.state.players.delete(client.sessionId);
    this.lastChatOf.delete(client.sessionId);
    this.lastEmoteOf.delete(client.sessionId);
    this.noteWindow.delete(client.sessionId);
    // 背包家具随人离岛收回
    this.state.furniture.delete(`${client.sessionId}:0`);
    this.state.furniture.delete(`${client.sessionId}:1`);
    // 随身曲库：离岛即带走——他上传的歌自动删除
    const removed = removeSongsOf(client.sessionId);
    if (removed > 0) console.log(`[island] ${player?.name ?? "旅人"} 离开，随身曲库的 ${removed} 首歌已收起`);
    if (player) {
      console.log(`[island] ${player.name} 离开了岛 (${this.clients.length} 人在岛上)`);
    }
  }

  /** 解除 sessionId 的牵手（双方都清空） */
  private unlinkHands(sessionId: string) {
    const p = this.state.players.get(sessionId);
    if (!p || !p.handWith) return;
    const partner = this.state.players.get(p.handWith);
    if (partner && partner.handWith === sessionId) {
      partner.handWith = "";
      partner.handLead = false;
    }
    p.handWith = "";
    p.handLead = false;
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
    // trackId 200 = 链接曲目：url 必须是 http(s) 音频直链，
    // 服务器只保存字符串供各端自行拉取，不代理、不中转任何音频流。
    track: (client: Client, m: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.trackId = clamp(m?.trackId | 0, -1, 9999);
      const resumeMs = clamp(m?.resumeMs | 0, 0, 24 * 3600 * 1000);
      let url = "";
      if (p.trackId === 200) {
        const raw = typeof m?.url === "string" ? m.url.trim() : "";
        if (/^https?:\/\/.+/i.test(raw) && raw.length <= 500 && !/[<>"']/i.test(raw)) {
          url = raw;
        } else {
          p.trackId = -1;
        }
      }
      p.songUrl = url;
      p.startedAt = p.trackId >= 0 ? Date.now() - resumeMs : 0;
      p.songName =
        p.trackId >= 100 && typeof m?.name === "string"
          ? m.name.trim().slice(0, 40).replace(/[\\/:*?"<>|]/g, "_")
          : "";
    },

    time: (client: Client) => {
      client.send("time", { t: Date.now() });
    },

    // ---- 牵手（光遇式：邀请 → 对方同意 → 连接） ----
    "hand-invite": (client: Client, m: any) => {
      const me = this.state.players.get(client.sessionId);
      const target = typeof m?.to === "string" ? this.state.players.get(m.to) : undefined;
      const targetClient = typeof m?.to === "string" ? this.clients.find((c) => c.sessionId === m.to) : undefined;
      if (!me || !target || !targetClient || m.to === client.sessionId) return;
      if (me.handWith || target.handWith) {
        client.send("hand-busy", {});
        return;
      }
      // 必须走近才能伸手（服务器按最近上报位置校验）
      if (Math.hypot(me.x - target.x, me.z - target.z) > 16 || Math.abs(me.y - target.y) > 10) {
        client.send("hand-far", {});
        return;
      }
      // 覆盖同目标的旧邀请
      this.pendingHands.set(m.to, { from: client.sessionId, at: Date.now() });
      targetClient.send("hand-invite", { from: client.sessionId, name: me.name });
    },

    "hand-accept": (client: Client, m: any) => {
      const inv = this.pendingHands.get(client.sessionId);
      if (!inv || inv.from !== m?.to || Date.now() - inv.at > 15000) {
        this.pendingHands.delete(client.sessionId);
        return;
      }
      this.pendingHands.delete(client.sessionId);
      const a = this.state.players.get(inv.from);
      const b = this.state.players.get(client.sessionId);
      if (!a || !b || a.handWith || b.handWith) return;
      a.handWith = client.sessionId;
      a.handLead = true;
      b.handWith = inv.from;
      b.handLead = false;
    },

    "hand-reject": (client: Client, m: any) => {
      const inv = this.pendingHands.get(client.sessionId);
      if (!inv || inv.from !== m?.to) return;
      this.pendingHands.delete(client.sessionId);
      this.clients.find((c) => c.sessionId === inv.from)?.send("hand-reject", {
        name: this.state.players.get(client.sessionId)?.name ?? "旅人",
      });
    },

    "hand-release": (client: Client) => {
      this.unlinkHands(client.sessionId);
    },

    // 头顶聊天气泡：只广播给在场的人，不落任何历史（没有大厅）。
    // 客户端按距离决定是否显示（光遇式就近可闻）；服务器只做长度与频率约束
    chat: (client: Client, m: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const text = typeof m?.text === "string" ? m.text.trim().slice(0, 80) : "";
      if (!text) return;
      const now = Date.now();
      if (now - (this.lastChatOf.get(client.sessionId) ?? 0) < 900) return;
      this.lastChatOf.set(client.sessionId, now);
      this.broadcast("chat", { id: client.sessionId, name: p.name, text });
    },

    // 动作轮盘表情：转发给附近的人（自己不回声，本地直接播）
    emote: (client: Client, m: any) => {
      const name = typeof m?.name === "string" ? m.name : "";
      if (!/^(wave|bow|nod|stretch|cheer|heart)$/.test(name)) return;
      const now = Date.now();
      if (now - (this.lastEmoteOf.get(client.sessionId) ?? 0) < 300) return;
      this.lastEmoteOf.set(client.sessionId, now);
      this.broadcast("emote", { id: client.sessionId, name }, { except: client });
    },

    // 乐器音符：转发给其他人（弹的人本地已经响过）；每秒最多 20 个音
    note: (client: Client, m: any) => {
      const k = m?.k | 0;
      const midi = m?.m | 0;
      if (k < 0 || k > 2 || midi < 21 || midi > 108) return;
      const now = Date.now();
      const w = this.noteWindow.get(client.sessionId) ?? { at: now, n: 0 };
      if (now - w.at > 1000) {
        w.at = now;
        w.n = 0;
      }
      w.n++;
      this.noteWindow.set(client.sessionId, w);
      if (w.n > 20) return;
      this.broadcast("note", { id: client.sessionId, k, m: midi, v: Math.min(1, Math.max(0, +m?.v || 0.8)) }, { except: client });
    },

    // ---- 背包家具（椅子/双人秋千）：每人每件只能放一个，收回才能再放 ----
    "furn-place": (client: Client, m: any) => {
      const kind = m?.kind | 0;
      if (kind !== 0 && kind !== 1) return;
      if (typeof m?.x !== "number" || typeof m?.z !== "number") return;
      const r = Math.hypot(m.x, m.z);
      if (r > ISLAND_RADIUS - 2) return; // 别放到岛外
      const key = `${client.sessionId}:${kind}`;
      if (this.state.furniture.has(key)) return; // 已放着：必须先收回
      const f = new Furniture();
      f.owner = client.sessionId;
      f.kind = kind;
      f.x = m.x;
      f.y = clamp(m.y, 0, 40);
      f.z = m.z;
      f.ry = typeof m?.ry === "number" ? m.ry : 0;
      this.state.furniture.set(key, f);
    },

    "furn-remove": (client: Client, m: any) => {
      const kind = m?.kind | 0;
      if (kind !== 0 && kind !== 1) return;
      this.state.furniture.delete(`${client.sessionId}:${kind}`);
    },
  };
}
