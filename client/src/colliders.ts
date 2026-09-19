import * as THREE from "three";

/**
 * 静态实体碰撞：竖直圆柱近似（树干 / 岩石 / 灯塔 / 篝火 / 木凳）。
 *
 * 岛是圆形、地形连续，实体数量 ~40，逐个遍历比空间划分更快也更简单。
 * 玩家与 NPC 共用：推挤 + 速度切向化（贴着表面滑行，不是粘住弹开）。
 */
export interface CylinderCollider {
  x: number;
  z: number;
  r: number;
  y0: number; // 柱底（世界高度）
  y1: number; // 柱顶
}

const colliders: CylinderCollider[] = [];

export function addCollider(c: CylinderCollider) {
  colliders.push(c);
}

export function clearColliders() {
  colliders.length = 0;
}

/** 就近查询（调试/UI 用）：某点是否在任何碰撞体内 */
export function insideAnyCollider(x: number, z: number, y = 0, pad = 0): boolean {
  for (const c of colliders) {
    if (y + 1.6 < c.y0 || y > c.y1) continue;
    const dx = x - c.x;
    const dz = z - c.z;
    const minD = c.r + pad;
    if (dx * dx + dz * dz < minD * minD) return true;
  }
  return false;
}

/**
 * 把角色从实体里水平推出。命中时把速度的「径向分量」去掉，角色贴着表面滑过去。
 * @param pos 脚底世界坐标（就地修改）
 * @param vel 水平速度（就地修改；NPC 可传 null）
 * @param playerR 角色半径
 * @returns 是否发生推挤（NPC 卡住检测用）
 */
export function resolveColliders(pos: THREE.Vector3, vel: THREE.Vector3 | null, playerR = 0.38): boolean {
  let hit = false;
  const bodyTop = 1.6;
  for (const c of colliders) {
    // 垂直区间不相交：脚下高于柱顶（从头顶飞过）或头顶低于柱底（从脚下深处过）都忽略
    if (pos.y > c.y1 || pos.y + bodyTop < c.y0) continue;
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const minD = c.r + playerR;
    const d2 = dx * dx + dz * dz;
    if (d2 >= minD * minD) continue;
    const d = Math.sqrt(d2);
    let nx: number;
    let nz: number;
    if (d < 1e-4) {
      // 正好在轴上：任意方向推出
      nx = 1;
      nz = 0;
    } else {
      nx = dx / d;
      nz = dz / d;
    }
    pos.x = c.x + nx * minD;
    pos.z = c.z + nz * minD;
    if (vel) {
      const dot = vel.x * nx + vel.z * nz;
      if (dot < 0) {
        vel.x -= nx * dot;
        vel.z -= nz * dot;
      }
    }
    hit = true;
  }
  return hit;
}
