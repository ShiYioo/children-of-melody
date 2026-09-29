import * as THREE from "three";
import { terrainHeight } from "../heightfield";

interface VoiceEmitter {
  rings: THREE.Mesh[];
  color: THREE.Color;
  pos: THREE.Vector3;
  level: number;
  target: number;
  phase: number;
  touched: boolean;
  quietFor: number;
}

/**
 * 语音世界反馈：让说话者脚下出现和音乐涟漪同一语言的动态声波。
 * 音量只由当前客户端的麦克风分析器或 WebRTC 远端流分析器驱动。
 */
export function createVoiceFX() {
  const group = new THREE.Group();
  const ringGeo = new THREE.RingGeometry(0.8, 0.98, 48);
  const emitters = new Map<string, VoiceEmitter>();

  function hashKey(key: string) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return (Math.abs(h) % 1000) / 1000;
  }

  function createEmitter(key: string): VoiceEmitter {
    const rings: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      // 前 3 个是向外扩散的涟漪，第 4 个是脚下常驻呼吸底环（对齐音乐光圈的 setRing 角色）
      const mesh = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      group.add(mesh);
      rings.push(mesh);
    }
    const emitter: VoiceEmitter = {
      rings,
      color: new THREE.Color("#9bd6b1"),
      pos: new THREE.Vector3(),
      level: 0,
      target: 0,
      phase: hashKey(key),
      touched: true,
      quietFor: 0,
    };
    emitters.set(key, emitter);
    return emitter;
  }

  function beginFrame() {
    for (const emitter of emitters.values()) emitter.touched = false;
  }

  function drive(key: string, pos: THREE.Vector3, color: THREE.Color, level: number) {
    const emitter = emitters.get(key) ?? createEmitter(key);
    emitter.touched = true;
    emitter.quietFor = 0;
    emitter.pos.copy(pos);
    emitter.color.copy(color);
    emitter.target = Math.max(0, Math.min(1, level));
  }

  function update(dt: number, time: number) {
    for (const [key, emitter] of emitters) {
      if (!emitter.touched) {
        emitter.target = 0;
        emitter.quietFor += dt;
      }
      emitter.level += (emitter.target - emitter.level) * Math.min(1, dt * 14);
      if (emitter.quietFor > 0.7 && emitter.level < 0.006) {
        for (const ring of emitter.rings) ring.visible = false;
        emitters.delete(key);
        continue;
      }

      const y = terrainHeight(emitter.pos.x, emitter.pos.z) + 0.08;
      const active = emitter.level > 0.008;
      // 弱信号提亮：level^0.65 让轻声说话也有可读的光圈（对齐音乐涟漪的存在感）
      const glow = Math.pow(emitter.level, 0.65);

      // 脚下底环：随音量呼吸的常驻光环
      const base = emitter.rings[3];
      const baseMat = base.material as THREE.MeshBasicMaterial;
      if (active) {
        const pulse = 0.62 + glow * 0.3 + 0.05 * Math.sin(time * 7 + emitter.phase * 6);
        base.position.set(emitter.pos.x, y, emitter.pos.z);
        base.scale.setScalar(pulse / 0.89);
        baseMat.color.copy(emitter.color);
        baseMat.opacity = Math.min(1, glow * 0.62);
        base.visible = true;
      } else {
        base.visible = false;
      }

      for (let i = 0; i < 3; i++) {
        const ring = emitter.rings[i];
        const material = ring.material as THREE.MeshBasicMaterial;
        const phase = (time * (1.15 + emitter.level * 0.5) + emitter.phase + i * 0.31) % 1;
        const radius = 0.5 + phase * (1.25 + emitter.level * 2.4);
        const fade = Math.pow(1 - phase, 1.3);
        const opacity = active ? glow * fade * (0.85 + 0.2 * Math.sin(time * 5 + i)) : 0;
        ring.position.set(emitter.pos.x, y, emitter.pos.z);
        ring.scale.setScalar(radius / 0.89);
        material.color.copy(emitter.color);
        material.opacity = opacity;
        ring.visible = opacity > 0.006;
      }
    }
  }

  return { group, beginFrame, drive, update };
}
