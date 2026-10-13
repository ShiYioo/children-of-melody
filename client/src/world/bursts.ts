import * as THREE from "three";
import { lightState } from "./lightstate";
import { puffTexture, softDotTexture, softRingTexture } from "./fxtextures";

/**
 * 瞬态光效池：扑翼时的一圈光尘、落地时扩散的柔光涟漪。
 *
 * 这里的每个部件都要同时满足两条，少了任何一条都不是"发光"：
 *  1. 材质颜色必须乘 HDR 增益 `lightState.fxGain()`。加法混合下片元的实际贡献是
 *     `color × opacity × 贴图`，而 bloom 的高通作用在线性、未色调映射的值上、阈值 0.8；
 *     原来 `#ffe9c0`(亮度 0.83) × opacity 0.7 峰值才 0.58，这些爆点从来没有泛光。
 *  2. 部件必须用柔光贴图（fxtextures）。RingGeometry / SphereGeometry 的硬边在加法
 *     混合下就是一圈硬边光环 + 一堆硬边小球，是"程序员美术"最暴露的地方。
 */

interface BurstPart {
  obj: THREE.Object3D; // 地面涟漪是 Mesh，光点是 Sprite
  mat: THREE.MeshBasicMaterial | THREE.SpriteMaterial;
  /** 观感基准色（burst() 写入）；每帧从这里 copy 再乘增益，绝不原地累乘 */
  base: THREE.Color;
}

interface Burst {
  group: THREE.Group;
  life: number;
  dur: number;
  kind: "flap" | "land";
  parts: BurstPart[];
  seeds: number[];
}

export function createBursts(): {
  group: THREE.Group;
  burst: (pos: THREE.Vector3, color: THREE.Color, kind: "flap" | "land") => void;
  update: (dt: number) => void;
} {
  const group = new THREE.Group();
  const pool: Burst[] = [];
  const MAX = 10;

  // softRingTexture 的峰值在贴图半径 0.72 处，所以半边长取 2/0.72 → 纹理峰值正好落在
  // 世界半径 1.0 上：scale=1 即"半径 1 的涟漪"，跟原来 RingGeometry(0.85, 1.05) 同尺度。
  const RING_PEAK = 0.72;
  const ringGeo = new THREE.PlaneGeometry(2 / RING_PEAK, 2 / RING_PEAK);

  function make(kind: "flap" | "land"): Burst {
    const g = new THREE.Group();
    const parts: BurstPart[] = [];
    const add = (obj: THREE.Object3D, mat: BurstPart["mat"]) => {
      g.add(obj);
      parts.push({ obj, mat, base: new THREE.Color(1, 1, 1) });
    };

    if (kind === "land") {
      // 涟漪环：平铺在地面的柔环（必须躺下，不能跟着相机 billboard）
      const ringMat = new THREE.MeshBasicMaterial({
        map: softRingTexture(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      add(ring, ringMat);
      // 几粒尘点：改用 puff 贴图的精灵，替代原来的硬边小球
      for (let i = 0; i < 6; i++) {
        const m = new THREE.SpriteMaterial({
          map: puffTexture(),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const dot = new THREE.Sprite(m);
        dot.scale.setScalar(0.26);
        add(dot, m);
      }
    } else {
      // 扑翼光尘：一圈柔光点
      for (let i = 0; i < 12; i++) {
        const m = new THREE.SpriteMaterial({
          map: softDotTexture(),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const dot = new THREE.Sprite(m);
        dot.scale.setScalar(0.2);
        add(dot, m);
      }
    }
    g.visible = false;
    group.add(g);
    return { group: g, life: 0, dur: kind === "flap" ? 0.7 : 0.55, kind, parts, seeds: [] };
  }

  for (let i = 0; i < MAX; i++) pool.push(make(i % 2 === 0 ? "flap" : "land"));

  function burst(pos: THREE.Vector3, color: THREE.Color, kind: "flap" | "land") {
    const b = pool.find((p) => !p.group.visible && p.kind === kind) ?? pool.find((p) => p.kind === kind);
    if (!b) return;
    b.group.visible = true;
    b.life = b.dur;
    b.group.position.copy(pos);
    if (b.kind === "land") b.group.position.y += 0.08;
    // 只写基准色；增益在 update 里统一乘（避免和昼夜变化叠加时漏乘/重复乘）
    b.parts.forEach((p) => p.base.copy(color));
    b.seeds = b.parts.map(() => Math.random() * Math.PI * 2);
  }

  const DOWN = new THREE.Vector3(0, -1, 0);

  function update(dt: number) {
    const gain = lightState.fxGain();
    for (const b of pool) {
      if (!b.group.visible) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.group.visible = false;
        continue;
      }
      // 基准色 → HDR 自发光色。每帧 copy 重建，绝不在原色上累乘。
      for (const p of b.parts) p.mat.color.copy(p.base).multiplyScalar(gain);

      const k = 1 - b.life / b.dur; // 0→1
      if (b.kind === "land") {
        const ring = b.parts[0].obj;
        ring.scale.setScalar(0.4 + k * 2.4);
        (b.parts[0].mat as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
        for (let i = 1; i < b.parts.length; i++) {
          const dot = b.parts[i].obj;
          const a = (b.seeds[i] ?? i) + k * 2;
          const r = 0.8 + k * 1.6;
          dot.position.set(Math.cos(a) * r, 0.15 + Math.sin(k * 6 + i) * 0.12, Math.sin(a) * r);
          (b.parts[i].mat as THREE.SpriteMaterial).opacity = 0.7 * (1 - k);
        }
      } else {
        b.parts.forEach((p, i) => {
          const a = (b.seeds[i] ?? i * 0.5) + k * 0.8;
          const r = 0.35 + k * 1.9;
          p.obj.position.set(Math.cos(a) * r, 0.9 + k * 1.3 + Math.sin(k * 5 + i) * 0.1, Math.sin(a) * r);
          // 每个光点自己的明暗相位：0.6~1.0，整体保持在高亮侧，不去扫过亮度阈值。
          (p.mat as THREE.SpriteMaterial).opacity = 0.9 * (1 - k) * (0.8 + 0.2 * Math.sin(k * 9 + i));
        });
      }
      void DOWN;
    }
  }

  return { group, burst, update };
}
