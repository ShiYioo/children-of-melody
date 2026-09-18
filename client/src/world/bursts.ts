import * as THREE from "three";

/**
 * 瞬态光效池：扑翼时的一圈光尘、落地时扩散的柔光涟漪。
 */
interface Burst {
  group: THREE.Group;
  life: number;
  dur: number;
  kind: "flap" | "land";
  parts: THREE.Mesh[];
  userDataSeeds?: number[];
}

export function createBursts(): {
  group: THREE.Group;
  burst: (pos: THREE.Vector3, color: THREE.Color, kind: "flap" | "land") => void;
  update: (dt: number) => void;
} {
  const group = new THREE.Group();
  const pool: Burst[] = [];
  const MAX = 10;

  function make(kind: "flap" | "land"): Burst {
    const g = new THREE.Group();
    const parts: THREE.Mesh[] = [];
    if (kind === "land") {
      // 涟漪环
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.85, 1.05, 36),
        new THREE.MeshBasicMaterial({ color: "#ffe9c0", transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      g.add(ring);
      parts.push(ring);
      // 几粒尘点
      for (let i = 0; i < 6; i++) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.06, 6, 5),
          new THREE.MeshBasicMaterial({ color: "#f2e2c0", transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        g.add(dot);
        parts.push(dot);
      }
    } else {
      // 扑翼光尘：一圈小光点
      for (let i = 0; i < 12; i++) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.055, 6, 5),
          new THREE.MeshBasicMaterial({ color: "#fff2cf", transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        g.add(dot);
        parts.push(dot);
      }
    }
    g.visible = false;
    group.add(g);
    return { group: g, life: 0, dur: kind === "flap" ? 0.7 : 0.55, kind, parts };
  }

  for (let i = 0; i < MAX; i++) pool.push(make(i % 2 === 0 ? "flap" : "land"));

  function burst(pos: THREE.Vector3, color: THREE.Color, kind: "flap" | "land") {
    const b = pool.find((p) => !p.group.visible && p.kind === kind) ?? pool.find((p) => p.kind === kind);
    if (!b) return;
    b.group.visible = true;
    b.life = b.dur;
    b.group.position.copy(pos);
    if (b.kind === "land") b.group.position.y += 0.08;
    b.parts.forEach((m) => (m.material as THREE.MeshBasicMaterial).color.copy(color));
    b.userDataSeeds = b.parts.map(() => Math.random() * Math.PI * 2);
  }

  const DOWN = new THREE.Vector3(0, -1, 0);

  function update(dt: number) {
    for (const b of pool) {
      if (!b.group.visible) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.group.visible = false;
        continue;
      }
      const k = 1 - b.life / b.dur; // 0→1
      if (b.kind === "land") {
        const ring = b.parts[0];
        ring.scale.setScalar(0.4 + k * 2.4);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
        for (let i = 1; i < b.parts.length; i++) {
          const dot = b.parts[i];
          const a = (b.userDataSeeds?.[i] ?? i) + k * 2;
          const r = 0.8 + k * 1.6;
          dot.position.set(Math.cos(a) * r, 0.15 + Math.sin(k * 6 + i) * 0.12, Math.sin(a) * r);
          (dot.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
        }
      } else {
        b.parts.forEach((dot, i) => {
          const a = (b.userDataSeeds?.[i] ?? i * 0.5) + k * 0.8;
          const r = 0.35 + k * 1.9;
          dot.position.set(
            Math.cos(a) * r,
            0.9 + k * 1.3 + Math.sin(k * 5 + i) * 0.1,
            Math.sin(a) * r
          );
          (dot.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k) * (0.6 + 0.4 * Math.sin(k * 9 + i));
        });
      }
      void DOWN;
    }
  }

  return { group, burst, update };
}
