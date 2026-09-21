import * as THREE from "three";

/**
 * 声之灯塔：远处玩家的歌在视野尽头化成一根微弱的光柱——
 * 颜色=那首歌的颜色，越近越亮。先闻其声，循声相遇：
 * 把「相遇的机会」从 30 米的可听半径扩到全岛。
 */

let _beamTex: THREE.Texture | null = null;
function beamTexture(): THREE.Texture {
  if (_beamTex) return _beamTex;
  const w = 64;
  const h = 256;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createLinearGradient(0, h, 0, 0); // 底亮顶隐
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.35, "rgba(255,255,255,0.4)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // 横向柔化
  const gx = ctx.createLinearGradient(0, 0, w, 0);
  gx.addColorStop(0, "rgba(0,0,0,1)");
  gx.addColorStop(0.5, "rgba(0,0,0,0)");
  gx.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = gx;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  _beamTex = tex;
  return tex;
}

export interface BeaconTarget {
  key: string;
  pos: THREE.Vector3;
  color: THREE.Color;
  playing: boolean;
}

export function createBeacons(): {
  group: THREE.Group;
  update: (dt: number, t: number, selfPos: THREE.Vector3, camPos: THREE.Vector3, list: BeaconTarget[]) => void;
} {
  const group = new THREE.Group();
  const tex = beamTexture();
  const pool = new Map<string, { root: THREE.Group; mats: THREE.MeshBasicMaterial[]; seed: number }>();

  const mkBeam = (key: string) => {
    const root = new THREE.Group();
    const mats: THREE.MeshBasicMaterial[] = [];
    const geo = new THREE.PlaneGeometry(1.1, 26);
    geo.translate(0, 13, 0); // 根部在地面
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const m = new THREE.Mesh(geo, mat);
      if (i === 1) m.rotation.y = Math.PI / 2; // 十字交叉出体积感
      root.add(m);
      mats.push(mat);
    }
    group.add(root);
    const entry = { root, mats, seed: Math.random() * 10 };
    pool.set(key, entry);
    return entry;
  };

  const update = (dt: number, t: number, selfPos: THREE.Vector3, camPos: THREE.Vector3, list: BeaconTarget[]) => {
    const seen = new Set<string>();
    for (const b of list) {
      if (!b.playing) continue;
      const dist = b.pos.distanceTo(selfPos);
      if (dist < 26 || dist > 170) continue; // 近处直接看见真人，不立柱
      seen.add(b.key);
      const e = pool.get(b.key) ?? mkBeam(b.key);
      seen.add(b.key);
      // 亮度：26-40 渐入，60 后随距离衰减到远处微光 0.1
      const fadeIn = THREE.MathUtils.clamp((dist - 26) / 14, 0, 1);
      const far = THREE.MathUtils.clamp(1 - (dist - 60) / 130, 0.1, 1);
      const base = 0.5 * fadeIn * far;
      const breathe = 0.75 + 0.25 * Math.sin(t * 1.6 + e.seed);
      const op = base * breathe;
      e.root.position.set(b.pos.x, 0, b.pos.z);
      // 面向相机（绕 Y 的 billboard）
      e.root.rotation.y = Math.atan2(camPos.x - b.pos.x, camPos.z - b.pos.z);
      e.root.rotation.z = Math.sin(t * 0.6 + e.seed) * 0.035; // 微微摇曳
      for (const m of e.mats) {
        m.opacity = op;
        m.color.copy(b.color);
      }
    }
    for (const [key, e] of pool) {
      if (!seen.has(key)) {
        for (const m of e.mats) m.opacity = 0;
        e.root.visible = false;
      } else {
        e.root.visible = true;
      }
    }
    void dt;
  };

  return { group, update };
}
