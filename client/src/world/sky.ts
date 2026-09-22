import * as THREE from "three";

/** 一套天空调色（昼夜循环用） */
export interface SkyPalette {
  zenith: THREE.Color;
  mid: THREE.Color;
  rose: THREE.Color;
  horizon: THREE.Color;
  sea: THREE.Color;
  night: number; // 0 白昼 → 1 深夜（星星亮度/日光余晖切换）
  sunEl: number; // 太阳高度（0~1）
}

/**
 * 黄昏天空穹顶：暖金地平线 → 玫瑰 → 紫罗兰 → 暮蓝天顶，
 * 低垂的太阳与最早亮起的几颗星。昼夜循环时整套调色由 setDayPhase 驱动。
 */
export function createSky(): { mesh: THREE.Mesh; update: (t: number) => void; apply: (p: SkyPalette, sunPos?: THREE.Vector3) => void } {
  const sunDir = new THREE.Vector3(-0.62, 0.17, -0.42).normalize();

  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir },
      uNight: { value: 0 },
      cZenith: { value: new THREE.Color("#3b4a8f") },
      cMid: { value: new THREE.Color("#9a7bc0") },
      cRose: { value: new THREE.Color("#f2a48f") },
      cHorizon: { value: new THREE.Color("#ffd9a3") },
      cSea: { value: new THREE.Color("#e8c9a8") },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uNight;
      uniform vec3 uSunDir;
      uniform vec3 cZenith, cMid, cRose, cHorizon, cSea;
      varying vec3 vDir;

      float hash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }

      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;

        vec3 col = mix(cHorizon, cRose, smoothstep(-0.05, 0.12, h));
        col = mix(col, cMid, smoothstep(0.08, 0.34, h));
        col = mix(col, cZenith, smoothstep(0.26, 0.68, h));
        // 地平线以下沉入海面的暖雾
        col = mix(cSea, col, smoothstep(-0.12, 0.02, h));

        // 太阳：大范围柔光 + 亮核（夜里换成月光，余晖收掉）
        float sd = max(dot(d, uSunDir), 0.0);
        col += vec3(1.0, 0.85, 0.6) * pow(sd, 20.0) * 0.55 * (1.0 - uNight * 0.8);
        col += vec3(0.85, 0.92, 1.0) * pow(sd, 300.0) * (mix(1.1, 0.5, uNight));
        // 月亮：夜里的光源位置就是月亮方向——清冷的圆面 + 一圈月晕（光遇的月）
        col += vec3(0.93, 0.96, 1.0) * pow(sd, 1800.0) * 1.3 * uNight;
        col += vec3(0.72, 0.8, 1.0) * pow(sd, 48.0) * 0.16 * uNight;

        // 星星：入夜后铺满天空，缓慢闪烁
        float starZone = smoothstep(0.18, 0.5, h);
        vec3 cell = floor(d * 220.0);
        float star = step(0.9975, hash(cell));
        float tw = 0.5 + 0.5 * sin(uTime * (1.0 + hash(cell + 7.0) * 2.0) + hash(cell) * 40.0);
        col += vec3(0.9, 0.9, 1.0) * star * starZone * tw * mix(0.55, 2.6, uNight);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(850, 32, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;

  let sunElBase = 0.17;
  return {
    mesh,
    update: (t: number) => {
      mat.uniforms.uTime.value = t;
      // 太阳方向由 apply() 从场景光源位置统一设定（圆盘/光柱/水面波光/月亮必须同一个方向，
      // 各自为政就会出现"光柱斜这边、太阳在那边"的穿帮）
    },
    apply: (p: SkyPalette, sunPos?: THREE.Vector3) => {
      mat.uniforms.uNight.value = p.night;
      (mat.uniforms.cZenith.value as THREE.Color).copy(p.zenith);
      (mat.uniforms.cMid.value as THREE.Color).copy(p.mid);
      (mat.uniforms.cRose.value as THREE.Color).copy(p.rose);
      (mat.uniforms.cHorizon.value as THREE.Color).copy(p.horizon);
      (mat.uniforms.cSea.value as THREE.Color).copy(p.sea);
      if (sunPos) {
        sunDir.copy(sunPos).normalize();
      } else {
        sunElBase = 0.05 + p.sunEl * 0.55;
        sunDir.set(-0.62, sunElBase, -0.42).normalize();
      }
    },
  };
}
