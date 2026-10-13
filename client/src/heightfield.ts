/**
 * 音遇的地形高度场（解析函数，处处可采样）。
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

/** 台地高度（与 terrain.ts 的配色 BAND_H 保持一致） */
export const TERRACE_H = 1.35;

/**
 * 软台阶化：把高度吸附到最近的台阶，台阶顶部留一段圆润过渡当「崖唇」。
 *
 * **为什么需要它**：原来的穹顶是连续幂函数 `5.5*(1-rr)^1.25 + 1.2`，
 * 横向最大坡度只有 0.62，按审查的说法「从任何角度看都是一个馒头」。
 * 光遇地貌的识别度恰恰来自**台地 + 台地与台地之间的圆润崖唇**。
 *
 * **为什么要 +半带宽再 -半带宽**：台阶是「向下吸附」的，直接用会让整座岛
 * 平均下沉约 0.95m —— 岸边那一圈（原来 1.2~1.5）会掉到 0.55 的水面以下，
 * 岛会肉眼可见地缩小、沙滩变宽。先平移半格再吸附、最后减回去，
 * 台阶就**居中**落在原高度上，整体起伏基本不变（实测各高度偏差 ≤0.5m）。
 *
 * `smoothstep(0.55, 1.0, ...)`：每个台阶的下 55% 是平台（完全平），
 * 上 45% 是崖唇。过渡留得够长，边缘才是「圆润崖唇」而不是直角坎。
 *
 * ⚠️ 改这个函数**必须同步 `water.ts` 里 `terrainH` 的 GLSL 副本**，
 * 否则水面与岸线的交界会错位。
 */
function terrace(h: number): number {
  const t = (h + TERRACE_H * 0.5) / TERRACE_H;
  const i = Math.floor(t);
  return (i + smoothstep(0.55, 1.0, t - i)) * TERRACE_H - TERRACE_H * 0.5;
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

  // 台地化：放在广场压平与岸边沉海**之前** ——
  // 广场必须保持绝对平（篝火、家具、围坐的木凳都在上面），
  // 海岸线也不该被台阶切碎（那一步最后由 smoothstep(0.86,1) 统一处理）。
  //
  // **只作用在岛体内部，岸边那一圈保持自然坡**：
  // 台阶是向下吸附的，最低那层台地会把「原高度 0.95~2.0」的整条环带
  // 全部压平到 0.95 —— 而 0.95 < 海滩阈值 1.15，于是整条环带都变成沙滩。
  // 实测沙占 26.8%（目标 8~12%），根因就在这里。
  // 用 smoothstep(1.9, 3.4, h) 把台地权重从岸边淡出到内陆。
  const tw = smoothstep(1.55, 2.8, h);
  if (tw > 0) h = mix(h, terrace(h), tw);

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
