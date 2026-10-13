import * as THREE from "three";
import type { MusicFeatureFrame } from "../audio/engine";
import { terrainHeight } from "../heightfield";
import { lightState } from "./lightstate";
import { softRingTexture } from "./fxtextures";

/**
 * 音乐动效（光遇式）：把 features() 的分频段包络变成可见的世界反应——
 * · 节拍踩点 → 脚下地面涟漪一圈圈荡开
 * · 能量 → 音符光粒从身边升起；低频音符大而缓，高频碎光小而亮
 * · 所有池化，零运行时分配
 */

interface Emitter {
  acc: number; // 音符发射累积器
  prevBeat: number; // 上一帧节拍脉冲（检测新踩点）
  touched: boolean;
}

interface Ripple {
  mesh: THREE.Mesh;
  life: number;
  dur: number;
  strength: number;
  /** 观感基准色（spawnRipple 写入）；每帧 copy 后乘 fxGain，禁止原地累乘 */
  base: THREE.Color;
}

interface Note {
  sprite: THREE.Sprite;
  life: number;
  dur: number;
  vy: number;
  swayA: number;
  swayW: number;
  size: number;
  /** 同上：基准色，每帧 copy 后乘 fxGain */
  base: THREE.Color;
}

/** 音符纹理：柔光晕 + 音符字形（颜色由精灵 tint 决定） */
function noteTexture(glyph: string): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 128;
  cv.height = 128;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.32)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  ctx.font = "700 64px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,0.98)";
  ctx.fillText(glyph, 64, 66);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createMusicFX() {
  const group = new THREE.Group();

  // ---- 地面涟漪池 ----
  // RingGeometry(0.94, 1) 是一圈硬边环；换成柔环贴图后，峰在贴图半径 0.72 处，
  // 所以半边长取 2/0.72 → 纹理峰值落在世界半径 1.0，scale 语义跟原来一致。
  const RING_PEAK = 0.72;
  const ripplePool: Ripple[] = [];
  const rippleGeo = new THREE.PlaneGeometry(2 / RING_PEAK, 2 / RING_PEAK);
  const rippleTex = softRingTexture();
  for (let i = 0; i < 12; i++) {
    const mesh = new THREE.Mesh(
      rippleGeo,
      new THREE.MeshBasicMaterial({ map: rippleTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    group.add(mesh);
    ripplePool.push({ mesh, life: 0, dur: 0.85, strength: 1, base: new THREE.Color(1, 1, 1) });
  }

  // ---- 音符粒子池 ----
  const glyphs = [noteTexture("\u266A"), noteTexture("\u266B"), noteTexture("\u266C")]; // ♪ ♫ ♬
  const notePool: Note[] = [];
  for (let i = 0; i < 56; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glyphs[i % 3], transparent: true, depthWrite: false, opacity: 0 }));
    sprite.visible = false;
    group.add(sprite);
    notePool.push({ sprite, life: 0, dur: 1, vy: 0, swayA: 0, swayW: 0, size: 0.2, base: new THREE.Color(1, 1, 1) });
  }

  const emitters = new Map<string, Emitter>();
  const tmpColor = new THREE.Color();
  /** 音符向暖白靠拢的目标色（原来每次 spawn 都 new 一个，白白产生 GC 垃圾） */
  const NOTE_HOT = new THREE.Color("#fff6e0");
  const baseX = new Map<Note, number>();

  function spawnRipple(pos: THREE.Vector3, color: THREE.Color, strength: number) {
    const r = ripplePool.find((x) => !x.mesh.visible) ?? ripplePool[0];
    r.mesh.visible = true;
    r.life = r.dur;
    r.strength = strength;
    r.mesh.position.set(pos.x, terrainHeight(pos.x, pos.z) + 0.07, pos.z);
    r.base.copy(color);
    // 立即写一次（否则重生后第一帧还是上一个使用者的颜色）
    (r.mesh.material as THREE.MeshBasicMaterial).color.copy(r.base).multiplyScalar(lightState.fxGain());
  }

  function spawnNote(pos: THREE.Vector3, color: THREE.Color, size: number, brightness: number) {
    const n = notePool.find((x) => !x.sprite.visible) ?? notePool[0];
    n.sprite.visible = true;
    n.dur = 1.4 + Math.random() * 1.1;
    n.life = n.dur;
    n.size = size;
    const a = Math.random() * Math.PI * 2;
    const rad = 0.5 + Math.random() * 1.1;
    n.sprite.position.set(pos.x + Math.cos(a) * rad, pos.y + 0.7 + Math.random() * 0.8, pos.z + Math.sin(a) * rad);
    n.vy = (0.55 + Math.random() * 0.45) * (0.8 + size);
    n.swayA = Math.random() * Math.PI * 2;
    n.swayW = 1.2 + Math.random() * 1.6;
    baseX.set(n, n.sprite.position.x);
    tmpColor.copy(color).lerp(NOTE_HOT, 0.35 + brightness * 0.3);
    n.base.copy(tmpColor);
    const nm = n.sprite.material as THREE.SpriteMaterial;
    nm.color.copy(n.base).multiplyScalar(lightState.fxGain());
    nm.opacity = 0;
    n.sprite.scale.setScalar(size);
  }

  /** 每帧先调用：标记存活发射器，update 时清掉没人驱动的 */
  function beginFrame() {
    for (const e of emitters.values()) e.touched = false;
  }

  /** 单音符光效（乐器弹奏）：一个升起的大音符 + 一圈小涟漪 */
  function noteBurst(pos: THREE.Vector3, color: THREE.Color, strength = 1) {
    spawnNote(pos, color, 0.3 + 0.08 * strength, 0.8);
    if (strength > 0.45) spawnRipple(pos, color, strength * 0.7);
  }

  /** 驱动一个正在播放音乐的人的动效（自己 clarity=1；远端按听感清晰度衰减） */
  function drive(key: string, pos: THREE.Vector3, color: THREE.Color, f: MusicFeatureFrame, dt: number, clarity: number) {
    if (f.level <= 0.01 && f.beat <= 0.01) return;
    let e = emitters.get(key);
    if (!e) {
      e = { acc: 0, prevBeat: 0, touched: true };
      emitters.set(key, e);
    }
    e.touched = true;

    // 新踩点：检测 beat 的上跳沿（衰减中突然被顶回高处）
    if (f.beat > e.prevBeat + 0.25 && f.beat > 0.4) {
      spawnRipple(pos, color, f.beat);
      spawnNote(pos, color, 0.34 + f.bass * 0.1, f.bass); // 低频音符：大而缓
    }
    e.prevBeat = f.beat;

    // 连续能量 → 音符升腾（清晰度越低越稀疏、越淡）
    e.acc += dt * (1.2 + f.level * 9) * (0.35 + 0.65 * clarity);
    while (e.acc >= 1) {
      e.acc -= 1;
      // 高频亮 → 小碎光的概率高；中频为主时是普通音符
      const hi = Math.random() < f.treble * 0.9;
      spawnNote(pos, color, hi ? 0.13 + Math.random() * 0.08 : 0.2 + Math.random() * 0.08, hi ? f.treble : f.mid);
    }
  }

  function update(dt: number) {
    // 自发光 HDR 增益：加法混合下实际贡献 = color × opacity × 贴图，三项一起决定
    // 片元的线性亮度；不乘增益的话这些涟漪/音符的峰值亮度永远在 bloom 阈值 0.8 以下。
    const gain = lightState.fxGain();
    for (const [k, e] of emitters) if (!e.touched) emitters.delete(k);
    for (const r of ripplePool) {
      if (!r.mesh.visible) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.mesh.visible = false;
        continue;
      }
      const k = 1 - r.life / r.dur; // 0→1
      r.mesh.scale.setScalar(0.5 + k * (2.6 + r.strength * 2));
      const rm = r.mesh.material as THREE.MeshBasicMaterial;
      rm.color.copy(r.base).multiplyScalar(gain); // 基准色 copy 后乘，绝不原地累乘
      rm.opacity = 0.5 * r.strength * (1 - k) * (0.4 + 0.6 * Math.sin(Math.min(1, k * 2.2) * Math.PI * 0.5));
    }
    for (const n of notePool) {
      if (!n.sprite.visible) continue;
      n.life -= dt;
      if (n.life <= 0) {
        n.sprite.visible = false;
        continue;
      }
      const k = 1 - n.life / n.dur; // 0→1
      n.swayA += n.swayW * dt;
      n.sprite.position.y += n.vy * dt;
      n.sprite.position.x = baseX.get(n)! + Math.sin(n.swayA) * 0.18;
      const m = n.sprite.material as THREE.SpriteMaterial;
      m.color.copy(n.base).multiplyScalar(gain);
      // 前段淡入、后段淡出（transient 本来就该淡出；呼吸/闪烁才需要一直待在阈值之上）
      m.opacity = Math.min(1, k * 4) * Math.min(1, (1 - k) * 2.2) * 0.85;
      n.sprite.scale.setScalar(n.size * (1 + Math.sin(n.swayA * 1.7) * 0.12));
    }
  }

  return { group, beginFrame, drive, update, noteBurst };
}
