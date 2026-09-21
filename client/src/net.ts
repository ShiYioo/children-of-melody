import { Client } from "@colyseus/sdk";
import type { RemotePlayers } from "./remote";
import { terrainHeight } from "./heightfield";
import type { AvatarModel } from "./avatar";

/**
 * Colyseus 联机：进入 "island" 房间，把 Schema 状态 diff 进 RemotePlayers。
 * 连不上时返回 null，主流程自动降级为 NPC 漫游演示模式。
 */

interface FurnLike {
  owner: string;
  kind: number;
  x: number;
  y: number;
  z: number;
  ry: number;
}

interface PlayerLike {  name: string;
  x: number;
  y: number;
  z: number;
  ry: number;
  mov: number;
  sit: boolean;
  trackId: number;
  startedAt: number;
  songName: string;
  songUrl?: string;
  hue: number;
  avatar: AvatarModel;
  handWith?: string;
  handLead?: boolean;
}

/** 牵手相关的服务器事件（经 connectIsland 注入回调） */
export interface HandEvents {
  /** 有人向我伸手（15 秒内有效） */
  onInvite: (from: string, name: string) => void;
  /** 我的邀请/牵手状态变化的结果提示（busy/far/reject） */
  onResult: (kind: "busy" | "far" | "reject", name?: string) => void;
  /** 自己的牵手状态变化（服务器权威） */
  onHandChange: (withId: string, lead: boolean) => void;
}

export interface NetHandle {
  sessionId: string;
  /** 服务器时间 - 本地时间（把别人的 startedAt 换算到本地时钟） */
  clockOffset: number;
  /** 最近一次探针的往返毫秒数（0 = 还没测到） */
  ping: number;
  sendPos: (p: { x: number; y: number; z: number; ry: number; mov: number; sit: boolean }) => void;
  sendTrack: (trackId: number, name?: string, resumeMs?: number, url?: string) => void;
  sendChat: (text: string) => void;
  sendEmote: (name: string) => void;
  sendNote: (kind: number, midi: number, vel: number) => void;
  sendFlower: (to: string) => void;
  sendFurnPlace: (kind: number, x: number, y: number, z: number, ry: number) => void;
  sendFurnRemove: (kind: number) => void;
  sendHandInvite: (to: string) => void;
  sendHandAccept: (to: string) => void;
  sendHandReject: (to: string) => void;
  sendHandRelease: () => void;
  close: () => void;
}

export async function connectIsland(
  name: string,
  remotes: RemotePlayers,
  avatar: AvatarModel = "classic",
  hand: HandEvents = { onInvite: () => {}, onResult: () => {}, onHandChange: () => {} },
  /** 收到聊天（自己发的也会回声回来；由调用方决定远近是否显示） */
  onChat: (from: string, name: string, text: string) => void = () => {},
  /** 别人做了表情动作（发送者本地已播，不回声） */
  onEmote: (from: string, name: string) => void = () => {},
  /** 别人弹了一个乐器音符（弹的人本地已响，不回声） */
  onNote: (from: string, kind: number, midi: number, vel: number) => void = () => {},
  onFlower: (from: string) => void = () => {},
  /** 家具增删：data 为 null 表示删除 */
  onFurn: (key: string, data: { owner: string; kind: number; x: number; y: number; z: number; ry: number } | null) => void = () => {},
  /** 非主动关闭的掉线（网络闪断/服务器重启），主循环据此自动重连 */
  onDrop: () => void = () => {},
  /** 延迟探针：每 2 秒回报一次往返毫秒数 */
  onPing: (ms: number) => void = () => {}
): Promise<NetHandle | null> {
  // 开发态用「打开页面用的主机名」连实时服务：本机访问是 localhost，
  // 局域网设备访问是宿主机 IP（写死 localhost 会让手机连到它自己）
  const endpoint = import.meta.env.DEV ? `http://${window.location.hostname}:2567` : window.location.origin;
  const client = new Client(endpoint);

  let room: any;
  try {
    room = await Promise.race([
      client.joinOrCreate("island", { name, avatar }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("连接超时")), 6000)),
    ]);
  } catch (e) {
    console.warn("[net] 无法连上音遇，进入独自漫游模式", e);
    return null;
  }

  let clockOffset = 0;
  // ---- 对时：中位数滤波 + ping 探针 ----
  // 单样本会被网络尖峰污染（音乐相位瞬间错半拍），取最近 5 个样本的中位数
  const offsetSamples: number[] = [];
  const applyTime = (t: number) => {
    offsetSamples.push(t - Date.now());
    if (offsetSamples.length > 5) offsetSamples.shift();
    const sorted = [...offsetSamples].sort((a, b) => a - b);
    clockOffset = sorted[Math.floor(sorted.length / 2)];
  };
  let pingSentAt = 0;
  let pingMs = 0;
  let lastPongAt = performance.now();
  let dropped = false;
  room.onMessage("time", ({ t }: { t: number }) => {
    lastPongAt = performance.now();
    if (pingSentAt > 0) {
      pingMs = Math.max(1, Math.round(performance.now() - pingSentAt));
      pingSentAt = 0;
      onPing(pingMs);
    }
    applyTime(t);
  });
  // 心跳死信检测：TCP 半开连接（拔网线/切 Wi-Fi/服务器被杀）可能永远收不到 close 事件，
  // 靠应用层探针超时来判定掉线
  const pingTimer = setInterval(() => {
    if (performance.now() - lastPongAt > 7000) {
      if (!closedByUs && !dropped) {
        dropped = true;
        clearInterval(pingTimer);
        onDrop();
      }
      return;
    }
    try {
      pingSentAt = performance.now();
      room.send("time");
    } catch {
      /* 掉线时发送会抛，忽略 */
    }
  }, 2000);

  let lastHandWith = "";
  let lastHandLead = false;
  room.onMessage("hand-invite", (m: any) => hand.onInvite(String(m?.from ?? ""), String(m?.name ?? "旅人")));
  room.onMessage("hand-reject", (m: any) => hand.onResult("reject", m?.name));
  room.onMessage("hand-busy", () => hand.onResult("busy"));
  room.onMessage("hand-far", () => hand.onResult("far"));
  room.onMessage("chat", (m: any) => onChat(String(m?.id ?? ""), String(m?.name ?? ""), String(m?.text ?? "")));
  room.onMessage("emote", (m: any) => onEmote(String(m?.id ?? ""), String(m?.name ?? "")));
  room.onMessage("note", (m: any) => onNote(String(m?.id ?? ""), m?.k | 0, m?.m | 0, Math.min(1, Math.max(0, +m?.v || 0.8))));
    room.onMessage("flower", (m: any) => onFlower(String(m?.id ?? "")));

  let selfHue: number | null = null;
  const getSelfHue = () => selfHue;

  const seen = new Set<string>();
  const seenFurn = new Set<string>();

  const ingest = () => {
    const players: Map<string, PlayerLike> = room.state.players;
    players.forEach((p: PlayerLike, key: string) => {
      if (key === room.sessionId) {
        if (selfHue === null) selfHue = p.hue;
        if (p.handWith !== lastHandWith || !!p.handLead !== lastHandLead) {
          lastHandWith = p.handWith ?? "";
          lastHandLead = !!p.handLead;
          hand.onHandChange(lastHandWith, lastHandLead);
        }
        return;
      }
      if (!seen.has(key)) {
        seen.add(key);
        remotes.spawn(key, { name: p.name, hue: p.hue, avatar: p.avatar, trackId: p.trackId, startedAt: p.startedAt, x: p.x, y: p.y, z: p.z, ry: p.ry });
      } else {
        remotes.update(key, p as any);
      }
    });
    for (const key of seen) {
      if (!players.has(key)) {
        seen.delete(key);
        remotes.remove(key);
      }
    }
    // 家具（放置后位置不变，只处理增删）
    const furn = room.state.furniture as Map<string, FurnLike>;
    furn.forEach((f, key) => {
      if (!seenFurn.has(key)) {
        seenFurn.add(key);
        onFurn(key, { owner: f.owner, kind: f.kind, x: f.x, y: f.y, z: f.z, ry: f.ry });
      }
    });
    for (const key of seenFurn) {
      if (!furn.has(key)) {
        seenFurn.delete(key);
        onFurn(key, null);
      }
    }
  };
  room.onStateChange(ingest);

  let closedByUs = false;
  room.onLeave(() => {
    clearInterval(pingTimer);
    if (!closedByUs) onDrop();
  });
  room.onError((code: number, msg: string) => console.warn("[net] 房间错误", code, msg));

  // 请求一次对时
  room.send("time");

  let lastSent = 0;
  return {
    sessionId: room.sessionId,
    get clockOffset() {
      return clockOffset;
    },
    sendPos(p) {
      const now = performance.now();
      if (now - lastSent < 100) return;
      lastSent = now;
      room.send("pos", p);
    },
    sendTrack(trackId, name, resumeMs, url) {
      room.send("track", { trackId, name, resumeMs, url });
    },
    sendChat(text) {
      room.send("chat", { text });
    },
    sendEmote(name) {
      room.send("emote", { name });
    },
    sendNote(kind, midi, vel) {
      room.send("note", { k: kind, m: midi, v: vel });
    },
    sendFlower(to) {
      room.send("flower", { to });
    },
    sendFurnPlace(kind, x, y, z, ry) {
      room.send("furn-place", { kind, x, y, z, ry });
    },
    sendFurnRemove(kind) {
      room.send("furn-remove", { kind });
    },
    sendHandInvite(to) {
      room.send("hand-invite", { to });
    },
    sendHandAccept(to) {
      room.send("hand-accept", { to });
    },
    sendHandReject(to) {
      room.send("hand-reject", { to });
    },
    sendHandRelease() {
      room.send("hand-release", {});
    },
    close() {
      closedByUs = true;
      clearInterval(pingTimer);
      room.leave(true);
    },
    get ping() {
      return pingMs;
    },
  };
}

/** 独自漫游时的出生点（广场边） */
export function soloSpawn(): { x: number; z: number } {
  const a = Math.random() * Math.PI * 2;
  const r = 6 + Math.random() * 4;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  void terrainHeight(x, z);
  return { x, z };
}
