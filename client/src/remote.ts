import * as THREE from "three";
import { createAvatar, type Avatar } from "./avatar";
import { trackMeta } from "./audio/tracks";
import { terrainHeight, WATER_LEVEL } from "./heightfield";
import type { AvatarModel } from "./avatar";
import { SpringV3 } from "./motion";
import { standGroundHeight } from "./colliders";

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
  posSpring: SpringV3; // 位置弹簧（网络玩家也带动作物理的重量感）
  clarity: number;
  wasNear: boolean;
  wasAir: number; // 上一帧的空中状态（0/1/2）
  wasMov: number; // 上一帧 mov（检测扑翼沿）
  // ---- 距离分级（LOD）----
  lod: LodTier; // 当前档位
  lodAt: number; // 上次换档的时间（秒，主循环 t）
  lodSig: number; // 上次扫描部件时的 group 子节点数
  lodParts: LodPart[]; // 受档位控制的部件（及其出厂可见性）
  lodKnown: Set<THREE.Object3D>; // 已识别部件（重复扫描不覆盖基准）
  lodFrame: number; // 中档降频的帧计数
  lodDt: number; // 中档累积的 dt
}

// ================================ 距离分级（LOD） ================================
/**
 * 远端玩家按距离分三档 —— 不能再用「一个完整化身服务全岛」：
 *
 *   近 ≤18m        全细节：Verlet 布料披风 + 头顶名牌 + 音乐光环 + 音符微光 + 每帧动画
 *   中 18~45m      隐藏名牌 / 光环 / 微粒，关掉布料仿真披风（只留静态后襟），动画降频到每 2 帧
 *   远 >45m        只留身体主网格（GLB 按顶点数保留前 8 个网格），姿势冻结（不跑 animate）
 *
 * 阈值带 15% 滞回（进入 18 / 45，退出 15.3 / 38.25）再叠 0.5s 最短保持：
 * 网络位置 + 弹簧平滑仍有微小抖动，单一阈值会让人在边界上反复抖档。
 *
 * 部件识别全部靠**几何体类型 + 材质类型**（avatar.ts 不给部件命名，且本次不许改它）：
 * 认不出的对象一律不碰。将来 avatar.ts 加新部件，最坏结果是「这一档没省下它」，
 * 而不是「人身上少了一块」。
 *
 * 一处做不到位、要写在明处的：「中档关掉布料仿真」实际是**隐藏仿真披风网格 +
 * 保留静态后襟**（观感=静止姿势）。CapeSim 的 step() 在 avatar.ts 内部，remote.ts
 * 关不掉它；中档让整条 animate 降频到每 2 帧，等于把这块开销减半。要真正停掉仿真，
 * 得在 avatar.ts 里加开关。
 */
type LodTier = 0 | 1 | 2;

const LOD_MID_ENTER = 18; // 近 → 中
const LOD_FAR_ENTER = 45; // 中 → 远
const LOD_HYST = 0.85; // 退出阈值 = 进入阈值 × 0.85（15% 滞回带）
const LOD_MID_EXIT = LOD_MID_ENTER * LOD_HYST; // 15.3
const LOD_FAR_EXIT = LOD_FAR_ENTER * LOD_HYST; // 38.25
const LOD_DWELL = 0.5; // 换档后最短保持（秒）
/** 远档按顶点数保留的 GLB 网格数（elaina.glb 有 125 个网格 / 30 万三角面） */
const LOD_FAR_GLB_MESHES = 8;
/** 中档动画更新间隔（帧）：dt 累积后一次推进，动画速度不变、只是少算几次 */
const LOD_MID_EVERY = 2;
/** 中档单次累积 dt 上限：卡帧/切后台回来时不要一次把弹簧和布料塞爆 */
const LOD_MAX_DT = 0.1;

/** 带滞回的档位判定：向远用「进入阈值」，向近用「退出阈值」 */
function decideTier(cur: LodTier, dist: number): LodTier {
  if (dist > LOD_FAR_ENTER) return 2;
  if (cur === 2 && dist > LOD_FAR_EXIT) return 2;
  if (dist > LOD_MID_ENTER) return 1;
  if (cur === 1 && dist > LOD_MID_EXIT) return 1;
  return 0;
}

/** 部件在 LOD 里的角色（决定各档开关） */
type LodRole =
  | "name" // 头顶名牌 Sprite
  | "bubble" // 聊天气泡 Sprite（单向：只在远档关掉，避免和「到期淡出」打架）
  | "halo" // 音乐光环：Ring/Circle 几何，或加色混合的柔光面片（两种实现都认）
  | "mote" // 音符微光 Points
  | "glow" // 头顶烛光光晕 Sprite（加色混合）
  | "detail" // 面部小件（MeshBasicMaterial：眼睛 / 腮红 / 烛光球）
  | "small" // 小半径球体（手 / 脚）——只在远档收
  | "shadow" // 接触阴影（单向：远档关；中近档交给 avatar.ts 按离地高度逐帧决定）
  | "capeOuter" // Verlet 布料披风（中档起关掉 = 改成静态姿势）
  | "capeInner" // 静态后襟
  | "glb"; // 导入模型内部网格（远档只留主网格）

interface LodPart {
  obj: THREE.Object3D;
  role: LodRole;
  base: boolean; // avatar.ts 的出厂可见性（GLB 载入成功会关掉程序化披风，必须尊重）
  keepFar: boolean; // glb：是否属于远档保留的主网格
}

/** @returns 该部件在当前档应有的可见性；null = 不碰（交给 avatar.ts 自己管） */
function lodVisible(p: LodPart, tier: LodTier, glbLoaded: boolean): boolean | null {
  // 打开时一律 `&& p.base`：出厂就是关的部件（例如自己的名牌）绝不因为 LOD 被点亮
  switch (p.role) {
    case "name":
    case "halo":
    case "mote":
      return tier === 0 && p.base;
    case "glow":
    case "detail":
    case "small":
      return tier < 2 && p.base;
    // 单向部件：只在远档强制关掉，回到中/近档不强制打开
    // （接触阴影由 avatar.ts 每帧按离地高度写，气泡由 say() 与到期逻辑写）
    case "bubble":
    case "shadow":
      return tier === 2 ? false : null;
    case "capeOuter":
      return glbLoaded ? null : tier === 0 && p.base;
    case "capeInner":
      return glbLoaded ? null : tier < 2 && p.base;
    case "glb":
      return tier < 2 ? p.base : p.keepFar && p.base;
  }
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
      posSpring: new SpringV3(60, 14).snap(new THREE.Vector3(data.x, data.y, data.z)),
      clarity: 0,
      wasNear: false,
      wasAir: 0,
      wasMov: 0,
      lod: 0,
      lodAt: -1e9, // 首帧立即定档（不受最短保持时间限制）
      lodSig: -1, // 强制首帧扫描一次部件
      lodParts: [],
      lodKnown: new Set(),
      lodFrame: 0,
      lodDt: 0,
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

  hueOf(key: string): number {
    return this.entries.get(key)?.hue ?? 150;
  }

  /** 取某个远端玩家的头像（聊天气泡等直接作用于角色的效果用） */
  avatarOf(key: string): Avatar | null {
    return this.entries.get(key)?.avatar ?? null;
  }

  /** 所有远端的位置+坐姿（秋千摆角反推、坐姿判断用） */
  sitters(): { key: string; pos: THREE.Vector3; sit: boolean }[] {
    const out: { key: string; pos: THREE.Vector3; sit: boolean }[] = [];
    for (const [key, e] of this.entries) out.push({ key, pos: e.avatar.group.position, sit: e.target.sit });
    return out;
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

  /** 是否处于坐姿（船跟随渲染要区分"乘船"和"游泳"） */
  sitOf(key: string): boolean {
    return this.entries.get(key)?.target.sit ?? false;
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
  animate(dt: number, t: number, clarityMap: Map<string, number>, beatMap?: Map<string, number>, seatedKeys?: Set<string>): RemoteInfo[] {
    for (const e of this.entries.values()) {
      const g = e.avatar.group;
      // 位置走弹簧：网络玩家同样有起步/急停的重量感（10Hz 目标步进 → 弹簧平滑+一点惯性）。
      // 大距离跳变（重连/瞬移）直接贴上，弹簧不能长距离飞掠
      this._netPos.set(e.target.x, e.target.y, e.target.z);
      if (e.posSpring.x.distanceTo(this._netPos) > 6) e.posSpring.snap(this._netPos);
      g.position.copy(e.posSpring.step(this._netPos, dt));

      let dy = e.target.ry - g.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const yawStep = dy * Math.min(1, dt * 10);
      g.rotation.y += yawStep;

      e.speed = g.position.distanceTo(e.lastPos) / Math.max(dt, 1e-4);
      e.lastPos.copy(g.position);

      // ---- 距离分级：档位判定（带 15% 滞回 + 最短保持） ----
      // 距离用**渲染位置**（弹簧平滑后的），网络目标步进的毛刺不会传导到档位上
      const selfDist = this.selfPos ? g.position.distanceTo(this.selfPos) : 999;
      const wantTier = decideTier(e.lod, selfDist);
      if (wantTier !== e.lod && t - e.lodAt >= LOD_DWELL) {
        e.lod = wantTier;
        e.lodAt = t;
      }
      const tier = e.lod;

      // mov → 空中状态: 3 滑翔 / 4 扑翼；5 是未展开披风的普通腾空。
      //
      // 判据必须用**可站表面高度**，不能用裸 `terrainHeight`：
      //  · 站在岩石 / 灯塔环廊 / 木凳上的人，y 比地面高出一大截，
      //    原来会被判成腾空 → 一直摆着下落姿势站在石头上。
      //  · 水里同理：水面在 0.55，海底可能是 -1.5，差值 2m 也会误判 ——
      //    游泳的人因此「半游半坠」。
      // 这两个是最显眼的多人穿帮，而 `standGroundHeight` 本来就算好了可站面
      // （没有可站面时返回 -Infinity，所以要跟地形取 max）。
      //
      // 远档跳过这一整块：`terrainHeight` + `standGroundHeight`（要遍历碰撞体）
      // 是每个远端每帧最贵的两项采样，而远档连动画都不跑，空中姿势没人看得见。
      // 同时把 wasAir/wasMov 清零 —— 否则从远档退回中档的那一帧会凭空补一个
      // 「落地」尘土和「扑翼」音效。
      let air = 0;
      if (tier < 2) {
        const groundY = Math.max(
          terrainHeight(g.position.x, g.position.z),
          standGroundHeight(g.position)
        );
        const inWater = g.position.y <= WATER_LEVEL + 0.35;
        air =
          e.target.mov === 3 || e.target.mov === 4
            ? 2
            : inWater || g.position.y - groundY <= 0.6
              ? 0
              : 1;

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
      } else {
        e.wasMov = 0;
        e.wasAir = 0;
        e.lodDt = 0;
      }

      // 听感清晰度（音频混音与 UI 读它）**每档都要写**：远档也不能让音量冻在旧值
      e.clarity = clarityMap.get(e.key) ?? 0;

      // ---- 动画推进：近档每帧 / 中档每 2 帧（dt 累积，动画速度不变）/ 远档冻结 ----
      e.lodFrame++;
      const animDue = tier === 0 || (tier === 1 && e.lodFrame % LOD_MID_EVERY === 0);
      if (animDue) {
        const adt = tier === 0 ? dt : Math.min(e.lodDt + dt, LOD_MAX_DT);
        e.lodDt = 0;
        const meta = trackMeta(e.trackId, e.songName, e.songUrl);
        const beat = beatMap?.get(e.key) ?? 0.35;
        e.avatar.setRing(e.trackId >= 0 ? new THREE.Color(meta.color) : null, e.clarity * (0.45 + 0.55 * beat));
        // 垂直速度从 y 差分估算（供空中姿势分层），水平速度按朝向近似（供披风风场）。
        // 全部限幅：网络位置跳变会产生速度尖峰，巨风会把远程玩家的布料拉成丝
        const clampV = (x: number) => Math.max(-10, Math.min(10, x));
        const vyEst = clampV((g.position.y - e.lastY) / Math.max(adt, 1e-3));
        e.lastY = g.position.y;
        e.avatar.animate(adt, t, e.speed, e.target.sit, air, yawStep / Math.max(dt, 1e-4), {
          vy: vyEst,
          vx: clampV(Math.sin(g.rotation.y) * e.speed),
          vz: clampV(Math.cos(g.rotation.y) * e.speed),
          seated: seatedKeys?.has(e.key) ?? false,
          // 远端无物理状态机：按浸深推断游泳；坐着（乘船/家具）不算
          swim: g.position.y < WATER_LEVEL - 0.35 && !e.target.sit,
        });
      } else {
        e.lodDt = Math.min(e.lodDt + dt, LOD_MAX_DT);
      }

      // ---- 档位 → 部件可见性。必须放在 avatar.animate 之后：
      //      接触阴影（按离地高度）与聊天气泡（到期淡出）都是 avatar.ts 每帧改写的 ----
      this.applyLod(e);
    }
    return [];
  }

  // ============================== LOD 内部实现 ==============================
  /**
   * 扫描一个化身的部件（只在 group 子节点数变化时跑：GLB 载入 / 聊天气泡出现）。
   * 已识别过的对象**不覆盖** base —— 否则「远档被我们关掉的环」会被当成出厂就是关的，
   * 回到近档就再也开不回来。
   */
  private scanParts(e: Entry) {
    const group = e.avatar.group;
    const bodyGroup = group.children[0]; // avatar.ts 里第一个 add 的就是 bodyGroup
    let nameTaken = false;
    const add = (obj: THREE.Object3D, role: LodRole, keepFar = true) => {
      if (e.lodKnown.has(obj)) return;
      e.lodKnown.add(obj);
      e.lodParts.push({ obj, role, base: obj.visible, keepFar });
    };
    const classifySprite = (s: THREE.Sprite) => {
      const mat = s.material as THREE.SpriteMaterial | undefined;
      if (mat && mat.blending === THREE.AdditiveBlending) {
        add(s, "glow"); // 头顶烛光的光晕（加色）
        return;
      }
      // 名牌 = 子节点顺序里第一个非加色 Sprite；聊天气泡是后来 append 的
      if (!nameTaken) {
        nameTaken = true;
        add(s, "name");
        return;
      }
      add(s, "bubble");
    };
    const classifyInBody = (o: THREE.Object3D) => {
      const anyO = o as unknown as { isSprite?: boolean; isMesh?: boolean };
      if (anyO.isSprite) {
        classifySprite(o as THREE.Sprite);
        return;
      }
      if (!anyO.isMesh) return;
      const m = o as THREE.Mesh;
      const geo = m.geometry as THREE.BufferGeometry & { parameters?: { radius?: number } };
      const mat = m.material as THREE.Material | undefined;
      const isToon = !!(mat as { isMeshToonMaterial?: boolean } | undefined)?.isMeshToonMaterial;
      if (geo.type === "PlaneGeometry" && isToon) {
        add(m, "capeInner"); // 静态后襟（不参与布料仿真）
        return;
      }
      if ((mat as { isMeshBasicMaterial?: boolean } | undefined)?.isMeshBasicMaterial) {
        add(m, "detail"); // 眼睛 / 腮红 / 头顶烛光球：远档收掉
        return;
      }
      // 小手小脚：小半径球体（躯干 r=1、脸 r=0.32 不会命中；四肢是胶囊体也不受影响）
      if (geo.type === "SphereGeometry" && (geo.parameters?.radius ?? 1) < 0.12) {
        add(m, "small");
        return;
      }
      // 其余（躯干 / 头 / 脸 / 兜帽 / 四肢）是剪影本体：不碰
    };
    /** 导入模型（GLB）：按顶点数排序，远档只留前 LOD_FAR_GLB_MESHES 个主网格 */
    const classifyImported = (root: THREE.Object3D) => {
      const meshes: THREE.Mesh[] = [];
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
      });
      if (meshes.length <= LOD_FAR_GLB_MESHES) {
        for (const m of meshes) add(m, "glb", true);
        return;
      }
      const rank = meshes
        .map((m, i) => ({ m, i, n: m.geometry?.attributes?.position?.count ?? 0 }))
        .sort((a, b) => b.n - a.n || a.i - b.i); // 顶点数降序；同分按原始顺序，保持确定性
      const keep = new Set(rank.slice(0, LOD_FAR_GLB_MESHES).map((r) => r.m));
      for (const m of meshes) add(m, "glb", keep.has(m));
    };

    for (const c of group.children) {
      const anyC = c as unknown as { isSprite?: boolean; isPoints?: boolean; isMesh?: boolean };
      if (anyC.isSprite) {
        classifySprite(c as THREE.Sprite);
        continue;
      }
      if (anyC.isPoints) {
        add(c, "mote"); // 音符微光
        continue;
      }
      if (anyC.isMesh) {
        const m = c as THREE.Mesh;
        const geo = m.geometry as THREE.BufferGeometry;
        const mat = m.material as THREE.Material | undefined;
        if (geo.type === "RingGeometry" || geo.type === "CircleGeometry") {
          add(m, "halo"); // 音乐光环（早期实现：硬边几何环 / 实心圆盘）
          continue;
        }
        const isToon = !!(mat as { isMeshToonMaterial?: boolean } | undefined)?.isMeshToonMaterial;
        if (geo.type === "PlaneGeometry") {
          if (isToon) {
            add(m, "capeOuter"); // Verlet 布料披风
          } else if (mat && mat.blending === THREE.AdditiveBlending) {
            // 音乐光环的现实现：softRingTexture / softDotTexture 的**加色**柔光面片
            add(m, "halo");
          } else {
            add(m, "shadow"); // 接触阴影（普通混合的贴图面片）
          }
          continue;
        }
        continue; // 认不出：不碰
      }
      if (c === bodyGroup) {
        c.traverse(classifyInBody);
        continue;
      }
      classifyImported(c); // 其余容器 = 导入模型的根
    }
  }

  /** 按当前档位刷新部件可见性（每帧调一次，位于 avatar.animate 之后） */
  private applyLod(e: Entry) {
    const group = e.avatar.group;
    if (group.children.length !== e.lodSig) {
      e.lodSig = group.children.length;
      this.scanParts(e);
    }
    // bodyGroup 被隐藏 = GLB 载入成功（avatar.ts 自己关掉了程序化身体与披风）
    const glbLoaded = !(group.children[0]?.visible ?? true);
    for (const p of e.lodParts) {
      const v = lodVisible(p, e.lod, glbLoaded);
      if (v !== null && p.obj.visible !== v) p.obj.visible = v;
    }
  }

  private sceneAdd: (o: THREE.Object3D) => void = () => {};
  private sceneRemove: (o: THREE.Object3D) => void = () => {};
  private selfPos: THREE.Vector3 | null = null;
  /** 网络目标位置复用向量（弹簧目标，防每帧分配） */
  private readonly _netPos = new THREE.Vector3();

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

