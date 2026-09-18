import * as THREE from "three";

/**
 * 滑翔风线：光遇飞行时贴脸掠过的速度线。
 * 一池细长的发光线段，沿飞行反方向流动并拉伸，
 * 只在空中且速度足够时浮现。
 */
export function createWindLines(): {
  lines: THREE.LineSegments;
  update: (dt: number, t: number, pos: THREE.Vector3, vel: THREE.Vector3) => void;
} {
  const COUNT = 42;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(COUNT * 2 * 3); // 每条线两个端点
  const alphas = new Float32Array(COUNT);
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vI;
      attribute float aIndex;
      void main() {
        vI = aIndex;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vI;
      void main() {
        gl_FragColor = vec4(1.0, 0.95, 0.85, uOpacity * (0.35 + 0.3 * fract(vI * 7.13)));
      }
    `,
  });
  // 顶点索引（每条线需要 aIndex 才能着色差异）
  const idx = new Float32Array(COUNT * 2);
  for (let i = 0; i < COUNT; i++) {
    idx[i * 2] = i;
    idx[i * 2 + 1] = i;
  }
  geo.setAttribute("aIndex", new THREE.BufferAttribute(idx, 1));

  interface Line {
    p: THREE.Vector3;
    life: number;
    speed: number;
  }
  const pool: Line[] = [];
  for (let i = 0; i < COUNT; i++) {
    pool.push({ p: new THREE.Vector3(), life: Math.random(), speed: 1 });
  }

  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;

  const tmp = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function update(dt: number, _t: number, pos: THREE.Vector3, vel: THREE.Vector3) {
    const speed = vel.length();
    const intensity = THREE.MathUtils.clamp((speed - 4) / 6, 0, 1);
    mat.uniforms.uOpacity.value = THREE.MathUtils.lerp(mat.uniforms.uOpacity.value, intensity * 0.5, Math.min(1, dt * 5));
    if (intensity <= 0.01) return;

    dir.copy(vel).normalize();
    const arr = geo.attributes.position.array as Float32Array;

    for (let i = 0; i < COUNT; i++) {
      const L = pool[i];
      L.life -= dt * (0.8 + L.speed * 0.4);
      if (L.life <= 0) {
        // 在角色前方随机重生一条风线
        L.life = 0.6 + Math.random() * 0.5;
        L.speed = 0.7 + Math.random() * 0.8;
        const a = Math.random() * Math.PI * 2;
        const r = 2.2 + Math.random() * 4.5;
        L.p
          .set(pos.x + dir.x * 8 + Math.cos(a) * r, pos.y + 1.2 + Math.sin(a) * r * 0.55, pos.z + dir.z * 8 + Math.sin(a) * r)
          .addScaledVector(dir, -Math.random() * 6);
      }
      // 沿反方向流动；线长随速度拉伸
      const stretch = 0.5 + speed * 0.22;
      tmp.copy(L.p);
      arr[i * 6] = tmp.x;
      arr[i * 6 + 1] = tmp.y;
      arr[i * 6 + 2] = tmp.z;
      arr[i * 6 + 3] = tmp.x - dir.x * stretch;
      arr[i * 6 + 4] = tmp.y - dir.y * stretch;
      arr[i * 6 + 5] = tmp.z - dir.z * stretch;
      L.p.addScaledVector(dir, -speed * dt * 1.15);
    }
    geo.attributes.position.needsUpdate = true;
  }

  return { lines, update };
}
