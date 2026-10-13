import * as THREE from "three";
import { lightState } from "./lightstate";

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
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  // 每条线的两个端点各带两个属性：
  //  · aIndex → 每条线一个稳定相位（原来就有，避免 42 条线同亮）
  //  · aHead  → 1 在运动前端、0 在尾端。原来整段一个亮度，画出来是一根发亮的
  //    硬棍子；有了沿长度的渐变，尾端柔化淡出，才读得成"速度线/柔光条"。
  const idx = new Float32Array(COUNT * 2);
  const head = new Float32Array(COUNT * 2);
  for (let i = 0; i < COUNT; i++) {
    idx[i * 2] = i;
    idx[i * 2 + 1] = i;
    head[i * 2] = 1;
    head[i * 2 + 1] = 0;
  }
  geo.setAttribute("aIndex", new THREE.BufferAttribute(idx, 1));
  geo.setAttribute("aHead", new THREE.BufferAttribute(head, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uOpacity: { value: 0 },
      // 暖白观感色；真实亮度 = uColor × uEmissive
      uColor: { value: new THREE.Color("#fff2d8") },
      // 自发光 HDR 增益：ShanderMaterial 的透明度/亮度只能走 uniform
      uEmissive: { value: lightState.fxGain() },
    },
    vertexShader: /* glsl */ `
      varying float vI;
      varying float vHead;
      attribute float aIndex;
      attribute float aHead;
      void main() {
        vI = aIndex;
        vHead = aHead;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform vec3 uColor;
      uniform float uEmissive;
      varying float vI;
      varying float vHead;
      void main() {
        // 每条线一个固定亮度差（0.72~1.0），去掉原来的 0.35~0.65 随机档：
        // 那档随机 × uOpacity 0.5 之后实际贡献只有 0.17~0.32，永远在线性亮度
        // bloom 阈值 0.8 以下 —— 这些"发光速度线"从来没有发过光。
        float perLine = 0.72 + 0.28 * fract(vI * 7.13);
        // 形状与渐隐交给 alpha，亮度折进颜色（加法混合下最终贡献 = color × alpha）。
        float a = uOpacity * perLine * mix(0.15, 1.0, vHead);
        gl_FragColor = vec4(uColor * uEmissive, a);
      }
    `,
  });

  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;

  // 每条风线的状态池：位置 + 剩余寿命 + 流动速度。
  // life 给 0~1.1 的随机初值，让 42 条线在起飞后的第一秒内**错峰**重生；
  // 若全部给 0 会同帧一起刷新，看起来像整片线同时闪一下。
  const pool = Array.from({ length: COUNT }, () => ({
    p: new THREE.Vector3(),
    life: Math.random() * 1.1,
    speed: 0.7 + Math.random() * 0.8,
  }));

  const tmp = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function update(dt: number, _t: number, pos: THREE.Vector3, vel: THREE.Vector3) {
    const speed = vel.length();
    const intensity = THREE.MathUtils.clamp((speed - 4) / 6, 0, 1);
    // 峰值从 intensity*0.5 提到 intensity：系数本来就该分成"出现与否"（intensity）
    // 和"该多亮"（uEmissive），一个 0.5 的暗乘数只会把光再次压回阈值之下。
    mat.uniforms.uOpacity.value = THREE.MathUtils.lerp(mat.uniforms.uOpacity.value, intensity, Math.min(1, dt * 5));
    // 自发光跟着昼夜走：环境越暗，速度线越显眼
    mat.uniforms.uEmissive.value = lightState.fxGain();
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
