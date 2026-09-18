import * as THREE from "three";

/**
 * 黄昏天空穹顶：暖金地平线 → 玫瑰 → 紫罗兰 → 暮蓝天顶，
 * 低垂的太阳与最早亮起的几颗星。光遇的"永恒黄昏"。
 */
export function createSky(): { mesh: THREE.Mesh; update: (t: number) => void } {
  const sunDir = new THREE.Vector3(-0.62, 0.17, -0.42).normalize();

  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir },
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

        // 太阳：大范围柔光 + 亮核
        float sd = max(dot(d, uSunDir), 0.0);
        col += vec3(1.0, 0.85, 0.6) * pow(sd, 20.0) * 0.55;
        col += vec3(1.0, 0.95, 0.8) * pow(sd, 300.0) * 1.1;

        // 初升的星星（天顶侧才可见，缓慢闪烁）
        float starZone = smoothstep(0.3, 0.65, h);
        vec3 cell = floor(d * 220.0);
        float star = step(0.9975, hash(cell));
        float tw = 0.5 + 0.5 * sin(uTime * (1.0 + hash(cell + 7.0) * 2.0) + hash(cell) * 40.0);
        col += vec3(0.9, 0.9, 1.0) * star * starZone * tw * 0.55;

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
      // 太阳极缓慢地呼吸，黄昏永远不落幕
      const el = 0.17 + Math.sin(t * 0.02) * 0.015;
      sunDir.set(-0.62, el, -0.42).normalize();
    },
  };
}
