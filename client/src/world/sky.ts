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
export function createSky(): {
  mesh: THREE.Mesh;
  update: (t: number) => void;
  apply: (p: SkyPalette, sunDir?: THREE.Vector3, moonDir?: THREE.Vector3, sunVis?: number, moonVis?: number) => void;
} {
  const sunDir = new THREE.Vector3(-0.62, 0.17, -0.42).normalize();
  const moonDir = new THREE.Vector3(0.62, 0.4, 0.42).normalize();

  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir },
      uMoonDir: { value: moonDir },
      uSunVis: { value: 1 },
      uMoonVis: { value: 0 },
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
      uniform vec3 uMoonDir;
      uniform float uSunVis;
      uniform float uMoonVis;
      uniform vec3 cZenith, cMid, cRose, cHorizon, cSea;
      varying vec3 vDir;

      float hash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }

      /**
       * 星点场。
       *
       * 旧实现是 step(0.9975, hash(floor(d * 220.0))) —— 星点只有**次像素**大，
       * 而且是硬阶跃：相机一转，floor 出来的 cell 就整块跳变，星星于是闪烁、爬行，
       * 甚至成片地冒出来又消失。这是程序化星空最典型的假象。
       *
       * 改成：每个 cell 里放一颗**有确定位置**的星心，用「到星心的距离」做柔和衰减，
       * 并对 2×2×2 邻域求和 —— 星点因此是连续的，跨 cell 边界也不会断开。
       * 星心位置也参与随机，所以星星不会排成规则的格子。
       */
      float starField(vec3 d) {
        vec3 p = d * 110.0;
        vec3 base = floor(p);
        float acc = 0.0;
        // 用三重循环而不是位运算枚举邻域：GLSL ES 1.00 没有 >> 和 &，
        // three 在 WebGL2 下也未必帮忙升级，能不用就不用。
        for (int ix = -1; ix <= 0; ix++)
        for (int iy = -1; iy <= 0; iy++)
        for (int iz = -1; iz <= 0; iz++) {
          vec3 c = base + vec3(float(ix), float(iy), float(iz));
          float seed = hash(c);
          if (seed < 0.982) continue;                        // 只有约 1.8% 的 cell 有星
          float bright = hash(c + 3.7);
          vec3 center = c + vec3(hash(c + 1.3), hash(c + 2.1), hash(c + 5.9));
          float r = 0.055 + 0.075 * bright;                   // 半径下限，保证跨 1~2 像素
          float tw = 0.62 + 0.38 * sin(uTime * (0.7 + bright * 2.4) + seed * 40.0);
          acc += smoothstep(r, 0.0, length(p - center)) * (0.30 + 0.70 * bright) * tw;
        }
        return acc;
      }

      /** 一个高斯形状的霾带：中心 h0，厚度 1/k */
      float hazeBand(float h, float h0, float k) {
        float t = (h - h0) * k;
        return exp(-t * t);
      }

      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;

        vec3 col = mix(cHorizon, cRose, smoothstep(-0.05, 0.12, h));
        col = mix(col, cMid, smoothstep(0.08, 0.34, h));
        col = mix(col, cZenith, smoothstep(0.26, 0.68, h));
        // 地平线以下沉入海面的暖雾
        col = mix(cSea, col, smoothstep(-0.12, 0.02, h));

        // 太阳：大范围柔光 + 亮核（随 uSunVis 在地平线处升落淡入淡出）
        float sd = max(dot(d, uSunDir), 0.0);
        col += vec3(1.0, 0.85, 0.6) * pow(sd, 20.0) * 0.55 * uSunVis;
        col += vec3(0.98, 0.9, 0.72) * pow(sd, 300.0) * 1.1 * uSunVis;
        // 月亮：独立天体，自己的方向与升落——清冷圆面 + 月晕
        float md = max(dot(d, uMoonDir), 0.0);
        col += vec3(0.93, 0.96, 1.0) * pow(md, 1800.0) * 1.3 * uMoonVis;
        col += vec3(0.72, 0.8, 1.0) * pow(md, 48.0) * 0.16 * uMoonVis;

        // ---- 地平线霾带 ----
        // 原来天空是一条干净的三段渐变，地平线附近什么都没有，"远处还有什么"
        // 完全没有交代，远景因此显得空。这里叠三层不同高度的软雾带，
        // 并用方位角调制出断续的条理（不然就是三个同心圆环，很假）。
        float az = atan(d.z, d.x);
        float streak = 0.62 + 0.38 * sin(az * 3.0 + 1.3) * sin(az * 5.0 - 0.7);
        // 面向太阳那一侧的霾带更亮（逆光时地平线发白），这是实拍里最明显的特征
        vec2 dh = normalize(vec2(d.x, d.z) + 1e-4);
        vec2 sh = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-4);
        float sunAz = 0.55 + 0.45 * max(0.0, dot(dh, sh));
        float band = hazeBand(h, 0.015, 15.0)
                   + 0.55 * hazeBand(h, 0.095, 21.0)
                   + 0.30 * hazeBand(h, 0.215, 27.0);
        band = clamp(band * streak * sunAz, 0.0, 1.0);
        col = mix(col, mix(cHorizon, cRose, 0.32), band * 0.34 * (1.0 - uNight * 0.55));

        // ---- 星点 ----
        // 整段用 uniform 分支包住：白天（uNight≈0）这 8 次邻域 × 4 次 hash 完全不执行。
        // 分支在整个 draw 上是一致的（所有像素走同一条路），几乎没有开销。
        if (uNight > 0.02) {
          // 星星要一直铺到地平线，只在贴近地平线处被霾带吃掉 ——
          // 原来只在 h > 0.18 以上才有星，低空是一片死黑。
          float starZone = smoothstep(-0.03, 0.20, h);
          col += vec3(0.88, 0.90, 1.0) * starField(d) * starZone * clamp(uNight * 1.6, 0.0, 1.0);
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(850, 32, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;

  return {
    mesh,
    update: (t: number) => {
      mat.uniforms.uTime.value = t;
      // 太阳方向由 apply() 从场景光源位置统一设定（圆盘/光柱/水面波光/月亮必须同一个方向，
      // 各自为政就会出现"光柱斜这边、太阳在那边"的穿帮）
    },
    apply: (p: SkyPalette, sunD?: THREE.Vector3, moonD?: THREE.Vector3, sunVis = 1, moonVis = 0) => {
      mat.uniforms.uNight.value = p.night;
      (mat.uniforms.cZenith.value as THREE.Color).copy(p.zenith);
      (mat.uniforms.cMid.value as THREE.Color).copy(p.mid);
      (mat.uniforms.cRose.value as THREE.Color).copy(p.rose);
      (mat.uniforms.cHorizon.value as THREE.Color).copy(p.horizon);
      (mat.uniforms.cSea.value as THREE.Color).copy(p.sea);
      if (sunD) sunDir.copy(sunD).normalize();
      if (moonD) moonDir.copy(moonD).normalize();
      mat.uniforms.uSunVis.value = sunVis;
      mat.uniforms.uMoonVis.value = moonVis;
    },
  };
}
