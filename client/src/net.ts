import { Client } from "@colyseus/sdk";
import type { RemotePlayers } from "./remote";
import { terrainHeight } from "./heightfield";

/**
 * Colyseus 联机：进入 "island" 房间，把 Schema 状态 diff 进 RemotePlayers。
 * 连不上时返回 null，主流程自动降级为 NPC 漫游演示模式。
 */

interface PlayerLike {
  name: string;
  x: number;
  y: number;
  z: number;
  ry: number;
  mov: number;
  sit: boolean;
  trackId: number;
  startedAt: number;
  songName: string;
  hue: number;
}

export interface NetHandle {
  sessionId: string;
  /** 服务器时间 - 本地时间（把别人的 startedAt 换算到本地时钟） */
  clockOffset: number;
  sendPos: (p: { x: number; y: number; z: number; ry: number; mov: number; sit: boolean }) => void;
  sendTrack: (trackId: number, name?: string, resumeMs?: number) => void;
  close: () => void;
}

export async function connectIsland(name: string, remotes: RemotePlayers): Promise<NetHandle | null> {
  const endpoint = import.meta.env.DEV ? "http://localhost:2567" : window.location.origin;
  const client = new Client(endpoint);

  let room: any;
  try {
    room = await Promise.race([
      client.joinOrCreate("island", { name }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("连接超时")), 6000)),
    ]);
  } catch (e) {
    console.warn("[net] 无法连上渐强之岛，进入独自漫游模式", e);
    return null;
  }

  let clockOffset = 0;
  const applyTime = (t: number) => {
    const sample = t - Date.now();
    // 取延迟最小（绝对值最大偏保守，这里取最新即可）的样本
    clockOffset = sample;
  };
  room.onMessage("time", ({ t }: { t: number }) => applyTime(t));

  let selfHue: number | null = null;
  const getSelfHue = () => selfHue;

  const seen = new Set<string>();

  const ingest = () => {
    const players: Map<string, PlayerLike> = room.state.players;
    players.forEach((p: PlayerLike, key: string) => {
      if (key === room.sessionId) {
        if (selfHue === null) selfHue = p.hue;
        return;
      }
      if (!seen.has(key)) {
        seen.add(key);
        remotes.spawn(key, { name: p.name, hue: p.hue, trackId: p.trackId, startedAt: p.startedAt, x: p.x, y: p.y, z: p.z, ry: p.ry });
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
  };
  room.onStateChange(ingest);

  room.onLeave(() => console.warn("[net] 已离开房间"));
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
    sendTrack(trackId, name, resumeMs) {
      room.send("track", { trackId, name, resumeMs });
    },
    close() {
      room.leave(true);
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
