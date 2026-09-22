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
  const ringGeo = new THREE.RingGeometry(0.88, 0.94, 48);
  const emitters = new Map<string, VoiceEmitter>();

  function hashKey(key: string) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return (Math.abs(h) % 1000) / 1000;
  }

  function createEmitter(key: string): VoiceEmitter {
    const rings: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
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
      for (let i = 0; i < emitter.rings.length; i++) {
        const ring = emitter.rings[i];
        const material = ring.material as THREE.MeshBasicMaterial;
        const phase = (time * (1.05 + emitter.level * 0.45) + emitter.phase + i * 0.31) % 1;
        const radius = 0.42 + phase * (0.95 + emitter.level * 1.75);
        const fade = Math.pow(1 - phase, 1.35);
        const opacity = active ? emitter.level * fade * (0.34 + 0.12 * Math.sin(time * 5 + i)) : 0;
        ring.position.set(emitter.pos.x, y, emitter.pos.z);
        ring.scale.setScalar(radius / 0.91);
        material.color.copy(emitter.color);
        material.opacity = opacity;
        ring.visible = opacity > 0.006;
      }
    }
  }

  return { group, beginFrame, drive, update };
}
