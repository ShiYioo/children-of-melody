import * as THREE from "three";

/**
 * 共享的 toon 材质工厂 · 油画画风
 * - 明暗是 32 档线性渐变的连续曲线（手绘油画感），不再是卡通四档断层
 * - 暗部提亮、中间调 smoothstep 压缩——光遇那种"水彩晕染"的明暗关系
 * - 颜色统一降饱和 15%（光遇的克制色板），表面乘一层手绘笔触噪声
 */
export interface ToonKit {
  mat: (color: string, vertexColors?: boolean) => THREE.Material;
  gradient: THREE.DataTexture;
  dispose: () => void;
}

let _brushTex: THREE.Texture | null = null;
/** 手绘笔触噪声：近白的柔斑块+细颗粒（值 0.9~1.0），乘进材质颜色给表面"人手的温度" */
export function brushTexture(): THREE.Texture {
  if (_brushTex) return _brushTex;
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#f2f2f2";
  ctx.fillRect(0, 0, size, size);
  // 低频柔斑块（画笔扫过的大面）
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 14 + Math.random() * 30;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    const v = Math.random() < 0.5 ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.08)";
    g.addColorStop(0, v);
    g.addColorStop(1, "rgba(128,128,128,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // 高频细颗粒
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 12;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  _brushTex = tex;
  return tex;
}

/** 光遇式明暗渐变曲线：暗部提亮 + smoothstep 中间调压缩 */
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
  const brush = brushTexture();
  const cache = new Map<string, THREE.Material>();
  return {
    gradient,
    mat(color, vertexColors = false) {
      const key = `${color}|${vertexColors}`;
      let m = cache.get(key);
      if (!m) {
        // 全局降饱和：向自身灰度靠 15%，光遇的色板统一克制
        const c = new THREE.Color(color);
        const l = (c.r + c.g + c.b) / 3;
        c.lerp(new THREE.Color(l, l, l), 0.15);
        m = new THREE.MeshToonMaterial({
          color: c,
          gradientMap: gradient,
          map: brush,
          vertexColors,
        });
        cache.set(key, m);
      }
      return m;
    },
    dispose() {
      gradient.dispose();
      cache.forEach((m) => m.dispose());
    },
  };
}
