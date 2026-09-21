import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { terrainHeight, terrainSlope } from "../heightfield";
import { addCollider, clearColliders } from "../colliders";
import type { ToonKit } from "./toon";

/**
 * 岛上的陈设：光遇风的圆冠树、薰衣草色岩石、发光小花、
 * 灯塔山丘的灯塔、篝火广场的石圈与木凳。
 */

/** 几何有机化：沿径向做低频噪声鼓包——破掉完美球体的"程序图元"感，像手捏的 */
function organic(geo: THREE.BufferGeometry, amount: number, freq: number, seed: number): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n =
      Math.sin(v.x * freq + seed) * Math.cos(v.y * freq * 1.31 + seed * 1.7) +
      0.6 * Math.sin(v.z * freq * 1.73 - seed * 2.1) * Math.cos(v.x * freq * 0.79 + seed);
    const len = v.length() || 1;
    v.addScaledVector(v.clone().divideScalar(len), n * amount);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------- 树（光遇式：高干微倾 + 大而扁的圆冠，像画出来的） ----------
function makeTree(kit: ToonKit, x: number, z: number, scale: number): THREE.Group {
  const g = new THREE.Group();
  const h = terrainHeight(x, z);
  g.position.set(x, h - 0.15, z);
  g.scale.setScalar(scale);
  g.rotation.y = Math.random() * Math.PI * 2;

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.24, 2.4, 7), kit.mat("#b98b6f"));
  trunk.position.y = 1.2;
  trunk.rotation.z = (Math.random() - 0.5) * 0.12; // 微微歪一点，更自然
  trunk.castShadow = true;
  g.add(trunk);

  // 大圆冠：三颗压扁的球叠成云朵状冠，双色分层次
  const canopyGeos: THREE.BufferGeometry[] = [];
  const puffs: [number, number, number, number, number][] = [
    // x, y, z, 半径, 压扁比
    [0, 3.3, 0, 1.5, 0.88],
    [0.85, 2.8, 0.3, 1.05, 0.85],
    [-0.75, 2.9, -0.35, 1.1, 0.9],
    [0.1, 2.5, 0.7, 0.8, 0.85],
  ];
  const cTop = new THREE.Color("#bfe3ab");
  const cSide = new THREE.Color("#8cc487");
  puffs.forEach((p, pi) => {
    const s = new THREE.SphereGeometry(p[3], 16, 13);
    s.scale(1, p[4], 1);
    organic(s, p[3] * 0.13, 1.9, pi * 3.7 + x * 0.13 + z * 0.17); // 手捏的不规则鼓包
    s.translate(p[0], p[1], p[2]);
    // 顶亮下暗的顶点色（画出来的立体感）
    const col = new Float32Array(s.attributes.position.count * 3);
    for (let i = 0; i < s.attributes.position.count; i++) {
      const t = Math.min(1, Math.max(0, (s.attributes.position.getY(i) - (p[1] - p[3])) / (p[3] * 1.6)));
      const c = cSide.clone().lerp(cTop, t);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    s.setAttribute("color", new THREE.BufferAttribute(col, 3));
    canopyGeos.push(s);
  });
  const canopy = new THREE.Mesh(mergeGeometries(canopyGeos)!, kit.mat("#ffffff", true));
  canopy.castShadow = true;
  g.add(canopy);

  // 两粒暖光果（bloom 里像小灯）
  const fruitGeos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 2; i++) {
    const f = new THREE.SphereGeometry(0.09, 6, 5);
    const a = Math.random() * Math.PI * 2;
    f.translate(Math.cos(a) * (0.6 + Math.random() * 0.6), 2.7 + Math.random() * 0.7, Math.sin(a) * (0.6 + Math.random() * 0.6));
    fruitGeos.push(f);
  }
  const fruits = new THREE.Mesh(mergeGeometries(fruitGeos)!, new THREE.MeshBasicMaterial({ color: "#ffdf8f" }));
  g.add(fruits);

  return g;
}

// ---------- 岩石（半埋的圆润大卵石，顶面可以跳上去站） ----------
function makeRock(kit: ToonKit, x: number, z: number, s: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(s, 16, 13);
  const ry = 0.62 + Math.random() * 0.25;
  geo.scale(1.15, ry, 0.9 + Math.random() * 0.3);
  organic(geo, s * 0.11, 1.6, x * 0.21 + z * 0.15); // 卵石的不规则起伏，不再是完美椭球
  const m = new THREE.Mesh(geo, kit.mat(Math.random() < 0.5 ? "#a79fd0" : "#9a94c4"));
  const h = terrainHeight(x, z);
  m.position.set(x, h + s * 0.1, z); // 稍稍陷入地面
  m.rotation.y = Math.random() * Math.PI * 2;
  m.castShadow = true;
  m.receiveShadow = true;
  const top = h + s * 0.1 + ry * s; // 视觉顶点高度（站立面）
  addCollider({ x, z, r: 1.1 * s, y0: h - 0.2, y1: top, stand: true, standR: 0.85 * s });
  return m;
}

// ---------- 发光小花（instanced） ----------
function makeFlowers(): THREE.InstancedMesh {
  const count = 170;
  const geo = new THREE.SphereGeometry(0.05, 6, 5);
  geo.translate(0, 0.18, 0);
  const mats = [
    new THREE.MeshBasicMaterial({ color: "#ffd7e8" }),
    new THREE.MeshBasicMaterial({ color: "#fff0b8" }),
    new THREE.MeshBasicMaterial({ color: "#c9e6ff" }),
  ];
  const inst = new THREE.InstancedMesh(geo, mats[0], count);
  inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < 4000) {
    const a = Math.random() * Math.PI * 2;
    const r = 8 + Math.random() * 42;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < 1.6 || terrainSlope(x, z) > 0.5) continue;
    m.makeTranslation(x, h, z);
    inst.setMatrixAt(placed, m);
    col.set(mats[placed % 3].color);
    inst.setColorAt(placed, col);
    placed++;
  }
  inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

// ---------- 草地（簇状草丛：每簇十几片宽弯叶片，像被风吹过的草甸） ----------
function makeGrass(): THREE.Mesh {
  const CLUSTERS = 420;
  const PER_CLUSTER = () => 10 + Math.floor(Math.random() * 6);

  // 宽弯叶片：顶点沿高度向后弯
  const blade = new THREE.PlaneGeometry(0.3, 0.62, 1, 4);
  blade.translate(0, 0.31, 0);
  {
    const pos = blade.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const k = y / 0.62;
      pos.setZ(i, pos.getZ(i) + k * k * 0.2);
      pos.setX(i, pos.getX(i) * (1 - k * 0.35)); // 叶尖收窄
    }
  }

  // 簇心：保持最小间距，让草甸一丛一丛
  const centers: [number, number][] = [];
  let guard = 0;
  while (centers.length < CLUSTERS && guard++ < 8000) {
    const a = Math.random() * Math.PI * 2;
    const r = 7.5 + Math.random() * 43;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < 1.5 || terrainSlope(x, z) > 0.55) continue;
    let ok = true;
    for (const [cx, cz] of centers) {
      if ((cx - x) * (cx - x) + (cz - z) * (cz - z) < 7) { ok = false; break; }
    }
    if (ok) centers.push([x, z]);
  }

  const total = centers.reduce((n, c) => n + PER_CLUSTER(), 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = blade.index;
  geo.attributes.position = blade.attributes.position;
  geo.attributes.uv = blade.attributes.uv;

  const base = new Float32Array(total * 3);
  const scales = new Float32Array(total);
  const rots = new Float32Array(total);
  const tints = new Float32Array(total);
  let placed = 0;
  for (const [cx, cz] of centers) {
    const n = PER_CLUSTER();
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * 0.75;
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      base[placed * 3] = x;
      base[placed * 3 + 1] = terrainHeight(x, z) - 0.04;
      base[placed * 3 + 2] = z;
      scales[placed] = 0.75 + Math.random() * 0.85;
      rots[placed] = Math.random() * Math.PI;
      tints[placed] = Math.random(); // 每片微调色
      placed++;
    }
  }
  geo.instanceCount = placed;
  geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(base, 3));
  geo.setAttribute("aScale", new THREE.InstancedBufferAttribute(scales, 1));
  geo.setAttribute("aRot", new THREE.InstancedBufferAttribute(rots, 1));
  geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uFogColor: { value: new THREE.Color("#eecfa4") },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aBase;
      attribute float aScale;
      attribute float aRot;
      attribute float aTint;
      varying vec2 vUv;
      varying float vTint;
      varying float vFog;
      void main() {
        vUv = uv;
        vTint = aTint;
        vec3 p = position * aScale;
        float c = cos(aRot), s = sin(aRot);
        p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
        // 整丛同一方向摆动（簇心相位），风拂过草甸
        float sway = sin(uTime * 1.6 + aBase.x * 0.35 + aBase.z * 0.3) * 0.16;
        p.x += sway * pow(uv.y, 1.8);
        p.z += sway * 0.5 * pow(uv.y, 1.8);
        vec4 mv = viewMatrix * modelMatrix * vec4(p + aBase, 1.0);
        vFog = 1.0 - exp(-0.0042 * 0.0042 * dot(mv.xyz, mv.xyz));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vTint;
      varying float vFog;
      uniform vec3 uFogColor;
      void main() {
        vec3 lo = vec3(0.19, 0.37, 0.22);
        vec3 hi = vec3(0.58, 0.78, 0.42);
        vec3 col = mix(lo, hi, vUv.y * (0.75 + vTint * 0.45));
        col = mix(col, uFogColor, clamp(vFog, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------- 灯塔 ----------
function makeLighthouse(kit: ToonKit): { group: THREE.Group; update: (t: number) => void } {
  const g = new THREE.Group();
  const x = 26, z = -28;
  g.position.set(x, terrainHeight(x, z) - 0.3, z);

  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.25, 8.2, 12), kit.mat("#f7f0e4"));
  tower.position.y = 4.1;
  tower.castShadow = true;
  g.add(tower);

  for (const y of [2.2, 5.2]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.02 - (8.2 - y) * 0.026, 1.06 - (8.2 - y) * 0.026, 0.9, 12), kit.mat("#e8aebf"));
    band.position.y = y;
    g.add(band);
  }

  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.28, 12), kit.mat("#d9c9b8"));
  gallery.position.y = 8.3;
  gallery.castShadow = true;
  g.add(gallery);

  const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), new THREE.MeshBasicMaterial({ color: "#ffd98f" }));
  lantern.position.y = 9.0;
  g.add(lantern);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.1, 12), kit.mat("#e8aebf"));
  roof.position.y = 10.1;
  roof.castShadow = true;
  g.add(roof);

  const lamp = new THREE.PointLight("#ffcf8f", 30, 40, 1.6);
  lamp.position.y = 9.0;
  g.add(lamp);

  // 缓缓旋转的光束
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(3.0, 30, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: "#ffe9b8", transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, fog: false })
  );
  beam.rotation.z = Math.PI / 2;
  beam.position.y = 9.0;
  const beamPivot = new THREE.Group();
  beamPivot.position.y = 0;
  beamPivot.add(beam);
  beam.position.set(15, 9.0, 0);
  beam.rotation.set(0, 0, Math.PI / 2);
  g.add(beamPivot);

  return {
    group: g,
    update: (t: number) => {
      beamPivot.rotation.y = t * 0.35;
      lamp.intensity = 26 + Math.sin(t * 2.2) * 4;
    },
  };
}

// ---------- 篝火广场 ----------
export interface Campfire {
  group: THREE.Group;
  update: (t: number) => void;
  position: THREE.Vector3;
}

function makeCampfire(kit: ToonKit): Campfire {
  const g = new THREE.Group();
  g.position.set(0, terrainHeight(0, 0) + 0.05, 0);

  // 石圈
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), kit.mat("#b8a9c9"));
    stone.position.set(Math.cos(a) * 1.5, 0.08, Math.sin(a) * 1.5);
    stone.scale.set(1, 0.7, 1);
    stone.rotation.y = Math.random() * Math.PI;
    stone.castShadow = true;
    g.add(stone);
  }
  // 柴堆
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.2, 6), kit.mat("#8a6248"));
    log.position.y = 0.2;
    log.rotation.z = Math.PI / 2 - 0.25;
    log.rotation.y = (i / 3) * Math.PI * 2;
    log.castShadow = true;
    g.add(log);
  }

  // 火焰（双层扰动圆锥，additive）
  const flameMat = (colorA: string, colorB: string, scale: number) =>
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color(colorA) },
        uColorB: { value: new THREE.Color(colorB) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying float vY;
        void main() {
          vY = uv.y;
          vec3 p = position;
          float k = pow(uv.y, 1.6);
          p.x += sin(uTime * 6.0 + uv.y * 9.0) * 0.12 * k;
          p.z += cos(uTime * 5.0 + uv.y * 7.0) * 0.12 * k;
          p.xz *= 1.0 - 0.25 * sin(uTime * 7.0 + uv.y * 12.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        varying float vY;
        void main() {
          vec3 col = mix(uColorB, uColorA, pow(vY, 0.7));
          float a = (1.0 - pow(vY, 1.4)) * 0.85;
          gl_FragColor = vec4(col, a);
        }
      `,
    });
  const flame1 = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.15, 10, 8, true), flameMat("#ff5f4d", "#ffb45e", 1));
  flame1.position.y = 0.62;
  const flame2 = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.7, 8, 6, true), flameMat("#ffe08a", "#fff5d0", 0.7));
  flame2.position.y = 0.42;
  g.add(flame1, flame2);

  const fireLight = new THREE.PointLight("#ffb36b", 46, 30, 1.15); // 更透、更远的暖光，靠近篝火的人会被点亮
  fireLight.position.y = 1.0;
  g.add(fireLight);

  // 围坐的木凳
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    const bench = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.26, 0.55), kit.mat("#caa87e"));
    bench.position.set(Math.cos(a) * 3.6, 0.22, Math.sin(a) * 3.6);
    bench.rotation.y = -a + Math.PI / 2;
    bench.castShadow = true;
    bench.receiveShadow = true;
    g.add(bench);
  }

  return {
    group: g,
    position: g.position.clone(),
    update: (t: number) => {
      flame1.material instanceof THREE.ShaderMaterial && (flame1.material.uniforms.uTime.value = t);
      flame2.material instanceof THREE.ShaderMaterial && (flame2.material.uniforms.uTime.value = t * 1.3);
      flame1.rotation.y = t * 0.8;
      fireLight.intensity = 44 + Math.sin(t * 9.0) * 6 + Math.sin(t * 23.0) * 3;
    },
  };
}

// ---------- 总装 ----------
export function createProps(kit: ToonKit): { group: THREE.Group; updates: ((t: number) => void)[]; campfire: Campfire } {
  const group = new THREE.Group();
  const updates: ((t: number) => void)[] = [];
  clearColliders(); // HMR 重跑时避免重复注册

  // 草坡树与林地树（大冠树，株距拉开）
  const treeSpots: [number, number, number][] = [
    [-30, 8, 1.35], [-36, 1, 1.1], [-24, 15, 1.2], [-40, 13, 0.95],
    [-14, -34, 1.4], [-21, -30, 1.15], [-7, -39, 1.05], [-19, -41, 1.3],
    [21, 23, 1.25], [15, 29, 1.35], [31, 17, 1.0], [-2, 35, 1.2],
  ];
  for (const [x, z, s] of treeSpots) {
    if (terrainHeight(x, z) < 1.4) continue;
    group.add(makeTree(kit, x, z, s));
    // 树干碰撞（冠不挡人）
    const h = terrainHeight(x, z);
    addCollider({ x, z, r: 0.32 * s, y0: h - 0.2, y1: h + 2.4 * s });
  }

  // 岩石（圆润卵石，碰撞体在 makeRock 里注册——顶面随随机形状精确可站）
  const rockSpots: [number, number, number][] = [
    [40, 6, 1.8], [44, -6, 1.4], [-44, -20, 2.0], [-20, 42, 1.5], [10, -48, 1.8],
    [34, 30, 1.2], [-12, -18, 0.8], [48, 14, 2.2], [-6, 48, 1.3], [20, -44, 1.5],
  ];
  for (const [x, z, s] of rockSpots) group.add(makeRock(kit, x, z, s));

  group.add(makeFlowers());

  const grass = makeGrass();
  group.add(grass);
  updates.push((t) => (grass.material as THREE.ShaderMaterial).uniforms.uTime.value = t);

  const lh = makeLighthouse(kit);
  group.add(lh.group);
  updates.push(lh.update);
  {
    // 灯塔塔身（含顶层环廊）——环廊顶面可以滑翔上去站着看海
    const h = terrainHeight(26, -28);
    addCollider({ x: 26, z: -28, r: 1.45, y0: h - 0.6, y1: h - 0.3 + 8.44, stand: true, standR: 1.25 });
  }

  const campfire = makeCampfire(kit);
  group.add(campfire.group);
  updates.push(campfire.update);
  {
    // 火堆本体不能踩进去（围坐区不受影响）
    addCollider({ x: 0, z: 0, r: 0.9, y0: campfire.position.y - 0.6, y1: campfire.position.y + 1.1 });
    // 木凳：长凳用两段圆柱近似，凳面可以小跳上去坐
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const dirX = Math.sin(a);
      const dirZ = -Math.cos(a);
      for (const k of [-0.55, 0.55]) {
        addCollider({
          x: Math.cos(a) * 3.6 + dirX * k,
          z: Math.sin(a) * 3.6 + dirZ * k,
          r: 0.3,
          y0: campfire.position.y - 0.5,
          y1: campfire.position.y + 0.35,
          stand: true,
          standR: 0.26,
        });
      }
    }
  }

  return { group, updates, campfire };
}
