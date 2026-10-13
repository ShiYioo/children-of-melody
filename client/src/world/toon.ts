import * as THREE from "three";

/**
 * 共享的 toon 材质工厂 · 油画画风
 * - 明暗是 32 档线性渐变的连续曲线（手绘油画感），不再是卡通四档断层
 * - 暗部提亮、中间调 smoothstep 压缩——光遇那种"水彩晕染"的明暗关系
 * - 颜色统一降饱和 15%（光遇的克制色板）
 * - 表面笔触噪声**可按材质给不同 repeat**，也可以关掉（角色用纯色更接近光遇）
 */
export interface ToonKit {
  /** @param brushRepeat 笔触贴图重复次数；传 0 表示不用笔触图（纯色 + ramp，角色用） */
  mat: (color: string, vertexColors?: boolean, brushRepeat?: number) => THREE.Material;
  gradient: THREE.DataTexture;
  dispose: () => void;
}

/**
 * 统一降饱和：向自身灰度靠 k（默认 0.15）。
 *
 * 导出它是为了让**所有走顶点色 / GLSL 常量的地方**也能用同一套降饱和——
 * 原来 desat 只作用于 `material.color`，于是地形顶点色、树冠顶点色、
 * 草与水的 GLSL 常量统统绕过了它，所谓"色板统一"实际只覆盖了一半材质。
 */
export function desat(color: THREE.Color, k = 0.15): THREE.Color {
  const l = (color.r + color.g + color.b) / 3;
  return color.lerp(new THREE.Color(l, l, l), k);
}

/** 各向异性过滤等级：由 scene.ts 在 renderer 就绪后写入 */
let _maxAniso = 1;
export function setToonAnisotropy(n: number): void {
  if (n <= _maxAniso) return;
  _maxAniso = n;
  _brushes.forEach((t) => {
    t.anisotropy = n;
    t.needsUpdate = true;
  });
}

const _brushes = new Map<number, THREE.Texture>();

/**
 * 手绘笔触噪声：低频柔斑块（值 0.9~1.0），乘进材质颜色给表面"人手的温度"。
 *
 * 注意两个刻意的取舍：
 * 1. **不加逐像素高频颗粒**——那在 1.7m 高的角色上只会让表面发"脏"，
 *    与光遇"干净的纯色 + 大面积柔和渐变"相反；远景又会闪烁。
 * 2. 必须按尺度给不同 repeat：同一张 256px 贴图在地形上被拉到 75m/格、
 *    在树干上 2.4m/格，相差 30 倍，两处都不好看。
 */
export function brushTexture(repeat = 2): THREE.Texture {
  const key = repeat;
  const hit = _brushes.get(key);
  if (hit) return hit;
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#f4f4f4";
  ctx.fillRect(0, 0, size, size);
  // 低频柔斑块（画笔扫过的大面）：只调亮度，不引入颗粒
  for (let i = 0; i < 22; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 26 + Math.random() * 54;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    const v = Math.random() < 0.5 ? "rgba(255,255,255,0.42)" : "rgba(0,0,0,0.055)";
    g.addColorStop(0, v);
    g.addColorStop(1, "rgba(128,128,128,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = _maxAniso;
  _brushes.set(key, tex);
  return tex;
}

/**
 * 光遇式明暗渐变曲线：暗部提亮 + smoothstep 中间调压缩。
 * 下限 0.2 是刻意的——光遇的暗部被雾与环境光抬得很高，几乎看不到死黑，
 * 这也是"柔和"的主要来源。
 */
export function painterlyGradient(): THREE.DataTexture {
  const N = 32;
  const steps = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const s = t * t * (3 - 2 * t);
    steps[i] = Math.round(255 * (0.2 + 0.8 * Math.pow(s, 0.85)));
  }
  const gradientMap = new THREE.DataTexture(steps, N, 1, THREE.RedFormat);
  gradientMap.minFilter = THREE.LinearFilter;
  gradientMap.magFilter = THREE.LinearFilter;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

export function createToonKit(): ToonKit {
  const gradient = painterlyGradient();
  const cache = new Map<string, THREE.Material>();
  return {
    gradient,
    mat(color, vertexColors = false, brushRepeat = 2) {
      const key = `${color}|${vertexColors}|${brushRepeat}`;
      let m = cache.get(key);
      if (!m) {
        const c = desat(new THREE.Color(color), 0.15);
        m = new THREE.MeshToonMaterial({
          color: c,
          gradientMap: gradient,
          ...(brushRepeat > 0 ? { map: brushTexture(brushRepeat) } : {}),
          vertexColors,
        });
        cache.set(key, m);
      }
      return m;
    },
    dispose() {
      gradient.dispose();
      cache.forEach((m) => m.dispose());
      _brushes.forEach((t) => t.dispose());
      _brushes.clear();
    },
  };
}
