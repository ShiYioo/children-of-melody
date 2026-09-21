import * as THREE from "three";
import { WATER_LEVEL } from "../heightfield";

interface WaterPhase {
  sunDir: THREE.Vector3;
  fogColor: THREE.Color;
  fogDensity: number;
  skyHi: THREE.Color;
  skyLo: THREE.Color;
  specColor: THREE.Color;
  night: number;
}

interface WaterLayer {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

const NEAR_WATER_RADIUS = 120;
const OCEAN_RADIUS = 500;

const TERRAIN_GLSL = /* glsl */ `
  float smoothstep_(float a, float b, float x) {
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }

  float terrainH(vec2 p) {
    float r = length(p);
    float ang = atan(p.y, p.x);
    float ef = 0.82 + 0.14 * sin(ang * 3.0 + 1.7) + 0.07 * sin(ang * 7.0 + 0.4);
    float rr = r / (58.0 * ef);
    if (rr >= 1.0) return -1.6 - (rr - 1.0) * 60.0;
    float h = 5.5 * pow(max(0.0, 1.0 - rr), 1.25) + 1.2;
    vec2 d = p - vec2(26.0, -28.0);
    h += 9.5 * exp(-dot(d, d) / 320.0);
    float n = 0.8 * sin(p.x * 0.16 + 2.1) * cos(p.y * 0.13 - 1.2)
            + 0.5 * sin(p.x * 0.31) * sin(p.y * 0.27 + 0.8);
    h += n * smoothstep_(7.0, 20.0, r);
    h = mix(h, 1.25, min(1.0, 1.15 * exp(-r * r / 72.0)));
    return mix(h, -1.6, smoothstep_(0.86, 1.0, rr));
  }
`;

function makeMaterial(animated: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: false,
    depthTest: true,
    depthWrite: true,
    polygonOffset: !animated,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms: {
      uTime: { value: 0 },
      // 近岸只流动法线和色泽，远海才位移几何。
      uMotion: { value: animated ? 1 : 0.24 },
      uDisplacement: { value: animated ? 1 : 0 },
      uClipShore: { value: animated ? 0 : 1 },
      uSunDir: { value: new THREE.Vector3(-0.62, 0.17, -0.42).normalize() },
      uFogColor: { value: new THREE.Color("#eecfa4") },
      uFogDensity: { value: 0.0042 },
      uCamPos: { value: new THREE.Vector3() },
      uSkyHi: { value: new THREE.Color("#3b4a8f") },
      uSkyLo: { value: new THREE.Color("#ffd9a3") },
      uSpecColor: { value: new THREE.Color("#ffe0a0") },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uMotion;
      uniform float uDisplacement;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vRipple;

      float waveH(vec2 p, float t) {
        return sin(p.x * 0.11 + t * 0.55) * 0.10
             + sin(p.y * 0.09 - t * 0.43) * 0.08
             + sin((p.x + p.y) * 0.18 + t * 0.82) * 0.04;
      }

      void main() {
        vec3 pos = position;
        vec2 xz = (modelMatrix * vec4(pos, 1.0)).xz;
        float wave = waveH(xz, uTime);
        pos.y += wave * uDisplacement;

        float e = 1.5;
        float hx = waveH(xz + vec2(e, 0.0), uTime) - waveH(xz - vec2(e, 0.0), uTime);
        float hz = waveH(xz + vec2(0.0, e), uTime) - waveH(xz - vec2(0.0, e), uTime);
        vec3 waveNormal = normalize(vec3(-hx, 2.0 * e, -hz));
        vNormal = normalize(mix(vec3(0.0, 1.0, 0.0), waveNormal, uMotion));
        vRipple = wave;
        vWorld = (modelMatrix * vec4(pos, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uClipShore;
      uniform float uMotion;
      uniform vec3 uSunDir;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform vec3 uCamPos;
      uniform vec3 uSkyHi;
      uniform vec3 uSkyLo;
      uniform vec3 uSpecColor;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vRipple;

      ${TERRAIN_GLSL}

      void main() {
        float th = terrainH(vWorld.xz);
        if (uClipShore > 0.5 && th >= ${(WATER_LEVEL - 0.02).toFixed(2)}) discard;

        float depth = clamp((${WATER_LEVEL.toFixed(2)} - th) / 2.2, 0.0, 1.0);
        vec3 shallow = vec3(0.35, 0.80, 0.72);
        vec3 deep = vec3(0.07, 0.27, 0.50);
        vec3 col = mix(shallow, deep, smoothstep(0.05, 0.75, depth));
        // 大面积、低对比度的明暗流动，模拟《光·遇》水彩般的水纹，不做闪烁亮点。
        col += vec3(0.08, 0.14, 0.16) * vRipple * uMotion;

        vec3 V = normalize(uCamPos - vWorld);
        vec3 N = normalize(vNormal);
        float fresnel = pow(1.0 - max(dot(V, N), 0.0), 3.0);
        vec3 skyRef = mix(uSkyLo, uSkyHi, clamp(N.y, 0.0, 1.0));
        col = mix(col, skyRef, fresnel * 0.42);

        vec3 R = reflect(-V, N);
        // 宽而弱的波光，避免旧版高指数高光像频闪灯一样跳动。
        float spec = pow(max(dot(R, uSunDir), 0.0), 18.0);
        col += uSpecColor * spec * mix(0.10, 0.22, uMotion);

        // 近岸亮边是静态等高线，不再使用随时间脉冲的泡沫。
        float shore = 1.0 - smoothstep_(0.0, 0.7, abs(th - ${WATER_LEVEL.toFixed(2)}));
        col = mix(col, vec3(1.0, 0.97, 0.9), shore * 0.34);

        float dist = length(uCamPos - vWorld);
        float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
        col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

function createNearWater(): WaterLayer {
  // 径向细分让缓慢法线流动连续；几何高度本身始终固定。
  const geometry = new THREE.RingGeometry(0, NEAR_WATER_RADIUS, 256, 32);
  geometry.rotateX(-Math.PI / 2);
  const material = makeMaterial(false);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = WATER_LEVEL;
  mesh.renderOrder = 1;
  return { mesh, material };
}

function createOcean(): WaterLayer {
  const geometry = new THREE.RingGeometry(NEAR_WATER_RADIUS, OCEAN_RADIUS, 256, 24);
  geometry.rotateX(-Math.PI / 2);
  const material = makeMaterial(true);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = WATER_LEVEL;
  return { mesh, material };
}

/** 近岸静水与远海分层渲染；出生点周围水体从几何和材质上都不参与远海动画。 */
export function createWater(camera: THREE.Camera): {
  mesh: THREE.Group;
  update: (t: number) => void;
  setPhase: (phase: WaterPhase) => void;
} {
  const near = createNearWater();
  const ocean = createOcean();
  const group = new THREE.Group();
  group.add(near.mesh, ocean.mesh);
  const layers = [near, ocean];

  return {
    mesh: group,
    update: (t) => {
      near.material.uniforms.uTime.value = t;
      ocean.material.uniforms.uTime.value = t;
      for (const layer of layers) layer.material.uniforms.uCamPos.value.copy(camera.position);
    },
    setPhase: (phase) => {
      for (const { material } of layers) {
        material.uniforms.uSunDir.value.copy(phase.sunDir).normalize();
        material.uniforms.uFogColor.value.copy(phase.fogColor);
        material.uniforms.uFogDensity.value = phase.fogDensity;
        material.uniforms.uSkyHi.value.copy(phase.skyHi);
        material.uniforms.uSkyLo.value.copy(phase.skyLo);
        material.uniforms.uSpecColor.value.copy(phase.specColor);
      }
    },
  };
}
