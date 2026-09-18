import * as THREE from "three";
import { createToonKit } from "./world/toon";

/**
 * 光遇风小人 · 二代
 *
 * 建模参考 Sky: Children of the Light：
 *  - 大而圆的头 + 深色面具脸 + 两只又大又亮的眼睛（灵魂所在）
 *  - 小小的奶色身体、短短的四肢
 *  - 与眼睛同色的兜帽
 *  - 双层披风：外长内短，顶点级布料波动，随速度向后飘
 *  - 身体带一圈淡淡的轮廓光
 */

export interface Avatar {
  group: THREE.Group; // 挂在场景的根（原点在脚底）
  /** air: 0 地面 / 1 腾空上升 / 2 滑翔 */
  animate: (dt: number, t: number, speed: number, sit: boolean, air?: number, yawVel?: number) => void;
  /** 落地缓冲（着地瞬间调用） */
  land: () => void;
  /** 扑翼脉冲（腾空按跳时调用，披风向后上方一抖） */
  flap: () => void;
  setRing: (color: THREE.Color | null, energy: number) => void;
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

/** 披风材质：toon + 顶点布料波动（uTime/uAmp/uFlow 共享 uniforms） */
function makeCapeMaterial(color: THREE.Color, gradientMap: THREE.DataTexture | null, uni: Record<string, THREE.IUniform>) {
  const mat = new THREE.MeshToonMaterial({ color, side: THREE.DoubleSide, gradientMap: gradientMap ?? undefined });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uni.uTime;
    shader.uniforms.uAmp = uni.uAmp;
    shader.uniforms.uFlow = uni.uFlow;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uAmp;\nuniform float uFlow;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float capeF = 1.0 - uv.y; // 0 顶(固定端) → 1 底(自由端)
        transformed.x += sin(uTime * 2.6 + position.y * 4.0) * 0.05 * capeF * uAmp;
        transformed.z += (cos(uTime * 2.0 + position.y * 3.2) * 0.04 - uFlow * 0.55) * capeF * capeF;
        `
      );
  };
  return mat;
}

export function createAvatar(opts: { name: string; hue: number; self?: boolean }): Avatar {
  const kit = createToonKit();
  const group = new THREE.Group();

  const bodyGroup = new THREE.Group();
  group.add(bodyGroup);

  // ---- 配色 ----
  const capeOuter = new THREE.Color().setHSL(opts.hue / 360, 0.46, 0.56);
  const capeInner = capeOuter.clone().offsetHSL(0, 0.02, 0.12);
  const hoodColor = capeOuter.clone().offsetHSL(0, 0, -0.06);
  const skin = "#f6ecd8"; // 奶白
  const skinDark = "#e6d5ba";
  const faceDark = "#2e2745"; // 面具脸

  // ---- 腿 ----
  const legGeo = new THREE.CapsuleGeometry(0.085, 0.2, 4, 8);
  const legL = new THREE.Mesh(legGeo, kit.mat(skinDark));
  legL.position.set(-0.11, 0.24, 0);
  const legR = legL.clone();
  legR.position.x = 0.11;
  bodyGroup.add(legL, legR);

  // ---- 身体 ----
  const torso = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 14), kit.mat(skin));
  torso.scale.set(0.3, 0.36, 0.26);
  torso.position.y = 0.62;
  torso.castShadow = true;
  bodyGroup.add(torso);

  // ---- 手臂 ----
  const armGeo = new THREE.CapsuleGeometry(0.055, 0.3, 4, 8);
  const armL = new THREE.Mesh(armGeo, kit.mat(skinDark));
  armL.position.set(-0.32, 0.66, 0);
  armL.rotation.z = 0.18;
  const armR = armL.clone();
  armR.position.x = 0.32;
  armR.rotation.z = -0.18;
  armL.castShadow = armR.castShadow = true;
  bodyGroup.add(armL, armR);

  // ---- 头（大、圆、戴兜帽的面具脸） ----
  const headGroup = new THREE.Group();
  headGroup.position.y = 1.18;
  bodyGroup.add(headGroup);

  const face = new THREE.Mesh(new THREE.SphereGeometry(0.32, 18, 16), kit.mat(faceDark));
  face.scale.set(1, 1.06, 0.96);
  face.castShadow = true;
  headGroup.add(face);

  // 灵魂大眼睛（bloom 里会微微发光）
  const eyeMat = new THREE.MeshBasicMaterial({ color: "#fdf6e3" });
  const eyeGeo = new THREE.SphereGeometry(0.088, 10, 10);
  const eyes: THREE.Mesh[] = [];
  for (const dx of [-0.115, 0.115]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.scale.set(1, 1.5, 0.55);
    eye.position.set(dx, 0.02, 0.235);
    headGroup.add(eye);
    eyes.push(eye);
  }

  // 兜帽：罩住后脑与头顶的半球
  const hood = new THREE.Mesh(
    new THREE.SphereGeometry(0.345, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
    kit.mat("#ffffff", false)
  );
  (hood.material as THREE.MeshToonMaterial).color.copy(hoodColor);
  hood.position.y = 0.02;
  hood.rotation.x = -0.45; // 向后仰，露出脸
  headGroup.add(hood);

  // ---- 双层披风（顶点布料，底边裁成不规则扇形） ----
  const capeUni = {
    uTime: { value: 0 },
    uAmp: { value: 1 },
    uFlow: { value: 0 },
  };
  const shapeCape = (geo: THREE.PlaneGeometry, jag: number) => {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > -0.01) continue; // 只动底边
      const x = pos.getX(i);
      const k = (x / 0.41 + 0.5); // 0~1 沿宽度
      // 底缘高低起伏 + 内收，形成扇贝形下摆
      pos.setY(i, pos.getY(i) + jag * (0.22 * Math.abs(Math.sin(k * Math.PI * 2.7 + 0.4)) + 0.1 * Math.sin(k * 9.1)));
      pos.setX(i, x * 0.86);
    }
  };
  const outerGeo = new THREE.PlaneGeometry(0.82, 1.05, 6, 10);
  outerGeo.translate(0, -0.525, 0); // 顶端为固定轴
  shapeCape(outerGeo, 1);
  const outerCape = new THREE.Mesh(outerGeo, makeCapeMaterial(capeOuter, kit.gradient, capeUni));
  outerCape.position.set(0, 1.02, -0.17);
  outerCape.rotation.x = 0.12;
  outerCape.castShadow = true;
  bodyGroup.add(outerCape);

  const innerGeo = new THREE.PlaneGeometry(0.62, 0.72, 5, 8);
  innerGeo.translate(0, -0.36, 0);
  shapeCape(innerGeo, 0.7);
  const innerCape = new THREE.Mesh(innerGeo, makeCapeMaterial(capeInner, kit.gradient, capeUni));
  innerCape.position.set(0, 0.98, -0.12);
  innerCape.rotation.x = 0.1;
  bodyGroup.add(innerCape);

  // ---- 轮廓光（背壳法，淡淡的暖边） ----
  const rimMat = new THREE.MeshBasicMaterial({
    color: "#ffe4bb",
    side: THREE.BackSide,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const rimTorso = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 12), rimMat);
  rimTorso.scale.set(0.345, 0.405, 0.3);
  rimTorso.position.y = 0.62;
  const rimHead = new THREE.Mesh(new THREE.SphereGeometry(0.365, 14, 12), rimMat);
  rimHead.position.y = 1.18;
  bodyGroup.add(rimTorso, rimHead);

  // ---- 头顶小烛光 ----
  const wisp = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshBasicMaterial({ color: capeInner.clone().lerp(new THREE.Color("#fff2cf"), 0.55) })
  );
  wisp.position.y = 1.72;
  bodyGroup.add(wisp);

  // ---- 名牌 ----
  let nameTex = nameTexture(opts.name);
  const nameSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: nameTex, transparent: true, depthWrite: false, opacity: opts.self ? 0.75 : 0.95 })
  );
  nameSprite.scale.set(1.9, 0.53, 1);
  nameSprite.position.y = 2.35;
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
  let jumpBlend = 0;
  let glideBlend = 0;
  let squash = 0; // 落地缓冲
  let flapPulse = 0; // 扑翼脉冲

  return {
    group,
    land() {
      squash = 1;
    },
    flap() {
      flapPulse = 1;
    },
    animate(dt, t, speed, sit, air = 0, yawVel = 0) {
      const speedN = Math.min(1, speed / 7.2);
      sitLerp = THREE.MathUtils.lerp(sitLerp, sit ? 1 : 0, 1 - Math.pow(0.002, dt));
      walkPhase += dt * (3.2 + speed * 2.2);
      jumpBlend = THREE.MathUtils.lerp(jumpBlend, air === 1 ? 1 : 0, Math.min(1, dt * 6));
      glideBlend = THREE.MathUtils.lerp(glideBlend, air === 2 ? 1 : 0, Math.min(1, dt * 5));
      squash = Math.max(0, squash - dt * 4);
      flapPulse = Math.max(0, flapPulse - dt * 3.2);
      const airN = Math.max(jumpBlend, glideBlend);

      // 落地缓冲的压扁恢复
      const sq = 1 - squash * 0.16;
      bodyGroup.scale.set(1 + squash * 0.1, sq, 1 + squash * 0.1);

      // 坐下后仰 / 跑动前倾 / 滑翔大幅前倾
      bodyGroup.rotation.x =
        -1.05 * sitLerp + 0.14 * speedN + 0.62 * glideBlend + 0.18 * jumpBlend * (1 - glideBlend);
      // 转弯侧倾（压弯）
      group.rotation.z = THREE.MathUtils.clamp(-yawVel * 0.055, -0.3, 0.3) * (0.3 + speedN) * (1 - airN);

      bodyGroup.position.y =
        -0.38 * sitLerp +
        (speed > 0.2 ? Math.abs(Math.sin(walkPhase)) * 0.05 * (0.4 + speedN) : Math.sin(t * 1.5) * 0.012) -
        airN * 0.06;

      // 四肢：走路摆动 → 腾空收腿 → 滑翔张臂
      const swing = Math.sin(walkPhase) * (0.15 + speedN * 0.55);
      const armOut = 1.15 * glideBlend; // 张臂
      armL.rotation.x = swing * (1 - airN);
      armR.rotation.x = -swing * (1 - airN);
      armL.rotation.z = 0.18 + armOut - flapPulse * 0.5;
      armR.rotation.z = -0.18 - armOut + flapPulse * 0.5;
      legL.rotation.x = -swing * 0.9 * (1 - airN) + (0.45 * jumpBlend + 0.3 * glideBlend) - sitLerp * 1.2;
      legR.rotation.x = swing * 0.9 * (1 - airN) + (0.45 * jumpBlend + 0.3 * glideBlend) - sitLerp * 1.2;

      // 头部呼吸与轻微摆动（滑翔时抬头看前方）
      headGroup.rotation.z = Math.sin(t * 1.1 + opts.hue) * 0.035 * (1 - airN);
      headGroup.rotation.x = Math.sin(t * 0.9) * 0.02 + speedN * 0.1 - glideBlend * 0.45;

      // 披风：风感 + 速度拖尾 + 滑翔展开（加宽+向后上方扬起）+ 扑翼抖动
      capeUni.uTime.value = t;
      capeUni.uAmp.value = 0.35 + speedN * 1.1 + glideBlend * 0.8 + flapPulse * 1.6;
      capeUni.uFlow.value = THREE.MathUtils.lerp(
        capeUni.uFlow.value,
        Math.max(speedN * 1.0, glideBlend * 1.3) + flapPulse * 0.8,
        Math.min(1, dt * 6)
      );
      const flowRot = 0.1 + speedN * 0.5 + sitLerp * 0.75 - glideBlend * 0.42 - flapPulse * 0.3;
      outerCape.rotation.x = THREE.MathUtils.lerp(outerCape.rotation.x, flowRot, Math.min(1, dt * 8));
      innerCape.rotation.x = outerCape.rotation.x * 0.7;
      const spread = 1 + glideBlend * 0.22 + flapPulse * 0.12;
      outerCape.scale.x = THREE.MathUtils.lerp(outerCape.scale.x, spread, Math.min(1, dt * 7));
      innerCape.scale.x = outerCape.scale.x;

      // 眼睛：偶尔眨一下（scale.y 压扁）
      const blink = ((t * 0.6 + opts.hue * 0.13) % 4.7) < 0.14 ? 0.12 : 1;
      eyes.forEach((e) => e.scale.set(1, 1.5 * blink, 0.55));

      // 烛光呼吸
      wisp.scale.setScalar(0.85 + 0.18 * Math.sin(t * 2.4 + opts.hue));
      wisp.position.y = 1.72 - sitLerp * 0.35;

      // 光环脉动
      const pulse = 1 + 0.075 * Math.sin(t * 6.2) * ringEnergy;
      ring.scale.setScalar(pulse);
      disc.scale.setScalar(pulse);
      ring.position.y = 0.06 + airN * 0.9; // 腾空时光环随身
      disc.position.y = ring.position.y - 0.01;

      // 音符微光上升
      const arr = moteGeo.attributes.position.array as Float32Array;
      for (let i = 0; i < moteCount; i++) {
        motePh[i] += dt * 0.24;
        if (motePh[i] > 1) motePh[i] -= 1;
        const p = motePh[i];
        const a = (i / moteCount) * Math.PI * 2 + t * 0.4;
        arr[i * 3] = Math.cos(a) * (0.55 + p * 0.35);
        arr[i * 3 + 1] = ring.position.y + 0.1 + p * 1.7;
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
      eyeMat.dispose();
      rimMat.dispose();
      outerCape.material.dispose();
      innerCape.material.dispose();
    },
  };
}
