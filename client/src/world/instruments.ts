import * as THREE from "three";
import type { ToonKit } from "./toon";
import type { InstrumentKind } from "../audio/instruments";

/** 手持乐器的可见形体：竖琴（金色弓+琴弦）/ 长笛（木管）/ 风铃（吊铃） */
export function makeInstrumentMesh(kind: InstrumentKind, kit: ToonKit): THREE.Group {
  const g = new THREE.Group();
  if (kind === "harp") {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.03, 6, 20, Math.PI * 1.15), kit.mat("#e8c37a"));
    arc.rotation.z = Math.PI * 0.15;
    g.add(arc);
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.4 - i * 0.05, 3), kit.mat("#fff6dc"));
      s.position.set(-0.2 + i * 0.1, 0.05, 0);
      g.add(s);
    }
  } else if (kind === "flute") {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.62, 8), kit.mat("#b98b6f"));
    tube.rotation.z = Math.PI / 2;
    g.add(tube);
    for (let i = 0; i < 4; i++) {
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 6), kit.mat("#6e5138"));
      hole.rotation.z = Math.PI / 2;
      hole.position.set(-0.14 + i * 0.09, 0.045, 0);
      g.add(hole);
    }
  } else {
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 5), kit.mat("#8d6f52"));
    top.rotation.z = 0.5;
    g.add(top);
    for (let i = 0; i < 4; i++) {
      const bell = new THREE.Mesh(new THREE.SphereGeometry(0.05 - i * 0.006, 8, 6), kit.mat("#f2dfae"));
      bell.position.set(-0.1 + i * 0.075, 0.1 - Math.abs(i - 1.5) * 0.05, 0);
      g.add(bell);
    }
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      (o as THREE.Mesh).renderOrder = 1;
    }
  });
  return g;
}
