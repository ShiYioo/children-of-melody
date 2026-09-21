import * as THREE from "three";

/**
 * 云海 · 二代
 * 每朵云是一簇永远面向镜头的软光斑 sprite，叠成蓬松的团块——
 * 岛屿四周云海绵密，高空再飘几缕薄云。
 */
function puffTexture(): THREE.Texture {
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 10, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255, 251, 242, 1)");
  g.addColorStop(0.4, "rgba(255, 247, 235, 0.72)");
  g.addColorStop(0.75, "rgba(255, 243, 228, 0.22)");
  g.addColorStop(1, "rgba(255, 243, 228, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Cloud {
  group: THREE.Group;
  radius: number;
  angle: number;
  speed: number;
  bob: number;
  mat: THREE.SpriteMaterial; // 主色随昼夜相位推进（夜=暗蓝灰带月照边）
}

export function createClouds(): {
  group: THREE.Group;
  update: (t: number) => void;
  setPhase: (night: number, dawn: number) => void; // night 夜晚度, dawn 暖色度(黄昏/黎明)
} {
  const group = new THREE.Group();
  const tex = puffTexture();
  const baseMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: true });

  const clouds: Cloud[] = [];
  const cloudMats: THREE.SpriteMaterial[] = [];

  const mkCloud = (opts: {
    radius: number;
    y: number;
    scale: number;
    puffs: number;
    opacity: number;
    speed: number;
    squash?: number;
  }) => {
    const g = new THREE.Group();
    let firstMat: THREE.SpriteMaterial | null = null;
    for (let i = 0; i < opts.puffs; i++) {
      const mat = baseMat.clone();
      mat.opacity = opts.opacity * (0.75 + Math.random() * 0.35);
      cloudMats.push(mat);
      if (!firstMat) firstMat = mat;
      const sp = new THREE.Sprite(mat);
      const rr = Math.pow(Math.random(), 0.6); // 中心更密
      const a = Math.random() * Math.PI * 2;
      const s = opts.scale * (0.45 + 0.55 * (1 - rr * 0.5)) * (0.85 + Math.random() * 0.3);
      sp.scale.set(s, s * (opts.squash ?? 0.72), 1);
      sp.position.set(
        Math.cos(a) * rr * opts.scale * 0.62,
        (Math.random() - 0.4) * opts.scale * 0.13,
        Math.sin(a) * rr * opts.scale * 0.62
      );
      g.add(sp);
    }
    const angle = Math.random() * Math.PI * 2;
    g.position.set(Math.cos(angle) * opts.radius, opts.y, Math.sin(angle) * opts.radius);
    group.add(g);
    clouds.push({ group: g, radius: opts.radius, angle, speed: opts.speed, bob: Math.random() * 10, mat: firstMat! });
  };

  // 岛脚下的云海（绵密、大团）
  for (let i = 0; i < 26; i++) {
    mkCloud({
      radius: 78 + Math.random() * 190,
      y: -8 + Math.random() * 4.5,
      scale: 30 + Math.random() * 46,
      puffs: 7 + Math.floor(Math.random() * 3),
      opacity: 0.5 + Math.random() * 0.3,
      speed: 0.004 + Math.random() * 0.005,
      squash: 0.6,
    });
  }
  // 中景稀疏几朵
  for (let i = 0; i < 8; i++) {
    mkCloud({
      radius: 90 + Math.random() * 160,
      y: 12 + Math.random() * 26,
      scale: 14 + Math.random() * 20,
      puffs: 5,
      opacity: 0.32 + Math.random() * 0.2,
      speed: 0.003 + Math.random() * 0.004,
      squash: 0.68,
    });
  }
  // 高空薄云
  for (let i = 0; i < 6; i++) {
    mkCloud({
      radius: 150 + Math.random() * 240,
      y: 55 + Math.random() * 38,
      scale: 46 + Math.random() * 60,
      puffs: 4,
      opacity: 0.14 + Math.random() * 0.08,
      speed: 0.002 + Math.random() * 0.002,
      squash: 0.4,
    });
  }

  return {
    group,
    update: (t: number) => {
      for (const c of clouds) {
        c.angle += c.speed * 0.016;
        c.group.position.x = Math.cos(c.angle) * c.radius;
        c.group.position.z = Math.sin(c.angle) * c.radius;
        c.group.position.y += Math.sin(t * 0.18 + c.bob) * 0.003;
      }
    },
    // 云色随昼夜：白昼亮白 → 黄昏/黎明染玫瑰金 → 夜晚沉入暗蓝灰（比天穹稍亮，月光感）
    setPhase: (night: number, dawn: number) => {
      const day = new THREE.Color("#fffbf2");
      const dusk = new THREE.Color("#f2b49a");
      const moon = new THREE.Color("#3a4668");
      const tint = day.clone().lerp(dusk, dawn).lerp(moon, night);
      for (const m of cloudMats) m.color.copy(tint);
    },
  };
}
