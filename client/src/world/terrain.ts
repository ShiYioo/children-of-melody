import * as THREE from "three";
import { terrainHeight } from "../heightfield";

/**
 * 岛屿地形网格：顶点着色出光遇式的柔和色带——
 * 蜜色沙滩 → 鼠尾草绿坡 → 薰衣草岩，广场铺暖石色，
 * 向阳面额外叠一层夕阳的暖光。
 */
const C_SAND = new THREE.Color("#f4dfae");
const C_GRASS_LO = new THREE.Color("#a8dba4");
const C_GRASS_HI = new THREE.Color("#4f9e78");
const C_ROCK = new THREE.Color("#a89bc9");
const C_PLAZA = new THREE.Color("#e6d3ab");
const C_SUN = new THREE.Color("#ffd9a8");

export function createTerrain(): THREE.Mesh {
  const SIZE = 150;
  const SEG = 150;
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
    const n1 = 0.5 + 0.5 * Math.sin(x * 0.35 + 1.3) * Math.cos(z * 0.3 - 0.7);
    const slope = slopeAt(x, z);

    if (h < 1.35) {
      c.copy(C_SAND); // 海滩
    } else if (slope > 0.55 || h > 10.5) {
      c.copy(C_ROCK).lerp(C_GRASS_HI, 0.25 * n1); // 岩石带
    } else {
      c.copy(C_GRASS_LO).lerp(C_GRASS_HI, n1 * 0.85); // 草坡
    }

    // 广场石色（中心压平区）
    const plaza = Math.exp(-(r * r) / 46);
    if (h >= 1.0) c.lerp(C_PLAZA, plaza * 0.85);

    // 沙滩与草地的过渡
    if (h >= 1.35 && h < 2.0) c.lerp(C_SAND, 1 - (h - 1.35) / 0.65);

    // 向阳坡染一点夕阳
    const nx = terrainHeight(x + 0.8, z) - terrainHeight(x - 0.8, z);
    const nz = terrainHeight(x, z + 0.8) - terrainHeight(x, z - 0.8);
    const nrm = new THREE.Vector3(-nx, 1.6, -nz).normalize();
    const sun = Math.max(0, nrm.dot(sunDir));
    c.lerp(C_SUN, sun * 0.13);

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshToonMaterial({ vertexColors: true });
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
