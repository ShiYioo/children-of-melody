import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { terrainHeight, terrainSlope } from "../heightfield";
import type { ToonKit } from "./toon";

/**
 * 岛上的陈设：光遇风的圆冠树、薰衣草色岩石、发光小花、
 * 灯塔山丘的灯塔、篝火广场的石圈与木凳。
 */

// ---------- 树 ----------
function makeTree(kit: ToonKit, x: number, z: number, scale: number): THREE.Group {
  const g = new THREE.Group();
  const h = terrainHeight(x, z);
  g.position.set(x, h - 0.15, z);
  g.scale.setScalar(scale);
  g.rotation.y = Math.random() * Math.PI * 2;

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.26, 1.9, 7), kit.mat("#b98b6f"));
  trunk.position.y = 0.95;
  trunk.castShadow = true;
  g.add(trunk);

  // 三颗圆冠合成一个几何体，一株树只有 2 个 draw call
  const greens = ["#8fd6a0", "#6ec08a", "#a5e6b5"];
  const canopyGeos: THREE.BufferGeometry[] = [];
  const puffs: [number, number, number, number][] = [
    [0, 2.6, 0, 1.15],
    [0.55, 2.2, 0.25, 0.8],
    [-0.45, 2.3, -0.2, 0.85],
  ];
  puffs.forEach((p, i) => {
    const s = new THREE.SphereGeometry(p[3], 12, 10);
    s.translate(p[0], p[1], p[2]);
    s.setAttribute("color", new THREE.BufferAttribute(new Float32Array(s.attributes.position.count * 3).fill(1), 3));
    const c = new THREE.Color(greens[i % greens.length]);
    // 用顶点色区分每颗圆冠
    const col = new Float32Array(s.attributes.position.count * 3);
    for (let k = 0; k < col.length; k += 3) {
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
    }
    s.setAttribute("color", new THREE.BufferAttribute(col, 3));
    canopyGeos.push(s);
  });
  const canopy = new THREE.Mesh(mergeGeometries(canopyGeos)!, kit.mat("#ffffff", true));
  canopy.castShadow = true;
  g.add(canopy);

  // 暖光果实（bloom 里会微微发光）
  const fruitGeos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const f = new THREE.SphereGeometry(0.07, 6, 5);
    const a = Math.random() * Math.PI * 2;
    f.translate(Math.cos(a) * (0.5 + Math.random() * 0.5), 2.2 + Math.random() * 0.8, Math.sin(a) * (0.5 + Math.random() * 0.5));
    fruitGeos.push(f);
  }
  const fruits = new THREE.Mesh(mergeGeometries(fruitGeos)!, new THREE.MeshBasicMaterial({ color: "#ffdf8f" }));
  g.add(fruits);

  return g;
}

// ---------- 岩石 ----------
function makeRock(kit: ToonKit, x: number, z: number, s: number): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(s, 0);
  geo.scale(1, 0.6 + Math.random() * 0.3, 0.8 + Math.random() * 0.4);
  const m = new THREE.Mesh(geo, kit.mat("#a79ecb"));
  m.position.set(x, terrainHeight(x, z) + s * 0.15, z);
  m.rotation.y = Math.random() * Math.PI * 2;
  m.castShadow = true;
  m.receiveShadow = true;
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

// ---------- 草地（instanced 摇摆小草，X 型交叉叶片铺成草毯） ----------
function makeGrass(): THREE.Mesh {
  const count = 5200;
  const p1 = new THREE.PlaneGeometry(0.17, 0.75, 1, 3);
  p1.translate(0, 0.375, 0);
  const p2 = p1.clone().rotateY(Math.PI / 2);
  const blade = mergeGeometries([p1, p2])!;
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = blade.index;
  geo.attributes.position = blade.attributes.position;
  geo.attributes.uv = blade.attributes.uv;

  const base = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const rots = new Float32Array(count);
  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < 80000) {
    const a = Math.random() * Math.PI * 2;
    const r = 7.5 + Math.random() * 43;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < 1.5 || terrainSlope(x, z) > 0.55) continue;
    base[placed * 3] = x;
    base[placed * 3 + 1] = h - 0.05;
    base[placed * 3 + 2] = z;
    scales[placed] = 0.7 + Math.random() * 0.9;
    rots[placed] = Math.random() * Math.PI;
    placed++;
  }
  geo.instanceCount = placed;
  geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(base, 3));
  geo.setAttribute("aScale", new THREE.InstancedBufferAttribute(scales, 1));
  geo.setAttribute("aRot", new THREE.InstancedBufferAttribute(rots, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100); // 手动包围球，避免逐实例剔除

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uFogColor: { value: new THREE.Color("#eecfa4") },
      uFogDensity: { value: 0.0042 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aBase;
      attribute float aScale;
      attribute float aRot;
      varying vec2 vUv;
      varying float vFog;
      void main() {
        vUv = uv;
        vec3 p = position * aScale;
        float c = cos(aRot), s = sin(aRot);
        p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
        float sway = sin(uTime * 1.8 + aBase.x * 0.8 + aBase.z * 0.6) * 0.13;
        p.x += sway * pow(uv.y, 2.0);
        p.z += sway * 0.6 * pow(uv.y, 2.0);
        vec4 mv = viewMatrix * modelMatrix * vec4(p + aBase, 1.0);
        vFog = 1.0 - exp(-0.0042 * 0.0042 * dot(mv.xyz, mv.xyz));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFog;
      uniform vec3 uFogColor;
      void main() {
        vec3 lo = vec3(0.20, 0.40, 0.26);
        vec3 hi = vec3(0.50, 0.74, 0.42);
        vec3 col = mix(lo, hi, vUv.y);
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

  const fireLight = new THREE.PointLight("#ffb36b", 24, 22, 1.7);
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
      fireLight.intensity = 22 + Math.sin(t * 9.0) * 3 + Math.sin(t * 23.0) * 1.5;
    },
  };
}

// ---------- 总装 ----------
export function createProps(kit: ToonKit): { group: THREE.Group; updates: ((t: number) => void)[]; campfire: Campfire } {
  const group = new THREE.Group();
  const updates: ((t: number) => void)[] = [];

  // 草坡树与林地树
  const treeSpots: [number, number, number][] = [
    [-30, 8, 1.1], [-34, 2, 0.9], [-26, 14, 1.0], [-38, 12, 0.8],
    [-14, -34, 1.2], [-20, -30, 1.0], [-8, -38, 0.9], [-18, -40, 1.1],
    [22, 22, 1.0], [16, 28, 1.1], [30, 16, 0.85], [-2, 34, 1.0], [8, 30, 0.9],
    [36, -16, 0.95], [12, -44, 0.9], [-40, -12, 1.05],
  ];
  for (const [x, z, s] of treeSpots) {
    if (terrainHeight(x, z) < 1.4) continue;
    group.add(makeTree(kit, x, z, s));
  }

  // 岩石
  const rockSpots: [number, number, number][] = [
    [40, 6, 1.4], [44, -6, 1.1], [-44, -20, 1.6], [-20, 42, 1.2], [10, -48, 1.5],
    [34, 30, 1.0], [-12, -18, 0.7], [48, 14, 1.8], [-6, 48, 1.0], [20, -44, 1.2],
  ];
  for (const [x, z, s] of rockSpots) group.add(makeRock(kit, x, z, s));

  group.add(makeFlowers());

  const grass = makeGrass();
  group.add(grass);
  updates.push((t) => (grass.material as THREE.ShaderMaterial).uniforms.uTime.value = t);

  const lh = makeLighthouse(kit);
  group.add(lh.group);
  updates.push(lh.update);

  const campfire = makeCampfire(kit);
  group.add(campfire.group);
  updates.push(campfire.update);

  return { group, updates, campfire };
}
