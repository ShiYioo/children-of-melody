/**
 * 渐强之岛的地形高度场（解析函数，处处可采样）。
 * 地形网格、角色落地、相机、NPC 巡游全部复用这一份定义。
 *
 * 岛的布局：
 *  - 中心 (0,0) 是平坦的篝火广场
 *  - 东南草坡缓缓隆起
 *  - 东北 (26,-28) 是灯塔山丘
 *  - 外圈是沙滩，没入 y=0.55 的海面
 */
export const ISLAND_RADIUS = 58;
export const WATER_LEVEL = 0.55;

// 平滑阶梯
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 岛岸边缘的半径抖动，让海岸线不那么圆 */
function edgeFactor(ang: number): number {
  return 0.82 + 0.14 * Math.sin(ang * 3 + 1.7) + 0.07 * Math.sin(ang * 7 + 0.4);
}

export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const ang = Math.atan2(z, x);
  const rr = r / (ISLAND_RADIUS * edgeFactor(ang));
  if (rr >= 1) return -1.6 - (rr - 1) * 60; // 岛外海床

  // 基础穹顶：中心 ~6.7 → 边缘 ~1.2
  let h = 5.5 * Math.pow(Math.max(0, 1 - rr), 1.25) + 1.2;

  // 灯塔山丘
  const dxh = x - 26, dzh = z + 28;
  h += 9.5 * Math.exp(-(dxh * dxh + dzh * dzh) / 320);

  // 起伏（离开广场后再出现）
  const n =
    0.8 * Math.sin(x * 0.16 + 2.1) * Math.cos(z * 0.13 - 1.2) +
    0.5 * Math.sin(x * 0.31) * Math.sin(z * 0.27 + 0.8);
  h += n * smoothstep(7, 20, r);

  // 广场压平
  h = mix(h, 1.25, Math.min(1, 1.15 * Math.exp(-(r * r) / 72)));

  // 岸边没入海中
  h = mix(h, -1.6, smoothstep(0.86, 1.0, rr));

  return h;
}

/** 大致法线（用于放置物体的朝向） */
export function terrainSlope(x: number, z: number): number {
  const e = 0.4;
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return Math.min(1, Math.hypot(hx, hz) / (2 * e) );
}

/** 岛上地标（NPC 巡游与出生点） */
export const LANDMARKS: { name: string; x: number; z: number }[] = [
  { name: "篝火广场", x: 0, z: 0 },
  { name: "东草坡", x: 22, z: 22 },
  { name: "西花田", x: -30, z: 8 },
  { name: "南沙岸", x: 6, z: 44 },
  { name: "灯塔山丘", x: 26, z: -28 },
  { name: "北林地", x: -14, z: -34 },
  { name: "东北滩", x: 42, z: -8 },
];
