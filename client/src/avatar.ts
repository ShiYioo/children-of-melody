import * as THREE from "three";
import { createToonKit } from "./world/toon";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { CapeSim } from "./cape";

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

export type AvatarModel = "classic" | "hooded" | "minion" | "corgi" | "duck" | "platypus" | "seal" | "owl" | "elaina";

export interface Avatar {
  group: THREE.Group; // 挂在场景的根（原点在脚底）
  /** air: 0 地面 / 1 腾空 / 2 滑翔；state 提供速度分量（披风的风）与 vy（姿势分层） */
  animate: (dt: number, t: number, speed: number, sit: boolean, air?: number, yawVel?: number, state?: { vy?: number; vx?: number; vz?: number }) => void;
  /** 落地缓冲（着地瞬间调用） */
  land: () => void;
  /** 扑翼脉冲（腾空按跳时调用，披风向后上方一抖） */
  flap: () => void;
  setRing: (color: THREE.Color | null, energy: number) => void;
  setName: (name: string) => void;
  /** 头顶聊天气泡：显示一句话几秒后淡出（无聊天大厅，只活在头顶） */
  say: (text: string) => void;
  /** 牵手姿势：传入牵手对象的方向（世界系，传 null 取消），内侧手臂会抬向对方 */
  setHand: (dir: THREE.Vector3 | null) => void;
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

/**
 * 聊天气泡纹理：自动换行、最多 3 行（超长截断加省略号）、底部小尾巴指向头顶。
 * 返回纹理与建议的精灵尺寸（世界单位）。
 */
function bubbleTexture(text: string): { texture: THREE.CanvasTexture; w: number; h: number } {
  const cv = document.createElement("canvas");
  cv.width = 512;
  const ctx = cv.getContext("2d")!;
  const font = "500 33px 'HarmonyOS Sans SC', 'MiSans', 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.font = font;
  // 手动折行（measureText 对中英文混排都可靠），最多 3 行
  const maxW = 430;
  const lines: string[] = [];
  for (const seg of text.split("\n")) {
    let line = "";
    for (const ch of seg) {
      if (ctx.measureText(line + ch).width > maxW) {
        lines.push(line);
        line = ch;
        if (lines.length === 3) break;
      } else {
        line += ch;
      }
    }
    if (lines.length === 3) {
      if (line) lines[2] = (lines[2] + line).slice(0, -1) + "…";
      break;
    }
    lines.push(line);
  }
  const lineH = 44;
  const padX = 26;
  const padY = 20;
  const tail = 16;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), 60);
  cv.height = Math.ceil(padY * 2 + lines.length * lineH + tail);
  // 尺寸变了之后画布会重置，重新设字体
  const c2 = cv.getContext("2d")!;
  c2.font = font;
  c2.textAlign = "center";
  c2.textBaseline = "middle";
  const boxW = textW + padX * 2;
  c2.beginPath();
  c2.roundRect((512 - boxW) / 2, 4, boxW, cv.height - tail - 4, 22);
  c2.fillStyle = "rgba(255, 251, 241, 0.95)";
  c2.fill();
  c2.strokeStyle = "rgba(126, 104, 168, 0.4)";
  c2.lineWidth = 2.5;
  c2.stroke();
  // 小尾巴
  c2.beginPath();
  c2.moveTo(256 - 14, cv.height - tail - 2);
  c2.lineTo(256, cv.height - 2);
  c2.lineTo(256 + 14, cv.height - tail - 2);
  c2.closePath();
  c2.fillStyle = "rgba(255, 251, 241, 0.95)";
  c2.fill();
  c2.fillStyle = "rgba(42, 33, 64, 0.92)";
  lines.forEach((l, i) => c2.fillText(l, 256, 4 + padY + i * lineH + lineH / 2));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const w = Math.min(2.6, 0.9 + (textW / 512) * 2.6);
  return { texture: tex, w, h: w * (cv.height / 512) };
}

// 伊莱娜手写动作的复用临时量（避免每帧分配）
const _eq1 = new THREE.Quaternion();
const _eq2 = new THREE.Quaternion();
const _ev1 = new THREE.Vector3();
const _ev2 = new THREE.Vector3();
const _ev3 = new THREE.Vector3();

/** 披风材质：普通 toon 双面——形变与法线全部由 CapeSim 物理每帧驱动 */
function makeCapeMaterial(color: THREE.Color, gradientMap: THREE.DataTexture | null) {
  return new THREE.MeshToonMaterial({ color, side: THREE.DoubleSide, gradientMap: gradientMap ?? undefined });
}

export function createAvatar(opts: { name: string; hue: number; self?: boolean; model?: AvatarModel }): Avatar {
  const kit = createToonKit();
  const group = new THREE.Group();

  const bodyGroup = new THREE.Group();
  group.add(bodyGroup);

  const modelChoice = opts.model ?? "classic";
  const animalModels = new Set<AvatarModel>(["minion", "corgi", "duck", "platypus", "seal", "owl"]);
  // 单动画模型：整段展示动画循环播放（伊莱娜：灰之魔女的 13 秒动作）
  const singleAnimModels = new Set<AvatarModel>(["elaina"]);
  // 各 GLB 的地址与摆放（缩放/落地高度/朝向修正）——模型在建模软件里原点/尺寸不统一
  const glbOf: Partial<Record<AvatarModel, { url: string; scale: number; y: number; ry: number }>> = {
    minion: { url: "/models/minion-a01.glb", scale: 1, y: 0, ry: 0 },
    corgi: { url: "/models/corgi.glb", scale: 1, y: 0, ry: 0 },
    duck: { url: "/models/duck.glb", scale: 1, y: 0, ry: 0 },
    platypus: { url: "/models/platypus.glb", scale: 1, y: 0, ry: 0 },
    seal: { url: "/models/seal.glb", scale: 1, y: 0, ry: 0 },
    owl: { url: "/models/owl.glb", scale: 1, y: 0, ry: 0 },
    hooded: { url: "/models/rogue-hooded.glb", scale: 1, y: 0, ry: 0 },
    elaina: { url: "/models/elaina.glb", scale: 0.39, y: 0.57, ry: 0 }, // 模型原点=身体中心（载入时内部居中），脚底在中心下方 0.57
  };
  // 外部角色加载失败时继续使用下方程序化角色。
  let importedModel: THREE.Object3D | null = null;
  let importedMixer: THREE.AnimationMixer | null = null;
  const importedActions = new Map<string, THREE.AnimationAction>();
  let importedCurrent = "";
  let importedReady = false;
  const playImported = (name: string, loop: boolean, fade = 0.16) => {
    if (!importedReady || importedCurrent === name) return;
    const next = importedActions.get(name);
    if (!next) return;
    // 单动画模型的多个状态名指向同一个 action：只换名不重启
    if (importedActions.get(importedCurrent) === next) {
      importedCurrent = name;
      return;
    }
    importedActions.get(importedCurrent)?.fadeOut(fade);
    next.reset().fadeIn(fade);
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    next.play();
    importedCurrent = name;
  };
  if (modelChoice !== "classic") {
    const glb = glbOf[modelChoice] ?? glbOf.hooded!;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder); // elaina.glb 用 meshopt 无损压缩
    loader.load(
    glb.url,
    (gltf) => {
      importedModel = SkeletonUtils.clone(gltf.scene);
      importedModel.scale.setScalar(glb.scale);
      importedModel.position.y = glb.y;
      importedModel.rotation.y = glb.ry;
      importedModel.traverse((obj) => {
        obj.castShadow = true;
        obj.receiveShadow = true;
        if (obj.name.toLowerCase().includes("cape")) {
          const material = (obj as THREE.Mesh).material;
          for (const mat of Array.isArray(material) ? material : [material]) {
            if (mat && "color" in mat) (mat as THREE.MeshStandardMaterial).color.setHSL(opts.hue / 360, 0.42, 0.52);
          }
        }
      });
      group.add(importedModel);
      bodyGroup.visible = false;
      // GLB 模型用自己的外观（hooded 自带披风、动物有毛皮尾巴），不挂程序化布料
      if (outerCapeSim) outerCapeSim.mesh.visible = false;
      if (innerCape) innerCape.visible = false;
      importedMixer = new THREE.AnimationMixer(importedModel);
      let clips: THREE.AnimationClip[];
      if (singleAnimModels.has(modelChoice)) {
        // 伊莱娜：整段循环播放她自己的展示动画（原生骨架动作，姿态绝对正确）。
        // 走/跑/飞/躺不借外部动画库——两副骨架差异太大，重定向会把人折成一团；
        // 改用程序化根运动叠加（见 animate 中的 elainaRoot 分支）
        elainaRoot = importedModel;
        elainaBaseY = glb.y;
        // 抓取手写动作需要的骨骼（名字在运行时没有点号：thigh.l → thighl）+ 各自绑定姿态
        const grab = (p: string) => {
          let hit: THREE.Bone | null = null;
          importedModel!.traverse((o) => {
            if (!hit && (o as THREE.Bone).isBone && o.name.startsWith(p)) hit = o as THREE.Bone;
          });
          return hit;
        };
        elainaBones = {
          thighL: grab("thighl"), thighR: grab("thighr"),
          shinL: grab("legl"), shinR: grab("legr"),
          armL: grab("arml"), armR: grab("armr"),
          foreL: grab("forearml"), foreR: grab("forearmr"),
        };
        elainaBind = new Map();
        for (const b of Object.values(elainaBones)) if (b) elainaBind.set(b, b.quaternion.clone());
        const clip = gltf.animations[0];
        if (clip) {
          // 只循环展示动画的抬头段（9.5~12.5s 实测头部水平、站姿安稳；
          // 前段她一直低头，整段循环会显得总是垂着头）
          const loop = THREE.AnimationUtils.subclip(clip, "Action", Math.round(9.5 * 30), Math.round(12.5 * 30), 30);
          const action = importedMixer.clipAction(loop.duration > 0.2 ? loop : clip);
          // GLB 文件本身没居中（静态包围盒中心在 z≈3.12 模型单位 ≈ 1.22 米，
          // 全部来自场景级 Pivot 节点的静态位移——名牌偏移的根因）。
          // 把每个直接子节点平移 −包围盒中心（模型局部单位），让身体中心落在模型原点上：
          // 旋转（躺/滑翔俯仰）的轴心从此在身体中心而不是脚下方 1.2 米外。
          // ⚠ 必须先把模型摘出场景再量：挂在组上时组的「世界」变换（玩家当前位置/朝向，
          // 可见页每帧渲染后非恒等）会乘进 matrixWorld，盒子中心被污染成
          // 绑定中心+玩家坐标——每次加载偏移都不同。隐藏页 rAF 冻结时恰好恒等，
          // 这就是自动化测试全对、真机必错的原因
          const parent = importedModel.parent;
          const keepPos = importedModel.position.clone();
          const keepRot = importedModel.rotation.clone();
          parent?.remove(importedModel);
          importedModel.position.set(0, 0, 0);
          importedModel.rotation.set(0, 0, 0);
          importedModel.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(importedModel);
          const bc = box.getCenter(new THREE.Vector3()).divideScalar(glb.scale);
          importedModel.position.copy(keepPos);
          importedModel.rotation.copy(keepRot);
          parent?.add(importedModel);
          for (const child of importedModel.children) {
            child.position.x -= bc.x;
            child.position.y -= bc.y;
            child.position.z -= bc.z;
          }
          importedActions.set("Action", action);
          importedActions.set("Unarmed_Idle", action);
        }
        clips = [];
      } else if (animalModels.has(modelChoice) && gltf.animations[0]) {
        clips = [
          THREE.AnimationUtils.subclip(gltf.animations[0], "idle", 0, 30, 24),
          ...(modelChoice !== "minion" ? [THREE.AnimationUtils.subclip(gltf.animations[0], "walk", 90, 120, 24)] : []),
        ];
      } else {
        clips = gltf.animations;
      }
      for (const clip of clips) importedActions.set(clip.name, importedMixer.clipAction(clip));
      importedReady = true;
      playImported(animalModels.has(modelChoice) ? "idle" : "Unarmed_Idle", true);
    },
    undefined,
    () => {
      importedModel = null; // 加载失败：回退程序化角色（披风恢复可见）
      if (outerCapeSim) outerCapeSim.mesh.visible = true;
      if (innerCape) innerCape.visible = true;
    }
  );
  }

  // ---- 配色 ----
  const capeOuter = new THREE.Color().setHSL(opts.hue / 360, 0.46, 0.56);
  const capeInner = capeOuter.clone().offsetHSL(0, 0.02, 0.12);
  const hoodColor = capeOuter.clone().offsetHSL(0, 0, -0.06);
  const skin = "#f6ecd8"; // 奶白
  const skinDark = "#e6d5ba";
  const faceDark = "#2e2745"; // 面具脸

  // ---- 腿（两段：大腿+小腿+脚，膝盖能弯） ----
  interface Limb2 {
    root: THREE.Group; // 髋/肩
    joint: THREE.Group; // 膝/肘
  }
  const thighGeo = new THREE.CapsuleGeometry(0.08, 0.13, 4, 8);
  const shinGeo = new THREE.CapsuleGeometry(0.062, 0.11, 4, 8);
  const footGeo = new THREE.SphereGeometry(0.075, 8, 6);
  const makeLeg = (side: number): Limb2 => {
    const root = new THREE.Group();
    root.position.set(0.11 * side, 0.46, 0);
    const thigh = new THREE.Mesh(thighGeo, kit.mat(skinDark));
    thigh.position.y = -0.09;
    root.add(thigh);
    const joint = new THREE.Group();
    joint.position.y = -0.19;
    root.add(joint);
    const shin = new THREE.Mesh(shinGeo, kit.mat(skinDark));
    shin.position.y = -0.075;
    joint.add(shin);
    const foot = new THREE.Mesh(footGeo, kit.mat(skinDark));
    foot.position.set(0, -0.15, 0.03);
    joint.add(foot);
    thigh.castShadow = shin.castShadow = true;
    bodyGroup.add(root);
    return { root, joint };
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // ---- 身体 ----
  const torso = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 14), kit.mat(skin));
  torso.scale.set(0.3, 0.36, 0.26);
  torso.position.y = 0.62;
  torso.castShadow = true;
  bodyGroup.add(torso);

  // ---- 手臂（两段：大臂+小臂+手，手肘微弯） ----
  const upperArmGeo = new THREE.CapsuleGeometry(0.05, 0.12, 4, 8);
  const foreArmGeo = new THREE.CapsuleGeometry(0.042, 0.1, 4, 8);
  const handGeo = new THREE.SphereGeometry(0.052, 8, 6);
  const makeArm = (side: number): Limb2 => {
    const root = new THREE.Group();
    root.position.set(0.30 * side, 0.82, 0);
    root.rotation.z = -0.16 * side; // 微微外张
    const upper = new THREE.Mesh(upperArmGeo, kit.mat(skinDark));
    upper.position.y = -0.075;
    root.add(upper);
    const joint = new THREE.Group();
    joint.position.y = -0.155;
    root.add(joint);
    const fore = new THREE.Mesh(foreArmGeo, kit.mat(skinDark));
    fore.position.y = -0.06;
    joint.add(fore);
    const hand = new THREE.Mesh(handGeo, kit.mat(skin));
    hand.position.y = -0.125;
    joint.add(hand);
    upper.castShadow = true;
    bodyGroup.add(root);
    return { root, joint };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

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

  // 两点软软的腮红，让远处的小人也有一点表情
  const cheekMat = new THREE.MeshBasicMaterial({
    color: "#ff9caa",
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
  });
  const cheekGeo = new THREE.SphereGeometry(0.055, 10, 8);
  for (const dx of [-0.22, 0.22]) {
    const cheek = new THREE.Mesh(cheekGeo, cheekMat);
    cheek.scale.set(1.25, 0.62, 0.3);
    cheek.position.set(dx, -0.105, 0.245);
    headGroup.add(cheek);
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

  // ---- 双层披风（Verlet 布料物理，底边裁成不规则扇形） ----
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
  const outerGeo = new THREE.PlaneGeometry(0.82, 0.9, 12, 16);
  outerGeo.translate(0, -0.45, 0); // 顶端为固定轴
  shapeCape(outerGeo, 1);
  // 参数柔和：重力小、风缓、阻尼收敛快——站立时垂坠安静，跑动时才后扬
  const outerCapeSim = new CapeSim(outerGeo, makeCapeMaterial(capeOuter, kit.gradient), { gravity: 6, damping: 0.94, iters: 5 });
  const outerCape = outerCapeSim.mesh;
  // 注意：mesh 不带偏移——CapeSim 的顶点/锚点/碰撞都在 group 坐标系里表达
  group.add(outerCape);

  // 内层：静态贴身后襟（层次感来自颜色差，不与外层布互穿）
  const innerGeo = new THREE.PlaneGeometry(0.56, 0.42, 6, 6);
  innerGeo.translate(0, -0.21, 0);
  innerGeo.rotateX(0.14);
  const innerCape = new THREE.Mesh(innerGeo, makeCapeMaterial(capeInner, kit.gradient));
  innerCape.position.set(0, 0.98, -0.12);
  innerCape.castShadow = true;
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
  let riseBlend = 0; // 腾空上升（vy>0）
  let fallBlend = 0; // 腾空下落（vy<0，准备落地）
  let squash = 0; // 落地缓冲
  let flapPulse = 0; // 扑翼脉冲
  let accelSm = 0; // 平滑加速度（起跑前倾/急停后仰）
  let lastSpeed = 0;
  let prevAir = 0;
  let handBlend = 0; // 牵手姿势混合 0-1
  let handSide = 1; // 对方在哪一侧（+1 右 / -1 左）
  let handFwd = 0; // 对方在前方分量（抬臂前后倾角）
  const handDirWorld = new THREE.Vector3();

  // 布料仿真的复用临时量（避免每帧分配）
  const windWorld = new THREE.Vector3();
  const shoulderLocal = new THREE.Vector3();
  const anchorEuler = new THREE.Euler();
  const UP_AXIS = new THREE.Vector3(0, 1, 0);
  const outerPins = new Float32Array(13 * 3); // cols=12+1 冗余一位无妨，step 按 sim.cols 读
  const innerPins = new Float32Array(11 * 3);
  let wingPose: Float32Array | null = null; // 滑翔翼形目标姿态（懒分配）
  // 伊莱娜的程序化状态运动（展示动画常播，状态靠根节点运动表达）
  let elainaRoot: THREE.Object3D | null = null;
  let elainaBaseY = 0;
  // 手写骨骼动作：关键骨骼与绑定姿态（运行时在 her 骨架上做世界轴旋转叠加）
  let elainaBones: { thighL: THREE.Bone | null; thighR: THREE.Bone | null; shinL: THREE.Bone | null; shinR: THREE.Bone | null; armL: THREE.Bone | null; armR: THREE.Bone | null; foreL: THREE.Bone | null; foreR: THREE.Bone | null } | null = null;
  let elainaBind = new Map<THREE.Bone, THREE.Quaternion>();

  // ---- 聊天气泡（光遇式：只飘在头顶，无大厅无历史） ----
  let bubbleSprite: THREE.Sprite | null = null;
  let bubbleUntil = 0;
  const say = (text: string) => {
    if (!bubbleSprite) {
      bubbleSprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
      group.add(bubbleSprite);
    }
    const { texture, w, h } = bubbleTexture(text);
    bubbleSprite.material.map?.dispose();
    bubbleSprite.material.map = texture;
    bubbleSprite.material.needsUpdate = true;
    bubbleSprite.material.opacity = 1;
    bubbleSprite.visible = true;
    bubbleSprite.scale.set(w, h, 1);
    bubbleUntil = performance.now() + 6000;
  };

  return {
    group,
    say,
    land() {
      squash = 1;
      playImported("Jump_Land", false, 0.08);
    },
    flap() {
      flapPulse = 1;
      playImported("Jump_Start", false, 0.08);
    },
    animate(dt, t, speed, sit, air = 0, yawVel = 0, state = {}) {
      importedMixer?.update(dt);
      if (importedReady) {
        if (animalModels.has(modelChoice)) playImported(speed > 0.2 && modelChoice !== "minion" ? "walk" : "idle", true);
        else if (sit) playImported(singleAnimModels.has(modelChoice) ? "Lie_Idle" : "Sit_Floor_Idle", true);
        else if (air === 2) playImported("Jump_Idle", true);
        else if (air === 1) playImported("Jump_Start", false);
        else if (speed > 4.6) playImported("Running_A", true);
        else if (speed > 0.2) playImported("Walking_A", true);
        else playImported("Unarmed_Idle", true);
      }
      const speedN = Math.min(1, speed / 7.2);
      const vy = state.vy ?? 0;
      sitLerp = THREE.MathUtils.lerp(sitLerp, sit ? 1 : 0, 1 - Math.pow(0.002, dt));
      walkPhase += dt * (3.0 + speed * 2.4);
      jumpBlend = THREE.MathUtils.lerp(jumpBlend, air > 0 ? 1 : 0, Math.min(1, dt * 6));
      glideBlend = THREE.MathUtils.lerp(glideBlend, air === 2 ? 1 : 0, Math.min(1, dt * 5));
      riseBlend = THREE.MathUtils.lerp(riseBlend, air > 0 && vy > 0.8 ? 1 : 0, Math.min(1, dt * 5));
      fallBlend = THREE.MathUtils.lerp(fallBlend, air > 0 && vy < -0.8 ? 1 : 0, Math.min(1, dt * 5));
      squash = Math.max(0, squash - dt * 4);
      flapPulse = Math.max(0, flapPulse - dt * 3.2);
      // 牵手姿势混合 & 方向（世界 → 本地）
      const handTarget = handDirWorld.lengthSq() > 1e-6 ? 1 : 0;
      handBlend = THREE.MathUtils.lerp(handBlend, handTarget, Math.min(1, dt * 8));
      if (handTarget) {
        const lx = handDirWorld.x * Math.cos(-group.rotation.y) - handDirWorld.z * Math.sin(-group.rotation.y);
        const lz = handDirWorld.x * Math.sin(-group.rotation.y) + handDirWorld.z * Math.cos(-group.rotation.y);
        const h = Math.hypot(lx, lz) || 1e-6;
        handSide = lx >= 0 ? 1 : -1;
        handFwd = THREE.MathUtils.clamp(-lz / h, -1, 1);
      }
      // 起跳蹬地：腾空第一帧快速屈膝蓄力
      if (air > 0 && prevAir === 0) squash = Math.max(squash, 0.55);
      prevAir = air;
      const airN = Math.max(jumpBlend, glideBlend);
      const ground = 1 - airN;

      // 平滑加速度 → 前倾角（起跑前倾、急停后仰，光遇的重量感）
      const accelRaw = (speed - lastSpeed) / Math.max(dt, 1e-3);
      lastSpeed = speed;
      accelSm = THREE.MathUtils.lerp(accelSm, THREE.MathUtils.clamp(accelRaw, -12, 12), Math.min(1, dt * 5));
      const leanAcc = THREE.MathUtils.clamp(accelSm * 0.014, -0.16, 0.2);

      // 落地缓冲的压扁恢复
      const sq = 1 - squash * 0.16;
      bodyGroup.scale.set(1 + squash * 0.1, sq, 1 + squash * 0.1);

      // 躯干：盘坐后靠 / 跑动前倾+加速度 / 滑翔大幅前倾
      bodyGroup.rotation.x =
        -0.5 * sitLerp +
        (0.1 * speedN + leanAcc) * (1 - sitLerp) * ground +
        0.92 * glideBlend +
        0.15 * jumpBlend * (1 - glideBlend);
      // 压弯（整体侧倾）
      group.rotation.z = THREE.MathUtils.clamp(-yawVel * 0.055, -0.3, 0.3) * (0.3 + speedN) * ground;
      // 重心左右晃（跳跳步的步感）
      bodyGroup.rotation.z = (speed > 0.2 ? Math.sin(walkPhase) * (0.028 + 0.03 * speedN) : 0) * ground * (1 - sitLerp);

      bodyGroup.position.y =
        -0.3 * sitLerp +
        (speed > 0.2 ? Math.abs(Math.sin(walkPhase)) * 0.055 * (0.45 + speedN) : Math.sin(t * 1.4) * 0.012) -
        airN * 0.06;

      // ---- 四肢（两段关节：步态 → 空中分层 → 盘坐） ----
      // 步态：大腿摆动、小腿在恢复期屈膝（相位差 ~1.15rad），手臂与同侧腿反相
      const walkAmp = (speed > 0.2 ? 0.35 + speedN * 0.65 : 0) * ground * (1 - sitLerp);
      const strideL = Math.sin(walkPhase);
      const strideR = Math.sin(walkPhase + Math.PI);
      const kneeBase = 0.5 + speedN * 0.6;
      const kneeL = Math.max(0, Math.sin(walkPhase - 1.15)) * kneeBase;
      const kneeR = Math.max(0, Math.sin(walkPhase + Math.PI - 1.15)) * kneeBase;

      // 腿：walk 摆 + rise 伸展 + fall 前抬收膝 + glide 并拢后掠（与躯干轴对齐） + sit 盘腿
      legL.root.rotation.x =
        strideL * 0.55 * walkAmp - 0.15 * riseBlend - 0.55 * fallBlend + 1.05 * glideBlend - 1.45 * sitLerp;
      legL.joint.rotation.x =
        kneeL * 1.6 * walkAmp + 0.15 * riseBlend + 0.95 * fallBlend - 0.05 * glideBlend + 1.45 * sitLerp;
      legR.root.rotation.x =
        strideR * 0.55 * walkAmp - 0.15 * riseBlend - 0.55 * fallBlend + 1.05 * glideBlend - 1.45 * sitLerp;
      legR.joint.rotation.x =
        kneeR * 1.6 * walkAmp + 0.15 * riseBlend + 0.95 * fallBlend - 0.05 * glideBlend + 1.45 * sitLerp;

      // 臂：walk 反相摆 + rise 后上摆 + fall 侧举 + glide 向前上方伸出（从翼面前缘探出，不被布盖住） + sit 放前
      const armSwL = -strideL;
      const armSwR = -strideR;
      armL.root.rotation.x =
        armSwL * (0.18 + speedN * 0.5) * walkAmp * 2 - 0.6 * riseBlend - 0.25 * fallBlend + 0.28 * glideBlend - 0.5 * sitLerp;
      armR.root.rotation.x =
        armSwR * (0.18 + speedN * 0.5) * walkAmp * 2 - 0.6 * riseBlend - 0.25 * fallBlend + 0.28 * glideBlend - 0.5 * sitLerp;
      armL.root.rotation.z = 0.16 + 1.45 * glideBlend + 0.8 * fallBlend - flapPulse * 0.45 + armSwL * 0.08 * walkAmp;
      armR.root.rotation.z = -0.16 - 1.45 * glideBlend - 0.8 * fallBlend + flapPulse * 0.45 + armSwR * 0.08 * walkAmp;
      // 肘：跑步更弯、滑翔前伸、其余自然微弯
      const elbow = -(0.3 + (0.35 + speedN * 0.55) * walkAmp + 0.25 * riseBlend + 0.5 * glideBlend + 0.15 * fallBlend) * (1 - sitLerp) - 0.35 * sitLerp;
      armL.joint.rotation.x = elbow;
      armR.joint.rotation.x = elbow;

      // 牵手：内侧手臂抬向对方（走/飞时保持，光遇式牵着走）
      if (handBlend > 0.005) {
        const raise = handBlend * (1 - 0.55 * glideBlend); // 滑翔时手臂已被翼形占据，只微微示意
        if (handSide > 0) {
          armR.root.rotation.z -= raise * 1.05;
          armR.root.rotation.x += handFwd * raise * 0.5;
          armL.root.rotation.z += raise * 0.18;
        } else {
          armL.root.rotation.z += raise * 1.05;
          armL.root.rotation.x += handFwd * raise * 0.5;
          armR.root.rotation.z -= raise * 0.18;
        }
      }

      // 头：待机慢张望（光遇小人会东看看西看看）+ 滑翔抬头看前方
      headGroup.rotation.y = (1 - speedN) * ground * (1 - sitLerp) * Math.sin(t * 0.33 + opts.hue) * 0.26;
      headGroup.rotation.z = Math.sin(t * 1.1 + opts.hue) * 0.035 * ground;
      headGroup.rotation.x = Math.sin(t * 0.9) * 0.02 + speedN * 0.1 - glideBlend * 0.7;

      // 滑翔时名牌随肩线下压并前移：身体前倾后固定高度的名牌会飘在半空，远看像和角色脱开
      if (elainaRoot) {
        // 伊莱娜实际身高 ~1.14（含帽），名牌跟到 1.5；躺平时身体贴地，名牌也要落下来
        const tagY = 1.5 - glideBlend * 0.35 - (sit ? 0.85 : 0);
        nameSprite.position.y = THREE.MathUtils.lerp(nameSprite.position.y, tagY, Math.min(1, dt * 5));
      } else {
        nameSprite.position.y = 2.35 - glideBlend * 0.6;
      }
      nameSprite.position.z = glideBlend * 0.3;

      // 聊天气泡：跟在名牌上方（滑翔/躺平时随名牌一起降），到点淡出
      if (bubbleSprite?.visible) {
        const left = bubbleUntil - performance.now();
        if (left <= 0) {
          bubbleSprite.visible = false;
        } else {
          bubbleSprite.material.opacity = Math.min(1, left / 600);
          bubbleSprite.position.set(nameSprite.position.x, nameSprite.position.y + nameSprite.scale.y * 0.55 + bubbleSprite.scale.y * 0.5, nameSprite.position.z);
        }
      }

      // 披风：Verlet 布料物理（GLB 模型用自己的外观，跳过程序化布料）
        if (!importedReady) {
          const vx = state.vx ?? 0;
          const vz = state.vz ?? 0;
          // 滑翔时相对风衰减：大风会把布绕锚甩过头顶(链球效应)，轻风+托力才有安稳的翼形
          const wf = 1 - glideBlend * 0.55;
          windWorld.set(
            (-vx * 0.55 + Math.sin(t * 0.7) * 0.35) * wf,
            // 上升时布向下拖曳(物理正确)；下落的上掀风减半，防止把布掀过头顶
            -vy * (vy > 0 ? 0.55 : 0.28) + glideBlend * 1.1 - flapPulse * 2,
            // 滑翔成形交给翼形姿态混合（见下），这里只保留轻微气流参与残余抖动
            (-vz * 0.55 + Math.cos(t * 0.5) * 0.25) * wf - glideBlend * 0.7 - flapPulse * 2.5
          );
        windWorld.applyAxisAngle(UP_AXIS, -group.rotation.y); // 世界风 → 角色局部
        // 肩锚点行：钉点跟随身体的完整旋转（含滑翔前倾）。
        // 前倾时真实肩膀在 (y0.75, z+0.71)，若锚点不跟旋转会悬在直立肩位，翼与身体脱开 1 米
        for (let j = 0; j < outerCapeSim.cols; j++) {
          const k = j / (outerCapeSim.cols - 1) - 0.5;
          anchorEuler.set(bodyGroup.rotation.x, bodyGroup.rotation.y, bodyGroup.rotation.z);
          shoulderLocal
            .set(k * 0.82, 1.02, -0.17 - 0.05 * Math.abs(k) * 2)
            .applyEuler(anchorEuler)
            .add(bodyGroup.position);
          outerPins[j * 3] = shoulderLocal.x;
          outerPins[j * 3 + 1] = shoulderLocal.y;
          outerPins[j * 3 + 2] = shoulderLocal.z;
        }
        // 滑翔翼形：光遇滑翔时披风张开成翼。纯靠风吹只会把布拉成拖在身后的布条
        // （远看就像披风和人物分离），所以这里直接给出目标姿态，与物理位形混合输出：
        // 前缘钉在肩线，后缘绕肩线向后上方扫开并展宽，附飞行涟漪；物理只保留少量抖动。
        let pose: Float32Array | null = null;
        if (glideBlend > 0.02) {
          if (!wingPose) wingPose = new Float32Array(outerCapeSim.cols * outerCapeSim.rows * 3);
          pose = wingPose;
          const cols = outerCapeSim.cols;
          const rows = outerCapeSim.rows;
          for (let i = 0; i < rows; i++) {
            const tc = i / (rows - 1); // 0=前缘(肩) 1=后缘
            // 展翼角：翼面基本贴着肩线向后展开，后缘仅微微上扬（12°~20°）。
            // 后缘扫太高会变成「悬在头顶的伞」，从背后看像与肩部分离
            const phi = 1.35 + 0.35 * tc;
            const chord = 0.9 * tc;
            const camber = Math.sin(Math.PI * tc) * 0.12; // 翼面中段鼓成弧（翼型弯度）
            for (let j = 0; j < cols; j++) {
              const k = j / (cols - 1) - 0.5;
              const o = (i * cols + j) * 3;
              const flutter = Math.sin(t * 3.1 + tc * 6.5 + j * 0.5);
              const flutter2 = Math.cos(t * 2.7 + tc * 5.5 + j * 0.45);
              const tip = 4 * k * k; // 0=翼根 1=翼尖
              wingPose[o] = outerPins[j * 3] * (1 + 1.35 * tc); // 翼展从肩宽张到 ~2.3 倍
              wingPose[o + 1] =
                outerPins[j * 3 + 1] -
                Math.cos(phi) * chord +
                tip * 0.3 * (0.3 + 0.7 * tc) + // 翼尖轻微上反角（V 形）
                flutter * 0.07 * (0.3 + 0.7 * tc);
              wingPose[o + 2] =
                outerPins[j * 3 + 2] -
                Math.sin(phi) * chord * (1 - tip * 0.22) - // 翼尖略回收，形成后掠
                camber +
                flutter2 * 0.06 * (0.3 + 0.7 * tc);
            }
          }
        }
        outerCapeSim.step(dt, outerPins, windWorld, pose, glideBlend * 0.9);
      }

      // 伊莱娜：展示动画（抬头段循环）做基底，状态用手写骨骼动作 + 根运动表达
      if (elainaRoot) {
        const kk = Math.min(1, dt * 6);
        let pitch = 0.08 * speedN + THREE.MathUtils.clamp(accelSm * 0.012, -0.12, 0.2); // 跑动前倾
        let lift = 0;
        if (sit) {
          pitch = -Math.PI / 2; // 绕身体中心向后放平
          lift = -0.44; // 轴心已居中：把中心压到离地 ~0.13（背部厚度的一半）
        } else if (air === 2) {
          pitch = 0.85; // 滑翔俯冲角，与程序化小人一致
          lift = -0.05;
        } else if (air === 1) {
          pitch = -0.05; // 腾空微后仰
        }
        elainaRoot.rotation.x = THREE.MathUtils.lerp(elainaRoot.rotation.x, pitch, kk);
        elainaRoot.rotation.z = THREE.MathUtils.lerp(elainaRoot.rotation.z, Math.sin(walkPhase) * 0.05 * speedN, kk);
        const bounce = air > 0 || sit ? 0 : Math.abs(Math.sin(walkPhase)) * (0.035 + 0.05 * speedN); // 步伐弹跳
        // bounce 必须放在 lerp 目标里：加在外面会每帧累积，稳态抬高 bounce/kk（kk≈0.1 时放大十倍）
        elainaRoot.position.y = THREE.MathUtils.lerp(elainaRoot.position.y, elainaBaseY + lift + bounce, kk);

        // ---- 手写肢体动作：在她的骨骼上做世界轴旋转（绑定姿态 × 增量） ----
        if (elainaBones) {
          const yaw = group.rotation.y;
          _ev1.set(Math.cos(yaw), 0, -Math.sin(yaw)); // 角色右向（世界）
          _ev2.set(Math.sin(yaw), 0, Math.cos(yaw)); // 角色前向（世界）
          const swing = (bone: THREE.Bone | null, axis: THREE.Vector3, ang: number) => {
            const bind = bone ? elainaBind.get(bone) : undefined;
            if (!bone || !bind || !bone.parent) return;
            bone.parent.getWorldQuaternion(_eq1).invert();
            _ev3.copy(axis).applyQuaternion(_eq1).normalize();
            _eq2.setFromAxisAngle(_ev3, ang);
            bone.quaternion.copy(bind).multiply(_eq2);
          };
          if (sit) {
            // 躺平：双臂微微张开
            swing(elainaBones.armL, _ev2, 0.35);
            swing(elainaBones.armR, _ev2, -0.35);
          } else if (air === 2) {
            // 滑翔：双臂向侧上方展开，双腿并拢微后掠
            swing(elainaBones.armL, _ev2, 1.25);
            swing(elainaBones.armR, _ev2, -1.25);
            swing(elainaBones.thighL, _ev1, -0.12);
            swing(elainaBones.thighR, _ev1, -0.12);
          } else if (speed > 0.3 && air === 0) {
            // 走/跑：迈步 + 摆臂（与程序化小人同一套相位）
            const run = THREE.MathUtils.clamp((speed - 4.2) / 3.5, 0, 1);
            const amp = 0.38 + run * 0.42;
            const s = Math.sin(walkPhase);
            const s2 = Math.sin(walkPhase + Math.PI);
            swing(elainaBones.thighL, _ev1, s * amp);
            swing(elainaBones.thighR, _ev1, s2 * amp);
            // 膝盖：腿后摆时收紧
            swing(elainaBones.shinL, _ev1, Math.max(0, -s) * (0.5 + run * 0.7));
            swing(elainaBones.shinR, _ev1, Math.max(0, -s2) * (0.5 + run * 0.7));
            swing(elainaBones.armL, _ev1, s2 * amp * 0.65);
            swing(elainaBones.armR, _ev1, s * amp * 0.65);
            swing(elainaBones.foreL, _ev1, 0.25 + Math.max(0, s2) * 0.3);
            swing(elainaBones.foreR, _ev1, 0.25 + Math.max(0, s) * 0.3);
          }
          // 待机：不碰四肢，展示动画的抬头段自然摆
        }
      }

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
    setHand(dir) {
      if (dir && dir.lengthSq() > 1e-6) handDirWorld.copy(dir).normalize();
      else handDirWorld.set(0, 0, 0);
    },
    setName(name) {
      nameSprite.material.map?.dispose();
      nameTex = nameTexture(name);
      nameSprite.material.map = nameTex;
      nameSprite.material.needsUpdate = true;
    },
    dispose() {
      kit.dispose();
      importedMixer?.stopAllAction();
      importedModel?.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        for (const mat of Array.isArray(material) ? material : [material]) mat?.dispose?.();
      });
      nameTex.dispose();
      bubbleSprite?.material.map?.dispose();
      bubbleSprite?.material.dispose();
      ringMat.dispose();
      discMat.dispose();
      moteMat.dispose();
      eyeMat.dispose();
      rimMat.dispose();
      outerCape.geometry.dispose();
      innerCape.geometry.dispose();
      for (const m of [outerCape.material, innerCape.material]) {
        for (const mat of Array.isArray(m) ? m : [m]) (mat as THREE.Material).dispose();
      }
    },
  };
}
