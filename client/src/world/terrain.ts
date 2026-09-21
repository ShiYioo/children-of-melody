import * as THREE from "three";
import { terrainHeight } from "../heightfield";
import { painterlyGradient, brushTexture } from "./toon";

/**
 * 岛屿地形网格：顶点着色出绘画感的柔和色带——
 * 蜜色沙滩 → 鼠尾草绿坡 → 薰衣草岩，广场铺暖石色。
 * 混色用低频噪声（大笔触），避免像素点彩的碎感。
 */
const C_SAND = new THREE.Color("#f6e0b8");
const C_GRASS_LO = new THREE.Color("#a4cf8e");
const C_GRASS_HI = new THREE.Color("#63a473");
const C_ROCK = new THREE.Color("#aca3cd");
const C_PLAZA = new THREE.Color("#e6d3ab");
const C_SUN = new THREE.Color("#ffd9a8");

export function createTerrain(): THREE.Mesh {
  const SIZE = 150;
  // 更粗的网格：色块更大、坡面更圆，绘画感更强
  const SEG = 96;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const sunDir = new THREE.Vector3(-0.62, 0.3, -0.42).normalize();
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);

    const r = Math.hypot(x, z);
    // 低频大笔触混色（两层慢波叠出草甸的明暗斑块）
    const n1 = 0.5 + 0.28 * Math.sin(x * 0.09 + 1.1) * Math.cos(z * 0.08 - 0.6) + 0.22 * Math.sin((x + z) * 0.055 + 2.0);
    const slope = slopeAt(x, z);

    if (h < 1.35) {
      c.copy(C_SAND); // 海滩
    } else if (slope > 0.62 || h > 11.5) {
      c.copy(C_ROCK).lerp(C_GRASS_HI, 0.2 * Math.max(0, n1)); // 岩石带
    } else {
      c.copy(C_GRASS_LO).lerp(C_GRASS_HI, THREE.MathUtils.clamp(n1, 0, 1) * 0.9); // 草坡
    }

    // 广场石色（中心压平区）
    const plaza = Math.exp(-(r * r) / 46);
    if (h >= 1.0) c.lerp(C_PLAZA, plaza * 0.85);

    // 沙滩与草地的宽过渡
    if (h >= 1.35 && h < 2.3) c.lerp(C_SAND, 1 - (h - 1.35) / 0.95);

    // 向阳坡染一点夕阳
    const nx = terrainHeight(x + 0.8, z) - terrainHeight(x - 0.8, z);
    const nz = terrainHeight(x, z + 0.8) - terrainHeight(x, z - 0.8);
    const nrm = new THREE.Vector3(-nx, 1.6, -nz).normalize();
    const sun = Math.max(0, nrm.dot(sunDir));
    c.lerp(C_SUN, sun * 0.16);

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // 油画渐变 + 手绘笔触（与全岛 toon 材质同一套画风）
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: painterlyGradient(), map: brushTexture() });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "terrain";
  return mesh;
}

function slopeAt(x: number, z: number): number {
  const e = 0.6;
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return Math.min(1, Math.hypot(hx, hz) / (2 * e));
}
