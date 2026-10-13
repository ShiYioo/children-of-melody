import * as THREE from "three";
import { terrainHeight, WATER_LEVEL } from "../heightfield";
import { lightState } from "./lightstate";
import { softDotTexture } from "./fxtextures";

/**
 * 漂浮光尘（岛上处处可见的暖色微光）、
 * 篝火余烬（升起又熄灭的小火星）。
 */

interface DriftPoints {
  points: THREE.Points;
  update: (t: number) => void;
}

const DRY_GROUND_MARGIN = 0.35;

// ---- 屏幕空间点径 ----
// 原来顶点着色器里写死 `gl_PointSize = uSize * (140.0 / -mv.z)`。140 等于隐式假设
// 画布高 280px（three 的 PointsMaterial 用的是 height*0.5），一旦视口高度或
// 设备像素比变了，所有光点的粗细就跟着变、且和别的粒子系统对不上。
// 这里把 720p 下已经调好的观感固化成参考值，实际按 drawing buffer 高度等比缩放。
const SIZE_K = 140;
const SIZE_REF_H = 720;
function drawingBufferHeight(): number {
  return window.innerHeight * (window.devicePixelRatio || 1);
}
const pointSizeScale = (bufH: number) => SIZE_K * (bufH / SIZE_REF_H);

/** 粒子会在着色器里水平漂移；整段漂移范围都必须留在旱地上。 */
function driftStaysOnDryGround(x: number, z: number, drift: number): boolean {
  const dryHeight = WATER_LEVEL + DRY_GROUND_MARGIN;
  // x/z 使用不同频率摆动，长期会覆盖 [-drift, drift]²，而不只是一条圆周。
  // 取 5×5 网格检查整个包围盒；0.35m 的高度余量覆盖采样点之间的岸坡变化。
  for (let ix = -2; ix <= 2; ix++) {
    for (let iz = -2; iz <= 2; iz++) {
      if (terrainHeight(x + ix * drift * 0.5, z + iz * drift * 0.5) <= dryHeight) return false;
    }
  }
  return true;
}

/** 通用：加法混合的漂浮光点，缓慢游移 */
function makeDriftPoints(opts: {
  count: number;
  color: string;
  area: { r: number; yMin: number; yMax: number };
  size: number;
  drift: number;
  opacity: number;
  center?: [number, number];
}): DriftPoints {
  const { count, color, area, size, drift, opacity } = opts;
  const cx = opts.center?.[0] ?? 0;
  const cz = opts.center?.[1] ?? 0;

  const geo = new THREE.BufferGeometry();
  const base = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // 闪烁光点悬在暗水面上会被 Bloom 放大成整片湖“蹦迪”。不仅检查初始落点，
    // 还检查着色器中的完整漂移范围；持续采样到合格，避免尝试耗尽后把水面坐标写进去。
    let x: number;
    let z: number;
    do {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * area.r;
      x = cx + Math.cos(a) * r;
      z = cz + Math.sin(a) * r;
    } while (!driftStaysOnDryGround(x, z, drift));
    const y = area.yMin + Math.random() * (area.yMax - area.yMin);
    base[i * 3] = x;
    base[i * 3 + 1] = y;
    base[i * 3 + 2] = z;
    phase[i] = Math.random() * Math.PI * 2;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(base.slice(), 3));
  geo.setAttribute("aBase", new THREE.BufferAttribute(base, 3));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size },
      uDrift: { value: drift },
      uOpacity: { value: opacity },
      uEmissive: { value: lightState.fxGain() },
      uSizePx: { value: pointSizeScale(drawingBufferHeight()) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uSize;
      uniform float uDrift;
      uniform float uSizePx;
      attribute vec3 aBase;
      attribute float aPhase;
      varying float vTw;
      void main() {
        vec3 p = aBase;
        p.x += sin(uTime * 0.3 + aPhase) * uDrift;
        p.y += sin(uTime * 0.2 + aPhase * 1.7) * uDrift * 0.6;
        p.z += cos(uTime * 0.26 + aPhase) * uDrift;
        // 呼吸幅度收窄到 0.4~1.0。原来 0.10~1.00，大部分时间在 bloom 阈值上下反复
        // 穿越，读起来是"忽明忽灭的斑点"；收窄之后是"一直在发光、只是明暗在变"。
        vTw = 0.7 + 0.3 * sin(uTime * 1.5 + aPhase * 3.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * uSizePx / -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uEmissive;
      varying float vTw;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.05, length(d));
        // 亮度折进**颜色**而不是 alpha：加法混合下实际贡献是 color*a，
        // 而 bloom 的高通作用在线性、未色调映射的值上、阈值 0.8。
        // 原来 color 亮度 0.830 × opacity 0.35 × 闪烁，峰值只有 0.29 ——
        // 这个光点在物理上永远不可能泛光。乘 uEmissive 之后才真的"发光"。
        gl_FragColor = vec4(uColor * uOpacity * vTw * uEmissive, a);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return {
    points,
    update: (t) => {
      mat.uniforms.uTime.value = t;
      // 自发光增益跟着昼夜走：环境越暗，光点越显眼
      mat.uniforms.uEmissive.value = lightState.fxGain();
      // 视口尺寸可能变（窗口缩放/旋转）：点径按 drawing buffer 高度等比跟随
      const s = pointSizeScale(drawingBufferHeight());
      if (mat.uniforms.uSizePx.value !== s) mat.uniforms.uSizePx.value = s;
    },
  };
}

/** 全岛漂浮的暖色光尘（落点按地形高度过滤，只出现在旱地上空）。
 *  数量与亮度收着：光遇的空气是干净的，光尘是偶尔一粒而不是漫天飞 */
export function createMotes(): DriftPoints {
  return makeDriftPoints({
    count: 240,
    color: "#ffe9b8",
    area: { r: 52, yMin: 0.6, yMax: 13 },
    size: 0.42,
    drift: 1.4,
    // 0.35 → 0.5：配合 fxGain() 把峰值线性亮度从 0.29 抬到 1.33，才过得了 bloom
    // 阈值 0.8。亮度不再靠"画一个更亮的圆点"来假装，而是真的进入 HDR 泛光。
    opacity: 0.5,
  });
}

/** 林地里的萤光（淡绿偏暖，贴近树梢高度；落点地形过滤，不会漂到湖面） */
export function createFireflies(): DriftPoints {
  return makeDriftPoints({
    count: 55,
    color: "#e5ffb0",
    area: { r: 20, yMin: 1.2, yMax: 4.5 },
    size: 0.42,
    drift: 0.9,
    opacity: 0.6,
    center: [-12, -18],
  });
}

/** 篝火余烬：从火堆升起、摇曳、熄灭 */
export function createEmbers(): DriftPoints & { rise: (dt: number) => void } {
  const count = 46;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count);
  const life = new Float32Array(count);
  const maxY = 3.4;
  for (let i = 0; i < count; i++) {
    respawn(i, true);
    function respawn(i: number, init: boolean) {
      pos[i * 3] = (Math.random() - 0.5) * 0.5;
      pos[i * 3 + 1] = init ? Math.random() * maxY : 0.15;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
      vel[i] = 0.5 + Math.random() * 0.7;
      life[i] = Math.random();
    }
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

  // 余烬：必须给贴图。three 的 points.glsl.js 只在 `#ifdef USE_MAP` 下采样
  // gl_PointCoord —— 不配 map 的 PointsMaterial 渲染出来是**实心方块**。
  // 颜色同样要乘 HDR 增益：`#ffc07a` 线性亮度 0.543 × opacity 0.9 = 0.49，
  // 一直在 bloom 阈值 0.8 以下，火星子从来没有真正发过光。
  const emberBase = new THREE.Color("#ffc07a");
  const mat = new THREE.PointsMaterial({
    color: emberBase.clone().multiplyScalar(lightState.fxGain()),
    map: softDotTexture(),
    size: 0.11,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geo, mat);
  const origin = new THREE.Vector3(0, terrainHeight(0, 0) + 0.4, 0);
  points.position.copy(origin);
  points.frustumCulled = false;

  const drift = makeDriftNudge();
  function makeDriftNudge() {
    return (dt: number, t: number) => {
      const arr = (geo.attributes.position as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < count; i++) {
        arr[i * 3 + 1] += vel[i] * dt;
        arr[i * 3] += Math.sin(t * 2.5 + i * 1.7) * 0.12 * dt;
        arr[i * 3 + 2] += Math.cos(t * 2.1 + i * 2.3) * 0.12 * dt;
        if (arr[i * 3 + 1] > maxY) {
          arr[i * 3] = (Math.random() - 0.5) * 0.5;
          arr[i * 3 + 1] = 0.15;
          arr[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
        }
      }
      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    };
  }

  return {
    points,
    update: () => {
      // 从基准色 copy 再乘，绝不在原地累乘（那是指数爆炸）
      mat.color.copy(emberBase).multiplyScalar(lightState.fxGain());
    },
    rise: (dt) => drift(dt, performance.now() / 1000),
  };
}
