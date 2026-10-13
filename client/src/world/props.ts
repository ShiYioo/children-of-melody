import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { terrainHeight, terrainSlope } from "../heightfield";
import { addCollider, clearColliders } from "../colliders";
import type { ToonKit } from "./toon";
import { lightState } from "./lightstate";
import { patchRimMaterial } from "./rim";

/**
 * 岛上的陈设：光遇风的圆冠树、青灰岩石、发光小花、
 * 灯塔山丘的灯塔、篝火广场的石圈与木凳。
 *
 * 配色注：岩石原来用的是薰衣草紫（`#a79fd0` / `#9a94c4`，H≈253°）。
 * 那不是光遇的岩石色 —— 光遇的崖壁是**青灰**（H≈200~210°），
 * 紫岩会让整座岛偏"梦幻糖果"，和苦艾绿的草、暖米的沙三者凑不成一套地貌语言。
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

/**
 * 果实材质做成**模块级单例**。
 * 原来 makeTree 里每次 `new THREE.MeshBasicMaterial(...)` —— 12 棵树就有 12 个
 * 参数完全相同、但对象不同的材质。合批是按材质**对象**归组的，
 * 那样 12 棵树的果实会各归一组，合批也就白做了。
 */
const FRUIT_MAT = new THREE.MeshBasicMaterial({ color: "#ffdf8f" });

function makeTree(kit: ToonKit, x: number, z: number, scale: number): THREE.Group {
  const g = new THREE.Group();
  const h = terrainHeight(x, z);
  g.position.set(x, h - 0.15, z);
  g.scale.setScalar(scale);
  g.rotation.y = Math.random() * Math.PI * 2;

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.24, 2.4, 9), kit.mat("#b98b6f"));
  trunk.position.y = 1.2;
  trunk.rotation.z = (Math.random() - 0.5) * 0.12; // 微微歪一点，更自然
  trunk.castShadow = true;
  g.add(trunk);

  // 根部张开的短锥裙（树不是插在地上的一根管子）
  const flare = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.46, 0.55, 9), kit.mat("#b98b6f"));
  flare.position.y = 0.18;
  flare.castShadow = true;
  g.add(flare);

  // 两根伸进树冠的枝桠（打破「一根棍子顶个球」）
  for (const [bx, bz, tilt] of [
    [0.42, 0.18, -0.75],
    [-0.38, -0.26, 0.7],
  ] as const) {
    const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.1, 1.35, 7), kit.mat("#b98b6f"));
    branch.position.set(bx * 0.9, 2.25, bz * 0.9);
    branch.rotation.y = Math.atan2(bx, bz);
    branch.rotation.z = tilt;
    branch.castShadow = true;
    g.add(branch);
  }

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
  const fruits = new THREE.Mesh(mergeGeometries(fruitGeos)!, FRUIT_MAT);
  g.add(fruits);

  return g;
}

// ---------- 岩石（半埋的圆润大卵石，顶面可以跳上去站） ----------
function makeRock(kit: ToonKit, x: number, z: number, s: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(s, 16, 13);
  const ry = 0.62 + Math.random() * 0.25;
  geo.scale(1.15, ry, 0.9 + Math.random() * 0.3);
  organic(geo, s * 0.11, 1.6, x * 0.21 + z * 0.15); // 卵石的不规则起伏，不再是完美椭球
  const m = new THREE.Mesh(geo, kit.mat(Math.random() < 0.5 ? "#93a2ab" : "#82909a"));
  const h = terrainHeight(x, z);
  m.position.set(x, h + s * 0.1, z); // 稍稍陷入地面
  m.rotation.y = Math.random() * Math.PI * 2;
  m.castShadow = true;
  m.receiveShadow = true;
  const top = h + s * 0.1 + ry * s; // 视觉顶点高度（站立面）
  addCollider({ x, z, r: 1.1 * s, y0: h - 0.2, y1: top, stand: true, standR: 0.85 * s });
  return m;
}

// ---------- 发光小花（instanced；琴声靠近会随音符明灭） ----------
function makeFlowers(): { inst: THREE.InstancedMesh; pos: THREE.Vector3[]; base: Float32Array } {
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
  const pos: THREE.Vector3[] = [];
  const base = new Float32Array(count * 3);
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
    base[placed * 3] = col.r;
    base[placed * 3 + 1] = col.g;
    base[placed * 3 + 2] = col.b;
    pos.push(new THREE.Vector3(x, h, z));
    placed++;
  }
  inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  return { inst, pos, base: base.slice(0, placed * 3) };
}

// ---------- 草地（簇状草丛：每簇数片尖细弯叶，铺成草甸） ----------
//
// 这里的参数是实机标定过的。改造前草地是全画面最丑的一处——满地巨大的白色纸板，
// 四个原因叠加：① 片元完全不透明 vec4(col, 1.0) ② DoubleSide ③ 叶尖只收到 65%（不是尖）
// ④ 缩放 0.75~1.6 → 近 1 米高、近半米宽。
// 而数值上的根因是：叶尖色 hi 的线性亮度 0.71，而地面渲染后约 0.25 ——
// **草比地面亮 2.6 倍**，于是整片草甸在画面上读作"白纸"。
//
// 现在的取向：草是贴着地面的**细节**，不是独立发光体。叶尖亮度压到与地面同档略高，
// 靠密度 + 收尖的叶形读作草绒。
function makeGrass(): THREE.Mesh {
  const CLUSTERS = 1500; // 一簇一簇，不是均匀撒点
  const PER_CLUSTER = () => 6 + Math.floor(Math.random() * 4);
  const BLADE_W = 0.09;
  const BLADE_H = 0.30;

  // 尖细弯叶：叶尖收成 0（真正的尖），根部略窄 → 叶形轮廓
  const blade = new THREE.PlaneGeometry(BLADE_W, BLADE_H, 1, 3);
  blade.translate(0, BLADE_H / 2, 0);
  {
    const pos = blade.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const k = y / BLADE_H;
      // 叶形宽度：根 0.5 → 25% 高度处最宽 0.75 → 叶尖 0
      const taper = (1 - k) * (0.5 + 0.5 * Math.min(1, k * 4));
      pos.setX(i, pos.getX(i) * taper);
      pos.setZ(i, pos.getZ(i) + k * k * 0.11); // 叶尖向外弯，不是笔直的牌
    }
    blade.computeVertexNormals();
  }

  // 簇心：保持最小间距，让草甸一丛一丛
  const centers: [number, number][] = [];
  let guard = 0;
  while (centers.length < CLUSTERS && guard++ < 20000) {
    const a = Math.random() * Math.PI * 2;
    const r = 7.5 + Math.random() * 43;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (h < 1.5 || terrainSlope(x, z) > 0.55) continue;
    let ok = true;
    for (const [cx, cz] of centers) {
      if ((cx - x) * (cx - x) + (cz - z) * (cz - z) < 4.2) { ok = false; break; }
    }
    if (ok) centers.push([x, z]);
  }

  const total = centers.reduce((n) => n + PER_CLUSTER(), 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = blade.index;
  geo.attributes.position = blade.attributes.position;
  geo.attributes.uv = blade.attributes.uv;

  const base = new Float32Array(total * 3);
  const scales = new Float32Array(total);
  const rots = new Float32Array(total);
  const tilts = new Float32Array(total);
  const tints = new Float32Array(total);
  let placed = 0;
  for (const [cx, cz] of centers) {
    const n = PER_CLUSTER();
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * 0.55; // 簇内更紧凑，才读得出"一丛"
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      base[placed * 3] = x;
      // 略微埋进地面：草根不该悬在坡面上
      base[placed * 3 + 1] = terrainHeight(x, z) - 0.02 - Math.random() * 0.03;
      base[placed * 3 + 2] = z;
      scales[placed] = 0.62 + Math.random() * 0.58; // 0.19~0.36m 高
      rots[placed] = Math.random() * Math.PI * 2;
      tilts[placed] = Math.random() * 0.5; // 随机倾角：避免"一丛竖直纸片"
      tints[placed] = Math.random(); // 每片微调色
      placed++;
    }
  }
  geo.instanceCount = placed;
  geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(base, 3));
  geo.setAttribute("aScale", new THREE.InstancedBufferAttribute(scales, 1));
  geo.setAttribute("aRot", new THREE.InstancedBufferAttribute(rots, 1));
  geo.setAttribute("aTilt", new THREE.InstancedBufferAttribute(tilts, 1));
  geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uFogColor: { value: new THREE.Color("#eecfa4") },
      uFogDensity: { value: 0.0046 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uFogDensity;
      attribute vec3 aBase;
      attribute float aScale;
      attribute float aRot;
      attribute float aTilt;
      attribute float aTint;
      varying vec2 vUv;
      varying float vTint;
      varying float vFog;
      void main() {
        vUv = uv;
        vTint = aTint;
        vec3 p = position * aScale;
        // 先绕自身 x 轴随机倾倒，再绕 y 轴随机朝向——两万个实例才有"草丛"的杂乱感
        float ct = cos(aTilt), st = sin(aTilt);
        p = vec3(p.x, ct * p.y - st * p.z, st * p.y + ct * p.z);
        float c = cos(aRot), s = sin(aRot);
        p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
        // 风拂过草甸：按世界位置取相位，整片有波在走
        float sway = sin(uTime * 1.6 + aBase.x * 0.35 + aBase.z * 0.3) * 0.055;
        float bend = pow(uv.y, 1.8);
        p.x += sway * bend;
        p.z += sway * 0.5 * bend;
        vec4 mv = viewMatrix * modelMatrix * vec4(p + aBase, 1.0);
        // 雾密度跟随场景（原来写死 0.0042 → 夜里草地不跟随场景雾而浮出亮斑）
        vFog = 1.0 - exp(-uFogDensity * uFogDensity * dot(mv.xyz, mv.xyz));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vTint;
      varying float vFog;
      uniform vec3 uFogColor;
      void main() {
        // 线性空间的叶片色。叶尖亮度 ~0.26，与地面同档（原来是 0.71，比地面亮 2.6 倍）
        vec3 lo = vec3(0.045, 0.105, 0.042);
        vec3 hi = vec3(0.165, 0.305, 0.115);
        float v = smoothstep(0.0, 0.85, vUv.y) * (0.72 + vTint * 0.5);
        vec3 col = mix(lo, hi, clamp(v, 0.0, 1.0));
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
  // 山丘顶是陡坡，宽基座的下坡侧边缘会悬空——整体埋深 1.1m 让石基"长"进坡里
  g.position.set(x, terrainHeight(x, z) - 1.1, z);

  // ---- 石砌两阶基座（收窄：太宽在陡坡上悬得更明显） ----
  const base1 = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.78, 0.7, 24), kit.mat("#d9c9b8"));
  base1.position.y = 0.3;
  base1.castShadow = true;
  const base2 = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.56, 0.5, 24), kit.mat("#e2d5c4"));
  base2.position.y = 0.85;
  base2.castShadow = true;
  g.add(base1, base2);

  // ---- 塔身（24 段顺滑）+ 拱门朝岛心 + 三扇带窗台的小窗 ----
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.25, 8.2, 24), kit.mat("#f7f0e4"));
  tower.position.y = 4.1;
  tower.castShadow = true;
  g.add(tower);
  const radiusAt = (y: number) => 1.25 - y * (0.4 / 8.2);
  const doorA = Math.atan2(-x, -z); // 朝篝火广场
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.05, 0.14), kit.mat("#6a4a58"));
  door.position.set(Math.sin(doorA) * (radiusAt(1.7) - 0.06), 1.68, Math.cos(doorA) * (radiusAt(1.7) - 0.06));
  door.rotation.y = doorA;
  g.add(door);
  const doorArc = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.05, 6, 12, Math.PI), kit.mat("#d9c9b8"));
  doorArc.position.set(Math.sin(doorA) * radiusAt(2.2), 2.2, Math.cos(doorA) * radiusAt(2.2));
  doorArc.rotation.y = doorA;
  g.add(doorArc);
  for (const [wy, wa] of [[3.8, doorA + 1.9], [6.2, doorA - 1.9], [7.7, doorA + 0.9]] as const) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.5, 0.12), kit.mat("#6a4a58"));
    win.position.set(Math.sin(wa) * (radiusAt(wy) - 0.04), wy, Math.cos(wa) * (radiusAt(wy) - 0.04));
    win.rotation.y = wa;
    g.add(win);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.07, 0.15), kit.mat("#d9c9b8"));
    sill.position.copy(win.position).add(new THREE.Vector3(Math.sin(wa) * 0.04, -0.3, Math.cos(wa) * 0.04));
    sill.rotation.y = wa;
    g.add(sill);
  }

  for (const y of [2.7, 5.2, 7.2]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(radiusAt(y + 0.45) + 0.04, radiusAt(y - 0.45) + 0.04, 0.9, 24), kit.mat("#e8aebf"));
    band.position.y = y;
    g.add(band);
  }

  // ---- 环廊 + 栏杆（细柱一圈 + 扶手环） ----
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.28, 24), kit.mat("#d9c9b8"));
  gallery.position.y = 8.3;
  gallery.castShadow = true;
  g.add(gallery);
  const railMat = kit.mat("#e8aebf");
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 6), railMat);
    post.position.set(Math.cos(a) * 1.26, 8.72, Math.sin(a) * 1.26);
    g.add(post);
  }
  const railRing = new THREE.Mesh(new THREE.TorusGeometry(1.26, 0.04, 6, 24), railMat);
  railRing.rotation.x = Math.PI / 2;
  railRing.position.y = 8.98;
  g.add(railRing);

  // ---- 灯室：玻璃罩 + 竖框 + 灯芯 ----
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52, 0.52, 0.8, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: "#ffdf9f", transparent: true, opacity: 0.3, depthWrite: false })
  );
  glass.position.y = 9.0;
  g.add(glass);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06), railMat);
    mullion.position.set(Math.cos(a) * 0.52, 9.0, Math.sin(a) * 0.52);
    g.add(mullion);
  }
  const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 12), new THREE.MeshBasicMaterial({ color: "#ffd98f" }));
  lantern.position.y = 9.0;
  g.add(lantern);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.1, 24), kit.mat("#e8aebf"));
  roof.position.y = 10.1;
  roof.castShadow = true;
  g.add(roof);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), railMat);
  finial.position.y = 10.72;
  g.add(finial);

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
  // 真扫光的探照灯：光束锥转到哪个方向，哪片地面/海面就被照亮（不再是只有贴图在转）
  const sweep = new THREE.SpotLight("#ffd9a0", 260, 90, 0.32, 0.65, 1.4);
  sweep.position.set(0, 9.2, 0);
  sweep.castShadow = false;
  const sweepTarget = new THREE.Object3D();
  sweepTarget.position.set(30, 2, 0);
  g.add(sweepTarget);
  sweep.target = sweepTarget;
  g.add(sweep);
  // 光柱贴图与探照灯同轴：把贴图挪进 sweepPivot，一起转
  const beamPivot = new THREE.Group();
  beamPivot.position.y = 0;
  beamPivot.add(beam);
  beam.position.set(15, 9.0, 0);
  beam.rotation.set(0, 0, Math.PI / 2);
  beamPivot.add(sweep);
  sweep.position.set(0, 9.2, 0);
  beamPivot.add(sweepTarget);
  g.add(beamPivot);

  return {
    group: g,
    update: (t: number) => {
      beamPivot.rotation.y = t * 0.35;
      lamp.intensity = 26 + Math.sin(t * 2.2) * 4;
      // 灯塔扫过时地面明暗真实流动（SpotLight 照亮沿途地形/海面/角色）
      sweep.intensity = 240 + Math.sin(t * 2.2) * 30;
    },
  };
}

// ---------- 篝火广场 ----------
export interface Campfire {
  group: THREE.Group;
  update: (t: number) => void;
  position: THREE.Vector3;
  setBoost: (v: number) => void;
}

/**
 * 把一组静态实体按材质归组合批成一个 Mesh（每种材质一个）。
 *
 * 篝火是场景里唯一「近景常驻」的道具，石圈 8 块 + 柴堆 5 根原本是 **13 个独立 Mesh
 * = 13 次 draw call**，每帧都在付。合并后只剩 4 个（实测材质数），省 9 次。
 *
 * 三个必须做对的地方：
 *  1. `applyMatrix4(m.matrix)` —— 必须先 `updateMatrix()` 把 position/rotation/scale
 *     烘进矩阵，否则所有石块会塌到原点堆成一坨。
 *  2. 按材质分组 —— mergeGeometries 要求同一批几何体的属性集一致，材质不同也不能合。
 *  3. 合并后**释放**被吃掉的中间几何体，否则这 13 份几何体留在显存里只是不再被画。
 */
function batchByMaterial(g: THREE.Group, meshes: THREE.Mesh[]): void {
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const m of meshes) {
    m.updateMatrix();
    const geo = m.geometry.clone().applyMatrix4(m.matrix);
    const arr = groups.get(m.material as THREE.Material);
    if (arr) arr.push(geo);
    else groups.set(m.material as THREE.Material, [geo]);
  }
  for (const m of meshes) {
    g.remove(m);
    m.geometry.dispose();
  }
  for (const [mat, geos] of groups) {
    const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos)!;
    if (geos.length > 1) for (const gg of geos) gg.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
}

/**
 * 跨多个 Group 合批：把 meshes 里所有网格按材质归并，合并后的网格挂到 target 下。
 *
 * 与 batchByMaterial 的区别：那个只处理「同一个 Group 的直接子节点」，
 * 这里要处理「12 棵树各自的子节点」。所以变换必须换成**世界矩阵**，
 * 再乘上 target 世界矩阵的逆 —— 树的 Group 带 position/scale/rotation，
 * 不换算的话 12 棵树会全部塌到原点、比例也全丢。
 *
 * mergeGeometries 还要求同一批几何体的**属性集完全一致**（都带 uv、或者都带 color），
 * 所以必须按材质分组：树冠那份带顶点色，树干那份不带，混在一起会直接返回 null。
 */
function batchInto(target: THREE.Object3D, meshes: THREE.Mesh[]): void {
  if (meshes.length === 0) return;
  target.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(target.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    rel.multiplyMatrices(inv, m.matrixWorld);
    const geo = m.geometry.clone().applyMatrix4(rel);
    const arr = groups.get(m.material as THREE.Material);
    if (arr) arr.push(geo);
    else groups.set(m.material as THREE.Material, [geo]);
  }
  for (const m of meshes) {
    m.removeFromParent();
    m.geometry.dispose();
  }
  for (const [mat, geos] of groups) {
    const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos)!;
    if (geos.length > 1) for (const gg of geos) gg.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    target.add(mesh);
  }
}

function makeCampfire(kit: ToonKit): Campfire {
  const g = new THREE.Group();
  g.position.set(0, terrainHeight(0, 0) + 0.05, 0);
  // 静态实体先攒起来，最后一起合批（见 batchByMaterial）
  const solids: THREE.Mesh[] = [];

  // 石圈：围着火堆的一圈河石。
  //
  // 原来用 IcosahedronGeometry(0.3, 0) —— **detail 0** 是最扁的 20 面体，
  // 再压到 y×0.7，在 toon 的硬边色阶下只剩几块死平的色块；
  // 颜色 #b8a9c9 是淡薰衣草，跟真实被熏黑的火塘石完全不符。
  // 这两点合起来就是审查里说的「篝火旁的石头是扁平的淡色多面体，观感偏纸片」。
  //
  // 改成和岛上大石（makeRock）同一套做法：细分球 + organic() 起伏 → 圆润的不规则河石；
  // 颜色换成被熏过的灰褐，并用每块独立的缩放 / 滚转打破「一圈同样的东西」。
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.21;
    const rs = 0.235 + Math.random() * 0.13;
    const sgeo = new THREE.SphereGeometry(rs, 10, 8);
    sgeo.scale(1.12, 0.76 + Math.random() * 0.18, 0.92 + Math.random() * 0.2);
    organic(sgeo, rs * 0.17, 2.3, i * 3.7); // 河石的不规则起伏
    const stone = new THREE.Mesh(sgeo, kit.mat(Math.random() < 0.45 ? "#6b5b56" : "#8f8189"));
    stone.position.set(Math.cos(a) * 1.5, 0.05 + Math.random() * 0.05, Math.sin(a) * 1.5);
    stone.rotation.set((Math.random() - 0.5) * 0.6, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6);
    stone.castShadow = true;
    stone.receiveShadow = true;
    solids.push(stone);
  }
  // 柴堆：五根带锥度的柴交错架起（外端细内端粗），高低错落。
  // 加一点 organic() 让柴身不再笔直 —— 7 段的正圆柱在近景里一眼就是「管」。
  // 颜色也按根区分：架在火心上的两根已经烧成焦炭。
  for (let i = 0; i < 5; i++) {
    const len = 1.05 + (i % 2) * 0.22;
    const lgeo = new THREE.CylinderGeometry(0.055, 0.09, len, 8, 3);
    organic(lgeo, 0.013, 6.5, i * 2.9);
    const burnt = i % 2 === 0;
    const log = new THREE.Mesh(lgeo, kit.mat(burnt ? "#4e3a30" : "#8a6248"));
    log.position.y = 0.14 + (i % 2) * 0.07;
    log.rotation.z = Math.PI / 2 - 0.2 - (i % 2) * 0.12;
    log.rotation.y = (i / 5) * Math.PI * 2 + 0.4;
    log.castShadow = true;
    log.receiveShadow = true;
    solids.push(log);
  }
  batchByMaterial(g, solids);
  // 炭火微光（火堆脚下一层暖光，夜里有余温感）
  const ember = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 16),
    new THREE.MeshBasicMaterial({ color: "#ff9a4a", transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  ember.rotation.x = -Math.PI / 2;
  ember.position.y = 0.09;
  g.add(ember);

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

  // 出生点就在篝火 8m 内。场景主光必须稳定；高频抖动经过 Bloom 会让整片广场像频闪灯。
  let fireBoost = 1;
  const fireLight = new THREE.PointLight("#ffb36b", 16, 20, 1.35);
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
    solids.push(bench); // 与石圈 / 柴堆一起合批（否则 5 条凳 = 5 次 draw call）
  }

  return {
    group: g,
    position: g.position.clone(),
    update: (t: number) => {
      flame1.material instanceof THREE.ShaderMaterial && (flame1.material.uniforms.uTime.value = t);
      flame2.material instanceof THREE.ShaderMaterial && (flame2.material.uniforms.uTime.value = t * 1.3);
      flame1.rotation.y = t * 0.8;
      // 火光呼吸（不是蹦迪）：光遇的篝火光非常安静——低频慢呼吸为主，微弱高频火苗感。
      // 高频大幅抖动会让整个广场地面跟着脉动，夜里就是频闪灯
      const flick = 0.93 + 0.05 * Math.sin(t * 2.1) + 0.02 * Math.sin(t * 5.3 + 1.4);
      fireLight.intensity = 16 * fireBoost * flick;
      fireLight.position.set(Math.sin(t * 1.3) * 0.02, 1.0, Math.cos(t * 1.1) * 0.02);
    },
    /** 黄昏音乐会等场景的篝火增亮（1=常态） */
    setBoost: (v: number) => {
      fireBoost = v;
    },
  };
}

// ---------- 总装 ----------
export function createProps(kit: ToonKit): {
  group: THREE.Group;
  updates: ((t: number) => void)[];
  campfire: Campfire;
  /** 花随琴动：让 pos 附近 r 米内的发光小花亮起（随帧衰减） */
  pulseFlowers: (pos: THREE.Vector3, r?: number, strength?: number) => void;
} {
  const group = new THREE.Group();
  const updates: ((t: number) => void)[] = [];
  clearColliders(); // HMR 重跑时避免重复注册

  // 草坡树与林地树（大冠树，株距拉开）
  const treeSpots: [number, number, number][] = [
    [-30, 8, 1.35], [-36, 1, 1.1], [-24, 15, 1.2], [-40, 13, 0.95],
    [-14, -34, 1.4], [-21, -30, 1.15], [-7, -39, 1.05], [-19, -41, 1.3],
    [21, 23, 1.25], [15, 29, 1.35], [31, 17, 1.0], [-2, 35, 1.2],
  ];
  // 12 棵树的网格先攒起来，最后跨树合批（见 batchInto）。
  // 不合批的话是 12 × 6 = **72 个 Mesh**，而它们的材质其实只有三种
  // （树干/根裙/枝桠共用 #b98b6f，树冠共用 #ffffff+顶点色，果实共用 FRUIT_MAT），
  // 合批后只剩 3 个。
  const treeMeshes: THREE.Mesh[] = [];
  for (const [x, z, s] of treeSpots) {
    if (terrainHeight(x, z) < 1.4) continue;
    const tg = makeTree(kit, x, z, s);
    tg.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) treeMeshes.push(m);
    });
    // 树干碰撞（冠不挡人）
    const h = terrainHeight(x, z);
    addCollider({ x, z, r: 0.32 * s, y0: h - 0.2, y1: h + 2.4 * s });
  }
  batchInto(group, treeMeshes);

  // 岩石（圆润卵石，碰撞体在 makeRock 里注册——顶面随随机形状精确可站）
  const rockSpots: [number, number, number][] = [
    [40, 6, 1.8], [44, -6, 1.4], [-44, -20, 2.0], [-20, 42, 1.5], [10, -48, 1.8],
    [34, 30, 1.2], [-12, -18, 0.8], [48, 14, 2.2], [-6, 48, 1.3], [20, -44, 1.5],
  ];
  // 10 块岩石同理：只有两种颜色，合批后从 10 个 Mesh 降到 2 个
  batchInto(group, rockSpots.map(([x, z, s]) => makeRock(kit, x, z, s)));

  // ---- 发光小花：琴声靠近时随音符明灭（花随琴动） ----
  const flowers = makeFlowers();
  group.add(flowers.inst);
  const flowerFlash = new Float32Array(flowers.pos.length);
  const _fc = new THREE.Color();
  let flowerNight = -1; // 上次设置的夜色度（避免每帧写 material）
  updates.push((t) => {
    void t;
    // 昼夜呼吸：夜里花田不再常亮满档（光遇的夜是暗的，光只留给光源）
    if (flowerNight !== lightState.night) {
      flowerNight = lightState.night;
      (flowers.inst.material as THREE.MeshBasicMaterial).color.setScalar(1 - lightState.night * 0.68);
    }
    let any = false;
    for (let i = 0; i < flowerFlash.length; i++) {
      if (flowerFlash[i] <= 0) continue;
      any = true;
      flowerFlash[i] = Math.max(0, flowerFlash[i] - 0.016 * 1.4);
      const f = flowerFlash[i];
      _fc.setRGB(
        flowers.base[i * 3] + (1 - flowers.base[i * 3]) * f,
        flowers.base[i * 3 + 1] + (1 - flowers.base[i * 3 + 1]) * f,
        flowers.base[i * 3 + 2] + (1 - flowers.base[i * 3 + 2]) * f
      );
      flowers.inst.setColorAt(i, _fc);
    }
    if (any) flowers.inst.instanceColor!.needsUpdate = true;
  });

  const grass = makeGrass();
  group.add(grass);
  updates.push((t) => {
    const u = (grass.material as THREE.ShaderMaterial).uniforms;
    u.uTime.value = t;
    // 雾跟随场景：草地自己写 GLSL 雾，必须每帧同步，否则夜里会浮出发亮的奶色斑块
    (u.uFogColor.value as THREE.Color).copy(lightState.fogColor);
    u.uFogDensity.value = lightState.fogDensity;
  });

  const lh = makeLighthouse(kit);
  group.add(lh.group);
  updates.push(lh.update);
  {
    // 灯塔塔身（含顶层环廊）——环廊顶面可以滑翔上去站着看海。
    // 模型整体埋深 1.1（防陡坡悬空），环廊站立面同步下移
    const h = terrainHeight(26, -28);
    addCollider({ x: 26, z: -28, r: 1.45, y0: h - 1.4, y1: h - 1.1 + 8.5, stand: true, standR: 1.25 });
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

  // ---- 给所有道具铺上统一的轮廓光 ----
  // 只对 `MeshToonMaterial` / `MeshStandardMaterial` 生效：草是自定义 ShaderMaterial、
  // 发光小花与灯塔灯芯是 MeshBasicMaterial，patchRimMaterial 会自动跳过它们 ——
  // 这是对的，草叶和小花本身就是发光体，再勾一圈边只会变脏。
  //
  // 不必担心 program 数量暴涨：three 的 program cache key 用的是
  // `material.customProgramCacheKey()`，其默认实现返回 `onBeforeCompile.toString()`，
  // 而这里所有道具用的是**同一个** onBeforeCompile 函数 —— 因此它们共享同一批 program。
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) patchRimMaterial(mm);
  });

  const pulseFlowers = (pos: THREE.Vector3, r = 7, strength = 1) => {
    const r2 = r * r;
    for (let i = 0; i < flowers.pos.length; i++) {
      const d2 = flowers.pos[i].distanceToSquared(pos);
      if (d2 < r2) {
        const k = 1 - Math.sqrt(d2) / r;
        flowerFlash[i] = Math.min(1, flowerFlash[i] + strength * k * 0.9);
      }
    }
  };

  return { group, updates, campfire, pulseFlowers };
}

