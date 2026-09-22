import * as THREE from "three";
import { terrainHeight, WATER_LEVEL } from "../heightfield";

/**
 * 漂浮光尘（岛上处处可见的暖色微光）、
 * 篝火余烬（升起又熄灭的小火星）。
 */

interface DriftPoints {
  points: THREE.Points;
  update: (t: number) => void;
}

const DRY_GROUND_MARGIN = 0.35;

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
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uSize;
      uniform float uDrift;
      attribute vec3 aBase;
      attribute float aPhase;
      varying float vTw;
      void main() {
        vec3 p = aBase;
        p.x += sin(uTime * 0.3 + aPhase) * uDrift;
        p.y += sin(uTime * 0.2 + aPhase * 1.7) * uDrift * 0.6;
        p.z += cos(uTime * 0.26 + aPhase) * uDrift;
        vTw = 0.55 + 0.45 * sin(uTime * 1.5 + aPhase * 3.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * (140.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vTw;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.05, length(d));
        gl_FragColor = vec4(uColor, a * uOpacity * vTw);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, update: (t) => (mat.uniforms.uTime.value = t) };
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
    opacity: 0.35,
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

  const mat = new THREE.PointsMaterial({
    color: "#ffc07a",
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
    update: (t) => void t,
    rise: (dt) => drift(dt, performance.now() / 1000),
  };
}
