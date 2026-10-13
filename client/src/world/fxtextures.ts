import * as THREE from "three";

/**
 * 共享的「柔光贴图」工厂。
 *
 * 为什么需要：整套特效（余烬/扑翼/节拍涟漪/语音环/光尘/云朵）原来都用**硬边几何**
 * 表现发光——小球、圆环、方片。硬边 + 加法混合的观感是"程序员美术"，
 * 也是本项目和《光遇》差距里最暴露的一处。
 *
 * 光遇里所有发光体的共同点是：亮度从中心向外**极柔地衰减**，边缘完全看不到边界。
 * 这里把所有此类贴图集中到一处，保证全项目用同一套衰减曲线。
 *
 * 贴图都按 sRGB 声明（canvas 里画的是 sRGB 灰度），采样后由 three 转到线性工作空间。
 */

const TEX = 64;

function makeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement("canvas");
  cv.width = cv.height = TEX;
  return [cv, cv.getContext("2d")!];
}

function asTexture(cv: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

let _dot: THREE.Texture | null = null;
/**
 * 极柔的圆形光点（光尘 / 余烬 / 扑翼珠 / 头顶烛光 / 音符）。
 * 衰减曲线：1.0@0 → 0.45@0.25 → 0.08@0.65 → 0@1
 */
export function softDotTexture(): THREE.Texture {
  if (_dot) return _dot;
  const [cv, ctx] = makeCanvas();
  const g = ctx.createRadialGradient(TEX / 2, TEX / 2, 0, TEX / 2, TEX / 2, TEX / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.45)");
  g.addColorStop(0.65, "rgba(255,255,255,0.08)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TEX, TEX);
  _dot = asTexture(cv);
  return _dot;
}

let _ring: THREE.Texture | null = null;
/**
 * 极柔的圆环（节拍涟漪 / 语音环 / 牵手光带端点）。
 * 峰在 r=0.72，内外两侧都平滑落到 0——**没有硬边**。
 */
export function softRingTexture(): THREE.Texture {
  if (_ring) return _ring;
  const [cv, ctx] = makeCanvas();
  const g = ctx.createRadialGradient(TEX / 2, TEX / 2, 0, TEX / 2, TEX / 2, TEX / 2);
  g.addColorStop(0.00, "rgba(255,255,255,0)");
  g.addColorStop(0.38, "rgba(255,255,255,0.02)");
  g.addColorStop(0.62, "rgba(255,255,255,0.55)");
  g.addColorStop(0.72, "rgba(255,255,255,1)");
  g.addColorStop(0.84, "rgba(255,255,255,0.35)");
  g.addColorStop(1.00, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TEX, TEX);
  _ring = asTexture(cv);
  return _ring;
}

let _streak: THREE.Texture | null = null;
/**
 * 柔光横条（风线 / 光带）。左右两端柔和淡出，中间略亮。
 */
export function softStreakTexture(): THREE.Texture {
  if (_streak) return _streak;
  const [cv, ctx] = makeCanvas();
  const g = ctx.createLinearGradient(0, 0, TEX, 0);
  g.addColorStop(0.0, "rgba(255,255,255,0)");
  g.addColorStop(0.22, "rgba(255,255,255,0.55)");
  g.addColorStop(0.5, "rgba(255,255,255,1)");
  g.addColorStop(0.78, "rgba(255,255,255,0.55)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TEX, TEX);
  // 纵向再乘一层柔化，避免上下出现硬边
  const v = ctx.createLinearGradient(0, 0, 0, TEX);
  v.addColorStop(0.0, "rgba(0,0,0,1)");
  v.addColorStop(0.5, "rgba(0,0,0,0)");
  v.addColorStop(1.0, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, TEX, TEX);
  ctx.globalCompositeOperation = "source-over";
  _streak = asTexture(cv);
  return _streak;
}

let _puff: THREE.Texture | null = null;
/**
 * 云朵 puff：比 softDot 略"饱满"（肩部更靠外），用于云的 impostor 单元。
 * 真正让它有体积感的是**片元里用 UV 反推半球法线再做受光**，这只是一张 alpha 形状。
 */
export function puffTexture(): THREE.Texture {
  if (_puff) return _puff;
  const [cv, ctx] = makeCanvas();
  const g = ctx.createRadialGradient(TEX / 2, TEX / 2, 0, TEX / 2, TEX / 2, TEX / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.92)");
  g.addColorStop(0.72, "rgba(255,255,255,0.42)");
  g.addColorStop(0.88, "rgba(255,255,255,0.10)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TEX, TEX);
  // 边缘加一点低频扰动，避免每朵都是完美正圆
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + Math.random() * 0.3;
    const rr = TEX * 0.44;
    const x = TEX / 2 + Math.cos(a) * rr;
    const y = TEX / 2 + Math.sin(a) * rr;
    const r = 4 + Math.random() * 9;
    const bg = ctx.createRadialGradient(x, y, 0, x, y, r);
    bg.addColorStop(0, "rgba(0,0,0,0.5)");
    bg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = bg;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalCompositeOperation = "source-over";
  _puff = asTexture(cv);
  return _puff;
}
