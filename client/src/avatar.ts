import * as THREE from "three";
import { createToonKit } from "./world/toon";

/**
 * 光遇风小人：奶白圆身、深色小脸、彩色披风，
 * 脚下一圈随音乐律动的光环，头顶漂浮名牌。
 */

export interface Avatar {
  group: THREE.Group; // 挂在场景的根（原点在脚底）
  /** 每帧驱动：移动摆动、披风、坐下姿势插值 */
  animate: (dt: number, t: number, speed: number, sit: boolean) => void;
  /** 设置音乐光环的颜色与可见强度 (0~1) */
  setRing: (color: THREE.Color | null, energy: number) => void;
  /** 名牌 */
  setName: (name: string) => void;
  dispose: () => void;
}

function nameTexture(name: string): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 72;
  const ctx = cv.getContext("2d")!;
  ctx.font = "600 30px 'HarmonyOS Sans SC', 'MiSans', 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // 软底
  ctx.fillStyle = "rgba(30, 20, 48, 0.45)";
  const w = Math.min(240, ctx.measureText(name).width + 44);
  ctx.beginPath();
  ctx.roundRect(128 - w / 2, 16, w, 40, 20);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 246, 232, 0.96)";
  ctx.fillText(name, 128, 38);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createAvatar(opts: { name: string; hue: number; self?: boolean }): Avatar {
  const kit = createToonKit();
  const group = new THREE.Group();

  // ---- 身体 ----
  const bodyGroup = new THREE.Group(); // 用于坐下前倾
  group.add(bodyGroup);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.5, 6, 12), kit.mat("#f7efdd"));
  body.position.y = 0.82;
  body.castShadow = true;
  bodyGroup.add(body);

  // 披风：hue 决定颜色
  const cloakColor = new THREE.Color().setHSL(opts.hue / 360, 0.42, 0.6);
  const cloak = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.0, 10, 1, true),
    new THREE.MeshToonMaterial({ color: cloakColor, gradientMap: undefined, side: THREE.DoubleSide })
  );
  cloak.position.set(0, 0.95, 0.14);
  cloak.rotation.x = 0.22;
  cloak.castShadow = true;
  bodyGroup.add(cloak);

  // 深色小脸
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 12), kit.mat("#3a3350"));
  head.position.y = 1.48;
  head.castShadow = true;
  bodyGroup.add(head);

  const eyeMat = new THREE.MeshBasicMaterial({ color: "#fff7e6" });
  for (const dx of [-0.09, 0.09]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.038, 6, 6), eyeMat);
    eye.position.set(dx, 1.5, 0.24);
    bodyGroup.add(eye);
  }

  // 头顶的小烛光
  const wisp = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshBasicMaterial({ color: cloakColor.clone().lerp(new THREE.Color("#fff2cf"), 0.5) })
  );
  wisp.position.y = 1.94;
  bodyGroup.add(wisp);

  // ---- 名牌 ----
  let nameTex = nameTexture(opts.name);
  const nameSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: nameTex, transparent: true, depthWrite: false, opacity: opts.self ? 0.75 : 0.95 })
  );
  nameSprite.scale.set(1.9, 0.53, 1);
  nameSprite.position.y = 2.5;
  group.add(nameSprite);

  // ---- 音乐光环 ----
  const ringMat = new THREE.MeshBasicMaterial({
    color: "#ffb45e",
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.28, 44), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(ring);

  const discMat = ringMat.clone();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 36), discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.05;
  group.add(disc);

  // 光环上方漂浮的音符微光
  const moteCount = 10;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(moteCount * 3);
  const motePh = new Float32Array(moteCount);
  for (let i = 0; i < moteCount; i++) motePh[i] = Math.random();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const moteMat = new THREE.PointsMaterial({ color: "#ffb45e", size: 0.14, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const motes = new THREE.Points(moteGeo, moteMat);
  group.add(motes);

  // ---- 动画状态 ----
  let sitLerp = 0;
  let walkPhase = 0;
  let ringEnergy = 0;

  return {
    group,
    animate(dt, t, speed, sit) {
      // 坐下姿势插值 + 走路起伏（都作用在身体组上，不碰根节点）
      sitLerp = THREE.MathUtils.lerp(sitLerp, sit ? 1 : 0, 1 - Math.pow(0.002, dt));
      walkPhase += dt * (2.2 + speed * 2.6);
      const bob = speed > 0.2 ? Math.abs(Math.sin(walkPhase)) * 0.055 : Math.sin(t * 1.4) * 0.012;
      bodyGroup.rotation.x = -1.15 * sitLerp + Math.min(0.2, speed * 0.045);
      bodyGroup.position.y = -0.42 * sitLerp + bob;

      // 披风随速度飘
      const flow = 0.22 + Math.min(0.75, speed * 0.12);
      cloak.rotation.x = flow + Math.sin(walkPhase * 1.1) * 0.06 * (speed > 0.2 ? 1 : 0.3);

      // 烛光呼吸
      wisp.scale.setScalar(0.85 + 0.18 * Math.sin(t * 2.4 + opts.hue));
      wisp.position.y = 1.94 + Math.sin(t * 1.8 + opts.hue) * 0.03;

      // 光环脉动（节拍由外部喂进 setRing 的 energy）
      const pulse = 1 + 0.075 * Math.sin(t * 6.2) * ringEnergy;
      ring.scale.setScalar(pulse);
      ring.position.y = 0.06 + 0.04 * ringEnergy;
      disc.scale.setScalar(pulse);

      // 音符微光上升
      const arr = moteGeo.attributes.position.array as Float32Array;
      for (let i = 0; i < moteCount; i++) {
        motePh[i] += dt * 0.24;
        if (motePh[i] > 1) motePh[i] -= 1;
        const p = motePh[i];
        const a = (i / moteCount) * Math.PI * 2 + t * 0.4;
        arr[i * 3] = Math.cos(a) * (0.55 + p * 0.35);
        arr[i * 3 + 1] = 0.15 + p * 1.7;
        arr[i * 3 + 2] = Math.sin(a) * (0.55 + p * 0.35);
      }
      moteGeo.attributes.position.needsUpdate = true;
    },
    setRing(color, energy) {
      ringEnergy = energy;
      if (color) {
        ringMat.color.copy(color);
        discMat.color.copy(color);
        moteMat.color.copy(color);
      }
      ringMat.opacity = 0.75 * energy;
      discMat.opacity = 0.14 * energy;
      moteMat.opacity = 0.85 * energy;
    },
    setName(name) {
      nameSprite.material.map?.dispose();
      nameTex = nameTexture(name);
      nameSprite.material.map = nameTex;
      nameSprite.material.needsUpdate = true;
    },
    dispose() {
      kit.dispose();
      nameTex.dispose();
      ringMat.dispose();
      discMat.dispose();
      moteMat.dispose();
      (cloak.material as THREE.Material).dispose();
    },
  };
}
