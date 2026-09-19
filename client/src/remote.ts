import * as THREE from "three";
import { createAvatar, type Avatar } from "./avatar";
import { trackMeta } from "./audio/tracks";
import { terrainHeight } from "./heightfield";
import type { AvatarModel } from "./avatar";

/**
 * 岛上的其他人（网络玩家与演示 NPC 共用同一套管线）：
 * 网络位置 → 平滑插值 → 小人动画 → 音乐光环能量。
 */
export interface RemoteInfo {
  key: string;
  name: string;
  trackId: number;
  trackName: string;
  color: THREE.Color;
  dist: number;
  clarity: number;
}
interface Entry {
  key: string;
  avatar: Avatar;
  target: { x: number; y: number; z: number; ry: number; mov: number; sit: boolean };
  name: string;
  hue: number;
  trackId: number;
  startedAt: number;
  songName: string;
  songUrl: string; // 链接曲目的直链
  handWith: string; // 牵手对象 key（渲染光带用）
  speed: number; // 推算的移动速度（用于动画）
  lastPos: THREE.Vector3;
  lastY: number; // 上一帧 y（估算垂直速度）
  clarity: number;
  wasNear: boolean;
  wasAir: number; // 上一帧的空中状态（0/1/2）
  wasMov: number; // 上一帧 mov（检测扑翼沿）
}

export class RemotePlayers {
  private entries = new Map<string, Entry>();
  private fx: { burst: (pos: THREE.Vector3, color: THREE.Color, kind: "flap" | "land") => void; sfxFlap: () => void; sfxLand: () => void } | null = null;

  /** 注入光效与音效（由主循环提供） */
  bindFX(fx: { burst: (pos: THREE.Vector3, color: THREE.Color, kind: "flap" | "land") => void; sfxFlap: () => void; sfxLand: () => void }) {
    this.fx = fx;
  }

  spawn(key: string, data: { name: string; hue: number; avatar?: AvatarModel; trackId?: number; startedAt?: number; songName?: string; x: number; y: number; z: number; ry?: number }) {
    if (this.entries.has(key)) return;
    const avatar = createAvatar({ name: data.name, hue: data.hue, model: data.avatar });
    avatar.group.position.set(data.x, data.y, data.z);
    avatar.group.rotation.y = data.ry ?? 0;
    this.sceneAdd(avatar.group);
    this.entries.set(key, {
      key,
      avatar,
      target: { x: data.x, y: data.y, z: data.z, ry: data.ry ?? 0, mov: 0, sit: false },
      name: data.name,
      hue: data.hue,
      trackId: data.trackId ?? -1,
      startedAt: data.startedAt ?? 0,
      songName: data.songName ?? "",
      songUrl: "",
      handWith: "",
      speed: 0,
      lastPos: new THREE.Vector3(data.x, data.y, data.z),
      lastY: data.y,
      clarity: 0,
      wasNear: false,
      wasAir: 0,
      wasMov: 0,
    });
  }

  remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.sceneRemove(e.avatar.group);
    e.avatar.dispose();
    this.entries.delete(key);
  }

  has(key: string) {
    return this.entries.has(key);
  }

  /** 取某个远端玩家的头像（聊天气泡等直接作用于角色的效果用） */
  avatarOf(key: string): Avatar | null {
    return this.entries.get(key)?.avatar ?? null;
  }

  startedAtOf(key: string): number {
    return this.entries.get(key)?.startedAt ?? 0;
  }

  songNameOf(key: string): string {
    return this.entries.get(key)?.songName ?? "";
  }

  songUrlOf(key: string): string {
    return this.entries.get(key)?.songUrl ?? "";
  }

  /** 网络状态写入目标值 */
  update(key: string, data: Partial<{ x: number; y: number; z: number; ry: number; mov: number; sit: boolean; name: string; hue: number; trackId: number; startedAt: number; songName: string; songUrl: string; handWith: string }>) {
    const e = this.entries.get(key);
    if (!e) return false;
    Object.assign(e.target, {
      x: data.x ?? e.target.x,
      y: data.y ?? e.target.y,
      z: data.z ?? e.target.z,
      ry: data.ry ?? e.target.ry,
      mov: data.mov ?? e.target.mov,
      sit: data.sit ?? e.target.sit,
    });
    if (data.name !== undefined && data.name !== e.name) {
      e.name = data.name;
      e.avatar.setName(data.name);
    }
    if (data.trackId !== undefined) e.trackId = data.trackId;
    if (data.startedAt !== undefined) e.startedAt = data.startedAt;
    if (data.songName !== undefined) e.songName = data.songName;
    if (data.songUrl !== undefined) e.songUrl = data.songUrl;
    if (data.handWith !== undefined) e.handWith = data.handWith;
    return true;
  }

  // ---- 牵手支持：主循环查询与驱动 ----
  /** 某人的渲染位置（插值后） */
  posOf(key: string): THREE.Vector3 | null {
    return this.entries.get(key)?.avatar.group.position ?? null;
  }

  /** 某人的朝向 / 动作码 / 牵手对象 */
  statsOf(key: string): { yaw: number; mov: number; handWith: string; name: string } | null {
    const e = this.entries.get(key);
    if (!e) return null;
    return { yaw: e.avatar.group.rotation.y, mov: e.target.mov, handWith: e.handWith, name: e.name };
  }

  /** 给某个远程小人设置伸手指向（牵手姿势，世界方向） */
  setHandOf(key: string, dir: THREE.Vector3 | null) {
    this.entries.get(key)?.avatar.setHand(dir);
  }

  /** 遍历所有远程玩家（牵手光带配对用） */
  forEachRemote(cb: (key: string, pos: THREE.Vector3, yaw: number, handWith: string) => void) {
    for (const e of this.entries.values()) {
      cb(e.key, e.avatar.group.position, e.avatar.group.rotation.y, e.handWith);
    }
  }

  /** NPC 直接驱动（绕过网络状态） */
  drive(key: string, fn: (e: { pos: THREE.Vector3; target: Entry["target"] }) => void) {
    const e = this.entries.get(key);
    if (!e) return;
    fn({ pos: e.avatar.group.position, target: e.target });
  }

  /** @returns 每个人的距离信息（供音频混音与 UI） */
  infos(selfPos: THREE.Vector3): RemoteInfo[] {
    const out: RemoteInfo[] = [];
    for (const e of this.entries.values()) {
      const dist = e.avatar.group.position.distanceTo(selfPos);
      const meta = trackMeta(e.trackId, e.songName, e.songUrl);
      out.push({
        key: e.key,
        name: e.name,
        trackId: e.trackId,
        trackName: meta.name,
        color: new THREE.Color(meta.color),
        dist,
        clarity: e.clarity,
      });
    }
    return out;
  }

  /** 每帧：插值 + 动画 + 光环（beatMap 提供每个 key 的实时节拍能量） */
  animate(dt: number, t: number, clarityMap: Map<string, number>, beatMap?: Map<string, number>): RemoteInfo[] {
    const k = Math.min(1, dt * 10);
    for (const e of this.entries.values()) {
      const g = e.avatar.group;
      g.position.x = THREE.MathUtils.lerp(g.position.x, e.target.x, k);
      g.position.y = THREE.MathUtils.lerp(g.position.y, e.target.y, k);
      g.position.z = THREE.MathUtils.lerp(g.position.z, e.target.z, k);

      let dy = e.target.ry - g.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const yawStep = dy * k;
      g.rotation.y += yawStep;

      e.speed = g.position.distanceTo(e.lastPos) / Math.max(dt, 1e-4);
      e.lastPos.copy(g.position);

      // mov → 空中状态: 3 滑翔 / 4 扑翼(按滑翔处理)；离地高度也作为空中判据
      const air = e.target.mov >= 3 ? 2 : g.position.y - terrainHeight(g.position.x, g.position.z) > 0.6 ? 1 : 0;
      const selfDist = this.selfPos ? g.position.distanceTo(this.selfPos) : 999;
      if (e.wasAir > 0 && air === 0) {
        e.avatar.land(); // 落地缓冲
        if (this.fx && selfDist < 60) {
          this.fx.burst(g.position.clone(), new THREE.Color(trackMeta(e.trackId, e.songName, e.songUrl).color), "land");
          if (selfDist < 22) this.fx.sfxLand();
        }
      }
      if (e.target.mov === 4 && e.wasMov !== 4) {
        e.avatar.flap();
        if (this.fx && selfDist < 22) this.fx.sfxFlap();
        if (this.fx && selfDist < 60) {
          this.fx.burst(g.position.clone(), new THREE.Color(trackMeta(e.trackId, e.songName, e.songUrl).color), "flap");
        }
      }
      e.wasMov = e.target.mov;
      e.wasAir = air;

      const clarity = clarityMap.get(e.key) ?? 0;
      e.clarity = clarity;
      const meta = trackMeta(e.trackId, e.songName, e.songUrl);
      const beat = beatMap?.get(e.key) ?? 0.35;
      e.avatar.setRing(e.trackId >= 0 ? new THREE.Color(meta.color) : null, clarity * (0.45 + 0.55 * beat));
      // 垂直速度从 y 差分估算（供空中姿势分层），水平速度按朝向近似（供披风风场）。
      // 全部限幅：网络位置跳变会产生速度尖峰，巨风会把远程玩家的布料拉成丝
      const clampV = (x: number) => Math.max(-10, Math.min(10, x));
      const vyEst = clampV((g.position.y - e.lastY) / Math.max(dt, 1e-3));
      e.lastY = g.position.y;
      e.avatar.animate(dt, t, e.speed, e.target.sit, air, yawStep / Math.max(dt, 1e-4), {
        vy: vyEst,
        vx: clampV(Math.sin(g.rotation.y) * e.speed),
        vz: clampV(Math.cos(g.rotation.y) * e.speed),
      });
    }
    return [];
  }

  private sceneAdd: (o: THREE.Object3D) => void = () => {};
  private sceneRemove: (o: THREE.Object3D) => void = () => {};
  private selfPos: THREE.Vector3 | null = null;

  /** 每帧由主循环更新自己位置（供距离判断） */
  setSelfPos(p: THREE.Vector3) {
    this.selfPos = p;
  }

  bindScene(add: (o: THREE.Object3D) => void, remove: (o: THREE.Object3D) => void) {
    this.sceneAdd = add;
    this.sceneRemove = remove;
  }

  clear() {
    for (const key of [...this.entries.keys()]) this.remove(key);
  }
}

/** 从墙钟时间推算节拍包络（光环用，不依赖音频引擎） */

