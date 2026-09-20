import * as THREE from "three";
import type { ToonKit } from "./toon";
import { addCollider, removeCollider, type CylinderCollider } from "../colliders";
import { terrainHeight } from "../heightfield";

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
  kind: number; // 0 椅子 / 1 秋千
  group: THREE.Group;
  collider: CylinderCollider | null;
  /** 秋千两个座位的枢轴（绕顶部横杆摆动） */
  pivots: THREE.Group[];
}

interface PlayerLike {
  pos: THREE.Vector3;
  sit: boolean;
}

const SEAT_H = 0.46; // 座面离地
const SWING_TOP = 2.15; // 秋千横杆高度

function makeChair(kit: ToonKit): { group: THREE.Group; pivots: THREE.Group[] } {
  const g = new THREE.Group();
  const wood = "#caa87e";
  const dark = "#8d6f52";
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.09, 0.6), kit.mat(wood));
  seat.position.y = SEAT_H;
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.66, 0.09), kit.mat(wood));
  back.position.set(0, SEAT_H + 0.36, -0.26);
  back.rotation.x = -0.1;
  for (const [x, z] of [[-0.24, -0.22], [0.24, -0.22], [-0.24, 0.22], [0.24, 0.22]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, SEAT_H, 6), kit.mat(dark));
    leg.position.set(x, SEAT_H / 2, z);
    g.add(leg);
  }
  g.add(seat, back);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return { group: g, pivots: [] };
}

function makeSwing(kit: ToonKit): { group: THREE.Group; pivots: THREE.Group[] } {
  const g = new THREE.Group();
  const wood = "#caa87e";
  const dark = "#8d6f52";
  const rope = "#e8dcc4";
  // A 字架 ×2（前后各一，摆动平面沿本地 Z）
  for (const zs of [-0.75, 0.75]) {
    for (const xs of [-0.95, 0.95]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 2.5, 6), kit.mat(dark));
      leg.position.set(xs * 0.62, SWING_TOP / 2, zs);
      leg.rotation.z = xs > 0 ? -0.34 : 0.34;
      leg.rotation.x = zs > 0 ? 0.1 : -0.1;
      g.add(leg);
    }
  }
  // 顶部横杆（摆动轴）
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.1, 8), kit.mat(wood));
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
      const rope1 = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, -hang, 5), kit.mat(rope));
      rope1.position.set(0, hang / 2, rz);
      pivot.add(rope1);
    }
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.42), kit.mat(wood));
    seat.position.set(0, hang, 0);
    const backbar = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.46, 6), kit.mat(dark));
    backbar.rotation.z = Math.PI / 2;
    backbar.position.set(0, hang + 0.52, -0.16);
    pivot.add(seat, backbar);
    pivot.userData.seatMesh = seat; // 座位锚点直接取它，省得在 children 里猜
    pivots.push(pivot);
    g.add(pivot);
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return { group: g, pivots };
}

export function createFurniture(kit: ToonKit, sceneAdd: (o: THREE.Object3D) => void, sceneRemove: (o: THREE.Object3D) => void) {
  const entries = new Map<string, FurnEntry>();
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();

  function upsert(key: string, data: { owner: string; kind: number; x: number; y: number; z: number; ry: number }) {
    let e = entries.get(key);
    if (!e) {
      const built = data.kind === 1 ? makeSwing(kit) : makeChair(kit);
      sceneAdd(built.group);
      const col: CylinderCollider = {
        x: data.x,
        z: data.z,
        r: data.kind === 1 ? 0.9 : 0.42,
        y0: data.y,
        y1: data.y + 0.55,
      };
      addCollider(col);
      e = { key, owner: data.owner, kind: data.kind, group: built.group, collider: col, pivots: built.pivots };
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

  /** 世界系座位锚点：椅子 1 个（kind 0, seat=-1）；秋千 2 个（seat 0/1） */
  function seatAnchor(key: string, seat: number, out: THREE.Vector3): boolean {
    const e = entries.get(key);
    if (!e) return false;
    e.group.updateMatrixWorld(true);
    if (e.kind === 0) {
      out.set(0, SEAT_H + 0.06, 0.04).applyMatrix4(e.group.matrixWorld);
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
              // 枢轴自己的四元数带着当前摆角，会把待求解的信号一起逆掉，local.z 恒为 0
              e.group.getWorldQuaternion(tmpQ);
              const local = tmpV.copy(p.pos).sub(pivot.getWorldPosition(new THREE.Vector3())).applyQuaternion(tmpQ.clone().invert());
              angle = Math.max(-1.0, Math.min(1.0, Math.atan2(local.z, -local.y)));
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

  return { upsert, remove, has, seatAnchor, nearestSeat, update, setPivotAngle, pivotAngle, entries };
}
