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
    // 台地化：必须与 heightfield.ts 的 terrace() 逐字一致，
    // 否则水面与岸线的交界会错位。半带宽偏移、以及「岸边淡出」的理由见那边的注释。
    float BAND = 1.35;
    float tb = (h + BAND * 0.5) / BAND;
    float ti = floor(tb);
    float ht2 = (ti + smoothstep_(0.55, 1.0, tb - ti)) * BAND - BAND * 0.5;
    h = mix(h, ht2, smoothstep_(1.55, 2.8, h));
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
      // 夜晚度：水体本色必须跟着它走（见片元着色器里的说明）
      uNight: { value: 0 },
      // 波光（太阳/月亮在水面的碎闪）的 HDR 增益
      uGlint: { value: 1.9 },
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
      uniform float uNight;
      uniform float uGlint;
      uniform float uTime; // 片元里的细波也要随时间动（原来只在顶点着色器里声明过）
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vRipple;

      ${TERRAIN_GLSL}

      void main() {
        float th = terrainH(vWorld.xz);
        if (uClipShore > 0.5 && th >= ${(WATER_LEVEL - 0.02).toFixed(2)}) discard;

        float depth = clamp((${WATER_LEVEL.toFixed(2)} - th) / 2.2, 0.0, 1.0);
        // 水体本色必须跟着昼夜走 —— 这原来是一处和雾、灯光完全同类的漏法：
        // shallow / deep 是写死的，夜里海面还是白天的亮青绿。
        // WaterPhase 里一直带着 night 字段，setPhase 却从来没读它。
        vec3 shallow = mix(vec3(0.35, 0.80, 0.72), vec3(0.045, 0.105, 0.175), uNight);
        vec3 deep = mix(vec3(0.07, 0.27, 0.50), vec3(0.010, 0.026, 0.070), uNight);
        vec3 col = mix(shallow, deep, smoothstep(0.05, 0.75, depth));
        // 大面积、低对比度的明暗流动，模拟《光·遇》水彩般的水纹
        col += vec3(0.08, 0.14, 0.16) * vRipple * uMotion * (1.0 - uNight * 0.65);

        vec3 V = normalize(uCamPos - vWorld);
        vec3 N = normalize(vNormal);

        // ---- 片元级细波法线 ----
        // 旧版把高光全部押在**顶点着色器**的低频波法线上，而近岸网格远处一格的投影
        // 尺寸很大 —— 高光会随网格跳变，看起来像频闪灯。所以上一版只能把高光压成
        // "宽而弱"：峰值亮度 0.771 × 0.22 = 0.17，根本不像波光，也永远过不了 bloom
        // 阈值 0.8。正确做法是把细波放进片元、每像素算一次法线扰动：高光既细腻又稳定，
        // 才敢把它做到 HDR 亮度。
        vec2 wq = vWorld.xz;
        vec2 grad = vec2(0.0);
        grad += vec2(0.86, 0.51) * cos(dot(wq, vec2(0.86, 0.51)) * 1.9 + uTime * 1.9) * 1.9 * 0.0110;
        grad += vec2(-0.45, 0.89) * cos(dot(wq, vec2(-0.45, 0.89)) * 3.3 - uTime * 1.5) * 3.3 * 0.0080;
        grad += vec2(0.32, -0.95) * cos(dot(wq, vec2(0.32, -0.95)) * 5.7 + uTime * 2.7) * 5.7 * 0.0045;
        grad += vec2(-0.94, -0.34) * cos(dot(wq, vec2(-0.94, -0.34)) * 9.1 + uTime * 3.7) * 9.1 * 0.0022;
        N = normalize(N + vec3(-grad.x, 0.0, -grad.y) * uMotion);

        float fresnel = pow(1.0 - max(dot(V, N), 0.0), 3.0);
        vec3 skyRef = mix(uSkyLo, uSkyHi, clamp(N.y, 0.0, 1.0));
        // 菲涅尔反射在夜里也要收着：否则暗环境里整片海被天光"提亮"成一面镜子
        col = mix(col, skyRef, fresnel * (0.42 - 0.20 * uNight));

        vec3 R = reflect(-V, N);
        float ndl = max(dot(R, uSunDir), 0.0);
        // 两层：宽而柔的整体光泽（不追求过阈值）＋ 窄而亮的碎闪（进 HDR）。
        // 阳光在水面上的反光是自然界最亮的东西之一，把它放进 HDR 是物理正确的，
        // 不是"作弊调亮"。
        col += uSpecColor * pow(ndl, 16.0) * 0.10 * mix(0.45, 1.0, uMotion);
        col += uSpecColor * pow(ndl, 240.0) * uGlint * mix(0.35, 1.0, uMotion) * (1.0 - depth * 0.55);

        // 近岸亮边是静态等高线，不再使用随时间脉冲的泡沫。夜里压暗（白泡沫在暗海里太扎眼）
        float shore = 1.0 - smoothstep_(0.0, 0.7, abs(th - ${WATER_LEVEL.toFixed(2)}));
        col = mix(col, vec3(1.0, 0.97, 0.9), shore * (0.34 - 0.24 * uNight));

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
        // 原来这里**没有**读 phase.night —— 水体本色因此从不随昼夜变化。
        material.uniforms.uNight.value = phase.night;
        // 碎闪的 HDR 增益：白天 1.9、深夜 1.4。
        // 都保证 specColor 线性亮度 0.771 × gain > 0.8，波光才会真的泛光。
        material.uniforms.uGlint.value = 1.9 - phase.night * 0.5;
      }
    },
  };
}
