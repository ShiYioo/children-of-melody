import * as THREE from "three";
import type { ToonKit } from "./toon";
import type { InstrumentKind } from "../audio/instruments";
import { patchRimMaterial } from "./rim";
import { softDotTexture } from "./fxtextures";
import { fxColor } from "./lightstate";

/**
 * 手持乐器的可见形体：竖琴（金色弓+琴弦）/ 长笛（木管）/ 风铃（吊铃）。
 *
 * 乐器是仅次于角色的「近景特写」——它们会贴在镜头前被反复打量，所以：
 * - 分段要够：原来是 6 段管环 / 8 段圆柱，剪影上全是折线（审查里说的"多边形剪影"）；
 * - 补上统一轮廓光：乐器原来和家具一样**从没走过 patchRimMaterial**，
 *   在暗背景里整件乐器糊成一团，和角色"有边没边"不一致；
 * - 风铃本身就是发光的乐器，给它一张极柔光晕贴图，夜里真的亮起来。
 */
export function makeInstrumentMesh(kind: InstrumentKind, kit: ToonKit): THREE.Group {
  const g = new THREE.Group();
  if (kind === "harp") {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.034, 10, 30, Math.PI * 1.15), kit.mat("#e8c37a"));
    arc.rotation.z = Math.PI * 0.15;
    g.add(arc);
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.4 - i * 0.05, 5), kit.mat("#fff6dc"));
      s.position.set(-0.2 + i * 0.1, 0.05, 0);
      g.add(s);
    }
  } else if (kind === "flute") {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.62, 14), kit.mat("#b98b6f"));
    tube.rotation.z = Math.PI / 2;
    g.add(tube);
    for (let i = 0; i < 4; i++) {
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 8), kit.mat("#6e5138"));
      hole.rotation.z = Math.PI / 2;
      hole.position.set(-0.14 + i * 0.09, 0.045, 0);
      g.add(hole);
    }
  } else {
    const top = new THREE.Mesh(new THREE.CapsuleGeometry(0.013, 0.3, 3, 8), kit.mat("#8d6f52"));
    top.rotation.z = 0.5;
    g.add(top);
    for (let i = 0; i < 4; i++) {
      const bell = new THREE.Mesh(new THREE.SphereGeometry(0.05 - i * 0.006, 12, 10), kit.mat("#f2dfae"));
      bell.position.set(-0.1 + i * 0.075, 0.1 - Math.abs(i - 1.5) * 0.05, 0);
      g.add(bell);
    }
    // 风铃的柔光：铃本是光的乐器，夜里要真的亮起来
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: softDotTexture(),
        color: fxColor("#ffe6b0"),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    halo.scale.setScalar(0.5);
    halo.position.set(0, 0.06, 0);
    g.add(halo);
  }
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.renderOrder = 1;
      if (m.material) patchRimMaterial(m.material as THREE.Material);
    }
  });
  return g;
}
