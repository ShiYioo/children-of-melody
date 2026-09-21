import * as THREE from "three";
import { terrainHeight } from "../heightfield";

/**
 * 漂浮光尘（岛上处处可见的暖色微光）、
 * 篝火余烬（升起又熄灭的小火星）。
 */

interface DriftPoints {
  points: THREE.Points;
  update: (t: number) => void;
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
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * area.r;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
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

/** 全岛漂浮的暖色光尘 */
/** 全岛漂浮的暖色光尘（只撒陆地上空 r<38——岸环洼地 r≈45+ 是湖，
 *  闪烁光点落在暗水面上+Bloom 放大 = 整片湖"蹦迪"） */
export function createMotes(): DriftPoints {
  return makeDriftPoints({
    count: 380,
    color: "#ffe9b8",
    area: { r: 38, yMin: 0.6, yMax: 13 },
    size: 0.5,
    drift: 1.4,
    opacity: 0.5,
  });
}

/** 林地里的萤光（淡绿偏暖，贴近树梢高度；中心收进内陆，最远 r≈30 不碰湖） */
export function createFireflies(): DriftPoints {
  return makeDriftPoints({
    count: 90,
    color: "#e5ffb0",
    area: { r: 16, yMin: 1.2, yMax: 4.5 },
    size: 0.42,
    drift: 0.9,
    opacity: 0.75,
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
