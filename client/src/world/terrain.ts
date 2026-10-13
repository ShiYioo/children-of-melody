import * as THREE from "three";
import { terrainHeight, TERRACE_H } from "../heightfield";
import { painterlyGradient, brushTexture } from "./toon";

/**
 * 岛屿地形网格：顶点着色出绘画感的柔和色带——
 * 蜜色沙滩 → 鼠尾草绿坡 → 薰衣草岩，广场铺暖石色。
 * 混色用低频噪声（大笔触），避免像素点彩的碎感。
 *
 * 本轮加了两件事，都是为了把"一片没有起伏细节的均匀渐变"变成**读得出体积**的地面：
 *
 *  1. **烘焙 AO（地平线遮蔽）**。toon 材质的明暗本来就被量化成几档，没有 AO 时
 *     坡面与坡面之间完全分不开，地形看起来像贴在地上的一张图。逐顶点算一次遮蔽、
 *     把凹折处压暗，坡脚、谷底、岩壁根部的体积立刻就出来了。这是本轮观感提升最大的一处改。
 *
 *  2. **台地化配色**。把高度量化成软台阶，做出层理感。
 *
 * ⚠️ 关键约束：顶点 y 必须**严格等于** `terrainHeight(x, z)`，绝不可以为了做台阶
 * 去直接改顶点 y。物理、草地落点、道具落地判定全都直接调用 `terrainHeight()`，
 * 一旦网格被独立量化，角色就会浮空或陷进地里、草会悬在半空。
 * 所以这里的"台地"是**色彩分层**，不是几何台阶。
 */
const C_SAND = new THREE.Color("#f6e0b8");
const C_GRASS_LO = new THREE.Color("#93c47d");
const C_GRASS_HI = new THREE.Color("#529368");
const C_ROCK = new THREE.Color("#93a2ab");
const C_PLAZA = new THREE.Color("#e6d3ab");
const C_SUN = new THREE.Color("#ffd9a8");

/** 台阶高度（m）。**必须等于 `heightfield.ts` 的 `TERRACE_H`** ——
 *  配色台阶与几何台阶错开半格的话，崖唇的岩色会糊在平台的草色上。
 *  索性直接 import，别留第二份魔数（`water.ts` 的 GLSL 副本没法 import，那份靠注释约束）。 */
const BAND_H = TERRACE_H;

/**
 * 烘焙环境光遮蔽（地平线遮蔽法）。
 * 8 个方向各取 4 个距离，看邻域地形相对当前顶点抬升得多快；仰角越大遮得越死。
 * 平坦处 ≈ 1.0，谷底与坡脚明显 < 1.0。返回 0=完全遮蔽，1=完全开阔。
 */
function bakeAO(x: number, z: number, h: number): number {
  const R = 5.4; // 采样半径：约 3~4 格宽，正好覆盖坡面的凹折尺度
  const STEPS = 4;
  const DIRS = 8;
  let occ = 0;
  for (let d = 0; d < DIRS; d++) {
    const a = (d / DIRS) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let maxRise = 0;
    for (let s = 1; s <= STEPS; s++) {
      const dist = (s / STEPS) * R;
      const rise = (terrainHeight(x + dx * dist, z + dz * dist) - h) / dist;
      if (rise > maxRise) maxRise = rise;
    }
    occ += 1 / (1 + maxRise * 2.2);
  }
  return occ / DIRS;
}

export function createTerrain(): THREE.Mesh {
  const SIZE = 150;
  // 更粗的网格：色块更大、坡面更圆，绘画感更强
  const SEG = 96;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const sunDir = new THREE.Vector3(-0.62, 0.3, -0.42).normalize();
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);

    const r = Math.hypot(x, z);
    // 一次性取 4 个邻居，同时得到坡度与向阳面朝向。
    // 原来是 slopeAt() 取 4 次、向阳项又取 4 次 —— 两趟完全重复的采样。
    const e = 0.8;
    const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
    const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
    const slope = Math.min(1, Math.hypot(hx, hz) / (2 * e));

    // 低频大笔触混色（两层慢波叠出草甸的明暗斑块）
    const n1 = 0.5 + 0.28 * Math.sin(x * 0.09 + 1.1) * Math.cos(z * 0.08 - 0.6) + 0.22 * Math.sin((x + z) * 0.055 + 2.0);

    // 台地分带：**必须与 heightfield.ts 的 terrace() 对齐**。
    // 几何上是 `(i + s) * BAND_H - BAND_H/2`，所以这里也要先平移半格再取整，
    // 否则配色台阶会比几何台阶错开半格（小数部分老在 0.5 附近跳变），
    // 崖唇的岩色就会糊在平台的草色上。
    const ht = (h + BAND_H * 0.5) / BAND_H;
    const bi = Math.floor(ht);
    const soft = THREE.MathUtils.smoothstep(ht - bi, 0.55, 1.0); // 0=平台，1=崖唇顶
    const hBand = (bi + soft) * BAND_H - BAND_H * 0.5;
    // 层理明暗：沿台地高度做一次慢波，让相邻台地一明一暗
    const bandTone = 0.5 + 0.5 * Math.sin(hBand * 2.1 + (x + z) * 0.03);
    // 笔触与层理各占一半：纯笔触太随机、纯层理太机械
    const tone = THREE.MathUtils.clamp(0.55 * n1 + 0.45 * bandTone, 0, 1);
    // 崖唇露岩：`soft` 在 0~1 之间就是台阶的过渡带。
    // 用**解析的崖唇位置**上岩色，而不是靠有限差分算出来的坡度 ——
    // 后者会被噪声推得忽高忽低，整座岛糊成"灰霉斑"。
    // 用 sin 取峰、而不是宽 smoothstep：崖唇本身占台阶 45% 的面积，
    // 让整段都吃岩色的话岛心会被灰色吃掉（试过 smoothstep(0.12,0.88)，就是那个结果）。
    //
    // 另外记一个反直觉的实测结论：**岩占比由「崖唇占台阶高度的比例」决定，
    // 不由台阶高度决定**。把 TERRACE_H 从 1.9 砍到 1.35（台阶数翻倍），
    // 岩占比只从 10.0% 动到 10.3% —— 因为 smoothstep(0.55,1.0) 定义的是
    // 「每个台阶里崖唇占 45%」，台阶变矮只是台阶变多，总比例不变。
    // 想真的加岩，得改下面这行的下界，而不是改 BAND_H。
    const lip = Math.sin(Math.PI * THREE.MathUtils.clamp(soft, 0, 1));

    if (h < 1.15) {
      c.copy(C_SAND); // 海滩
    } else if (slope > 0.315 || h > 11.5) {
      c.copy(C_ROCK).lerp(C_GRASS_HI, 0.2 * Math.max(0, n1)); // 真·陡崖
    } else {
      c.copy(C_GRASS_LO).lerp(C_GRASS_HI, tone * 0.95); // 草坡
      c.lerp(C_ROCK, lip * 0.72); // 台地崖唇
    }

    // 广场石色（中心压平区）
    const plaza = Math.exp(-(r * r) / 46);
    if (h >= 1.0) c.lerp(C_PLAZA, plaza * 0.85);

    // 沙滩与草地的窄过渡。
    // 原来这条带是 `[1.35, 2.3]`（整整 0.95m 的高差）—— 岛很缓，0.95m 高差
    // 横着铺开就是六七米宽的沙滩。实测陆上顶点里**沙占 31%**，
    // 而光遇的地貌配比是草 60~70% / 岩 20~30% / 沙 8~12%，沙滩宽了三倍。
    if (h >= 1.15 && h < 1.70) c.lerp(C_SAND, 1 - (h - 1.15) / 0.55);

    // 向阳坡染一点夕阳
    const nrm = new THREE.Vector3(-hx, 1.6, -hz).normalize();
    const sun = Math.max(0, nrm.dot(sunDir));
    c.lerp(C_SUN, sun * 0.16);

    // 烘焙 AO：凹折压暗。放在最后一步，保证它对上面所有配色分支都生效。
    // 下限 0.58 而不是 0 —— 全黑会在 toon 的量化档位里直接跳一档，看着像脏斑。
    const ao = bakeAO(x, z, h);
    c.multiplyScalar(0.58 + 0.42 * ao);

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // 油画渐变 + 手绘笔触（与全岛 toon 材质同一套画风）
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: painterlyGradient(), map: brushTexture() });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "terrain";
  return mesh;
}
