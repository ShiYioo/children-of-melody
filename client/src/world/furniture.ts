import * as THREE from "three";
import type { ToonKit } from "./toon";
import { addCollider, removeCollider, type CylinderCollider } from "../colliders";
import { terrainHeight } from "../heightfield";
import { patchRimMaterial } from "./rim";
import { softDotTexture } from "./fxtextures";
import { fxColor } from "./lightstate";

/**
 * 背包家具：椅子 & 双人荡秋千。
 * 每人每件只能放一个（服务器保证）；这里负责渲染、座位锚点与秋千摆动。
 *
 * 秋千的摆角不做物理同步：谁坐着，摆角就「看着」谁——
 * 各端从乘坐者的网络位置反推角度，座位永远贴着人，不需要额外的状态同步。
 */

export interface FurnEntry {
  key: string; // `${owner}:${kind}`
  owner: string;
  kind: number; // 0 椅子 / 1 秋千 / 2 双人船
  group: THREE.Group;
  collider: CylinderCollider | null;
  /** 秋千两个座位的枢轴（绕顶部横杆摆动） */
  pivots: THREE.Group[];
  /** 船的甲板碰撞柱（前后各一，顶面可站立；随船移动同步位置） */
  boatCols: CylinderCollider[];
  /** 家具的泊位（放置点）：船被开走后别人看着它回这里 */
  home: { x: number; y: number; z: number; ry: number };
}

interface PlayerLike {
  pos: THREE.Vector3;
  sit: boolean;
}

const SEAT_H = 0.46; // 座面离地
const SWING_TOP = 2.15; // 秋千横杆高度

/**
 * 柔体块：把一个球压成椭球。
 *
 * 光遇的家具造型里找不到硬边——座面、靠背、船板、凳面都是**圆软的体块**。
 * 原来全部用 `BoxGeometry`，在 toon 的色阶下就是一摞直角板，剪影上全是直线段，
 * 正是审查里说的"程序图元感"。椭球没有一条直边，且法线连续，
 * 配合 painterly ramp 才出得来那种水彩晕染的柔和明暗。
 */
function soft(w: number, h: number, d: number, ws = 18, hs = 12): THREE.SphereGeometry {
  return new THREE.SphereGeometry(1, ws, hs).scale(w / 2, h / 2, d / 2);
}

/** 统一收尾：投影 + 注入菲涅尔轮廓光（家具原来完全没走过 rim，是"有边没边"里没边的那一半） */
function finishFurniture(g: THREE.Group): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    if (m.material) patchRimMaterial(m.material as THREE.Material);
  });
}

function makeChair(kit: ToonKit): { group: THREE.Group; pivots: THREE.Group[] } {
  const g = new THREE.Group();
  const wood = "#caa87e";
  const dark = "#9c7a58";
  const cloth = "#d8b6a4";

  // 座面：略压扁的圆软板
  const seat = new THREE.Mesh(soft(0.6, 0.13, 0.58), kit.mat(wood));
  seat.position.y = SEAT_H;
  g.add(seat);
  // 坐垫：一块暖色软垫叠在座面上——光遇的家具都带着"布"的温度
  const cushion = new THREE.Mesh(soft(0.47, 0.1, 0.46, 16, 10), kit.mat(cloth));
  cushion.position.y = SEAT_H + 0.085;
  g.add(cushion);
  // 靠背：软枕状的板，微微后仰
  const back = new THREE.Mesh(soft(0.56, 0.62, 0.13), kit.mat(wood));
  back.position.set(0, SEAT_H + 0.34, -0.245);
  back.rotation.x = -0.14;
  g.add(back);
  // 四条圆腿：用胶囊（两端圆头）并向外微张——不再是"插在地上的管子"
  for (const [x, z] of [[-0.24, -0.22], [0.24, -0.22], [-0.24, 0.22], [0.24, 0.22]] as const) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, SEAT_H - 0.12, 4, 10), kit.mat(dark));
    leg.position.set(x * 1.05, SEAT_H / 2 - 0.02, z * 1.05);
    leg.rotation.set(z > 0 ? -0.05 : 0.05, 0, x > 0 ? 0.05 : -0.05);
    g.add(leg);
  }
  finishFurniture(g);
  return { group: g, pivots: [] };
}

function makeSwing(kit: ToonKit): { group: THREE.Group; pivots: THREE.Group[] } {
  const g = new THREE.Group();
  const wood = "#caa87e";
  const dark = "#9c7a58";
  const rope = "#e8dcc4";
  // A 字架 ×2（前后各一，摆动平面沿本地 Z）：圆头胶囊腿，12 段 → 剪影是连续曲线
  for (const zs of [-0.75, 0.75]) {
    for (const xs of [-0.95, 0.95]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 2.3, 4, 12), kit.mat(dark));
      leg.position.set(xs * 0.62, SWING_TOP / 2, zs);
      leg.rotation.z = xs > 0 ? -0.34 : 0.34;
      leg.rotation.x = zs > 0 ? 0.1 : -0.1;
      g.add(leg);
    }
  }
  // 顶部横杆（摆动轴）：圆头胶囊
  const bar = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 1.98, 4, 12), kit.mat(wood));
  bar.rotation.z = Math.PI / 2;
  bar.position.y = SWING_TOP;
  g.add(bar);
  // 两个座位：挂在横杆 ±0.45m，各带两根绳
  const pivots: THREE.Group[] = [];
  for (const sx of [-0.45, 0.45]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx, SWING_TOP, 0);
    const hang = SEAT_H + 0.05 - SWING_TOP; // 绳长（负值）
    for (const rz of [-0.2, 0.2]) {
      const rope1 = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, -hang, 8), kit.mat(rope));
      rope1.position.set(0, hang / 2, rz);
      pivot.add(rope1);
    }
    const seat = new THREE.Mesh(soft(0.5, 0.11, 0.44, 16, 10), kit.mat(wood));
    seat.position.set(0, hang, 0);
    const backbar = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, 0.4, 3, 8), kit.mat(dark));
    backbar.rotation.z = Math.PI / 2;
    backbar.position.set(0, hang + 0.52, -0.16);
    pivot.add(seat, backbar);
    pivot.userData.seatMesh = seat; // 座位锚点直接取它，省得在 children 里猜
    pivots.push(pivot);
    g.add(pivot);
  }
  finishFurniture(g);
  return { group: g, pivots };
}

/** 双人小木船：圆软的木壳，前后两块座板，船头一盏暖灯。仅供水面放置与乘坐。 */
function makeBoat(kit: ToonKit): { group: THREE.Group; pivots: THREE.Group[] } {
  const g = new THREE.Group();
  const wood = "#a8794e";
  const dark = "#7c5636";
  const trim = "#e0c296";
  // 船底：压扁的圆软板（原来是 7 块直角 Box 拼的硬壳）
  const bottom = new THREE.Mesh(soft(0.98, 0.17, 2.3, 20, 12), kit.mat(dark));
  bottom.position.y = 0.1;
  g.add(bottom);
  // 左右舷：外倾的圆棍，舷缘是圆润的（不再是直角板）
  for (const s of [-1, 1]) {
    const gunwale = new THREE.Mesh(soft(0.15, 0.46, 2.26, 14, 14), kit.mat(wood));
    gunwale.position.set(s * 0.49, 0.34, 0);
    gunwale.rotation.z = s * -0.3;
    g.add(gunwale);
  }
  // 船头（翘起）/ 船尾：圆软的封板
  const bow = new THREE.Mesh(soft(0.92, 0.44, 0.5, 16, 12), kit.mat(wood));
  bow.position.set(0, 0.42, -1.08);
  bow.rotation.x = 0.34;
  g.add(bow);
  const stern = new THREE.Mesh(soft(0.92, 0.38, 0.44, 16, 12), kit.mat(wood));
  stern.position.set(0, 0.34, 1.08);
  stern.rotation.x = -0.24;
  g.add(stern);
  // 前后座板：圆软的板
  for (const z of [-0.42, 0.42]) {
    const seat = new THREE.Mesh(soft(0.86, 0.11, 0.5, 16, 10), kit.mat(trim));
    seat.position.set(0, 0.47, z);
    g.add(seat);
  }
  // 船头小灯：暖光核心 + 一张极柔光晕贴图的光晕（夜里真的会 bloom）
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 14, 10),
    new THREE.MeshBasicMaterial({ color: "#fff0c4" })
  );
  lamp.position.set(0, 0.66, -1.24);
  g.add(lamp);
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: softDotTexture(),
      color: fxColor("#ffd98e"),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  halo.scale.setScalar(0.62);
  halo.position.set(0, 0.66, -1.24);
  g.add(halo);
  const shade = new THREE.Mesh(soft(0.15, 0.13, 0.15, 12, 8), kit.mat(dark));
  shade.position.set(0, 0.75, -1.24);
  g.add(shade);
  finishFurniture(g);
  return { group: g, pivots: [] };
}

export function createFurniture(kit: ToonKit, sceneAdd: (o: THREE.Object3D) => void, sceneRemove: (o: THREE.Object3D) => void) {
  const entries = new Map<string, FurnEntry>();
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();

  function upsert(key: string, data: { owner: string; kind: number; x: number; y: number; z: number; ry: number }) {
    let e = entries.get(key);
    if (!e) {
      const built = data.kind === 1 ? makeSwing(kit) : data.kind === 2 ? makeBoat(kit) : makeChair(kit);
      sceneAdd(built.group);
      // 船用一根居中的可站立柱（覆盖全船甲板，与朝向无关）；椅子/秋千仍是单柱挡人
      const boatCols: CylinderCollider[] = [];
      const col: CylinderCollider | null =
        data.kind === 2
          ? null
          : {
              x: data.x,
              z: data.z,
              r: data.kind === 1 ? 0.9 : 0.42,
              y0: data.y,
              y1: data.y + 0.55,
            };
      if (data.kind === 2) {
        const c: CylinderCollider = { x: data.x, z: data.z, r: 1.0, y0: data.y - 0.4, y1: data.y + 0.55, stand: true, standR: 0.85 };
        boatCols.push(c);
        addCollider(c);
      } else if (col) {
        addCollider(col);
      }
      e = {
        key,
        owner: data.owner,
        kind: data.kind,
        group: built.group,
        collider: col,
        pivots: built.pivots,
        boatCols,
        home: { x: data.x, y: data.y, z: data.z, ry: data.ry },
      };
      entries.set(key, e);
    }
    e.owner = data.owner;
    e.group.position.set(data.x, data.y, data.z);
    e.group.rotation.y = data.ry;
    if (e.collider) {
      e.collider.x = data.x;
      e.collider.z = data.z;
      e.collider.y0 = data.y;
    }
  }

  function remove(key: string) {
    const e = entries.get(key);
    if (!e) return;
    if (e.collider) removeCollider(e.collider);
    for (const c of e.boatCols) removeCollider(c);
    sceneRemove(e.group);
    e.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    entries.delete(key);
  }

  function has(key: string) {
    return entries.has(key);
  }

  /** 本地乘坐者驱动自己座位的摆角（自己的秋千自己做物理，别人看着你的位置反推） */
  function setPivotAngle(key: string, seat: number, angle: number) {
    const e = entries.get(key);
    if (!e || e.kind !== 1) return;
    e.pivots[seat === 1 ? 1 : 0].rotation.x = angle;
  }

  function pivotAngle(key: string, seat: number): number {
    const e = entries.get(key);
    if (!e || e.kind !== 1) return 0;
    return e.pivots[seat === 1 ? 1 : 0].rotation.x;
  }

  /** 世界系座位锚点：椅子 1 个（kind 0, seat=-1）；秋千/双人船 2 个（seat 0/1） */
  function seatAnchor(key: string, seat: number, out: THREE.Vector3): boolean {
    const e = entries.get(key);
    if (!e) return false;
    e.group.updateMatrixWorld(true);
    if (e.kind === 0) {
      out.set(0, SEAT_H + 0.06, 0.04).applyMatrix4(e.group.matrixWorld);
      return true;
    }
    if (e.kind === 2) {
      // 船：前后两块座板的板面中心
      out.set(0, 0.52, seat === 1 ? 0.42 : -0.42).applyMatrix4(e.group.matrixWorld);
      return true;
    }
    const pivot = e.pivots[seat === 1 ? 1 : 0];
    const seatMesh = pivot.userData.seatMesh as THREE.Mesh | undefined;
    if (!seatMesh) return false;
    seatMesh.getWorldPosition(out);
    out.y += 0.06;
    return true;
  }

  /** 找最近的可坐座位：返回 [key, seat, 距离]；maxDist 内没有则 null */
  function nearestSeat(pos: THREE.Vector3, maxDist: number): { key: string; seat: number; dist: number } | null {
    let best: { key: string; seat: number; dist: number } | null = null;
    for (const e of entries.values()) {
      const seats = e.kind === 0 ? 1 : 2;
      for (let s = 0; s < seats; s++) {
        if (!seatAnchor(e.key, s, tmpV)) continue;
        const d = tmpV.distanceTo(pos);
        if (d < maxDist && (!best || d < best.dist)) best = { key: e.key, seat: s, dist: d };
      }
    }
    return best;
  }

  /**
   * 每帧：秋千摆角跟随「正坐着且贴着座位的人」。
   * players 里包含自己与远端（pos 为各自权威位置，sit=true 才算乘坐）。
   */
  function update(players: PlayerLike[]) {
    const now = performance.now() / 1000;
    for (const e of entries.values()) {
      if (e.kind !== 1) continue;
      e.group.updateMatrixWorld(true);
      for (let s = 0; s < 2; s++) {
        const pivot = e.pivots[s];
        // 该座位最近的乘坐者
        let angle: number | null = null;
        if (seatAnchor(e.key, s, tmpV)) {
          let bestD = 0.85;
          for (const p of players) {
            if (!p.sit) continue;
            const d = tmpV.distanceTo(p.pos);
            if (d < bestD) {
              bestD = d;
              // 从乘坐者位置反推摆角。必须用「家具组」的朝向取逆（只含底座 ry）——
              // 枢轴自己的四元数带着当前摆角，会把待求解的信号一起逆掉，local.z 恒为 0。
              // 座位挂在枢轴 −Y 方向：Rx(θ) 后偏移 z 分量 = −L·sinθ，所以 z 要取负——
              // 正号会让秋千镜像人物运动，人和座椅差出两倍弧长
              e.group.getWorldQuaternion(tmpQ);
              const local = tmpV.copy(p.pos).sub(pivot.getWorldPosition(new THREE.Vector3())).applyQuaternion(tmpQ.clone().invert());
              angle = Math.max(-1.0, Math.min(1.0, Math.atan2(-local.z, -local.y)));
            }
          }
        }
        if (angle === null) {
          // 没人坐：轻风里的微微摇曳
          angle = Math.sin(now * 0.9 + s * 1.7) * 0.045;
        }
        pivot.rotation.x = angle;
      }
    }
  }

  /**
   * 船的水面行为（每帧）：
   * - 空船/泊位：原地随波轻摇
   * - setBoatTransform 已把船移到主人身边：随速度轻微俯仰摇晃
   */
  function updateBoats(t: number) {
    for (const e of entries.values()) {
      if (e.kind !== 2) continue;
      e.group.rotation.z = Math.sin(t * 1.1 + e.home.x) * 0.035;
      e.group.rotation.x = Math.sin(t * 0.8 + e.home.z * 0.7) * 0.028;
    }
  }

  /**
   * 把船移到目标位（驾驶跟随 / 远端跟随共用）。
   *
   * `k` 是平滑系数：远端跟随用默认的一阶追随，抹掉网络抖动；
   * **本地驾驶必须传 1** —— 驾驶逻辑已经按 dt 把位置积分好了，
   * 这里再叠一层 lerp 等于把船速直接乘 k（原来写死 0.35，于是船只能跑到
   * 设定速度的 35%，就是"划不快"）。转向的插值也用同一个 k。
   */
  function setBoatTransform(key: string, x: number, y: number, z: number, ry: number, k = 0.35) {
    const e = entries.get(key);
    if (!e || e.kind !== 2) return;
    e.group.position.x += (x - e.group.position.x) * k;
    e.group.position.y += (y - e.group.position.y) * k;
    e.group.position.z += (z - e.group.position.z) * k;
    // 朝向走最短弧
    let d = ry - e.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    e.group.rotation.y += d * k;
    // 甲板碰撞柱贴着船走（居中单柱），y1 = 甲板顶
    const c = e.boatCols[0];
    if (c) {
      c.x = e.group.position.x;
      c.z = e.group.position.z;
      c.y0 = e.group.position.y - 0.4;
      c.y1 = e.group.position.y + 0.55;
    }
  }

  /** 所有船的只读快照（main 层做跟随/骑乘逻辑用） */
  function boats(): Array<{ key: string; owner: string; x: number; y: number; z: number; ry: number; hx: number; hz: number; hry: number }> {
    const out: Array<{ key: string; owner: string; x: number; y: number; z: number; ry: number; hx: number; hz: number; hry: number }> = [];
    for (const e of entries.values()) {
      if (e.kind !== 2) continue;
      out.push({
        key: e.key,
        owner: e.owner,
        x: e.group.position.x,
        y: e.group.position.y,
        z: e.group.position.z,
        ry: e.group.rotation.y,
        hx: e.home.x,
        hz: e.home.z,
        hry: e.home.ry,
      });
    }
    return out;
  }

  return { upsert, remove, has, seatAnchor, nearestSeat, update, setPivotAngle, pivotAngle, entries, updateBoats, setBoatTransform, boats };
}
