import * as THREE from "three";
import { createToonKit } from "./world/toon";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { CapeSim } from "./cape";
import { Spring } from "./motion";
import { terrainHeight } from "./heightfield";
import { lightState } from "./world/lightstate";

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
  /** air: 0 地面 / 1 腾空 / 2 滑翔；state 提供速度分量（披风的风）、vy（姿势分层）与 seated（坐家具） */
  animate: (dt: number, t: number, speed: number, sit: boolean, air?: number, yawVel?: number, state?: { vy?: number; vx?: number; vz?: number; seated?: boolean }) => void;
  /** 落地缓冲（着地瞬间调用） */
  land: () => void;
  /** 扑翼脉冲（腾空按跳时调用，披风向后上方一抖） */
  flap: () => void;
  setRing: (color: THREE.Color | null, energy: number) => void;
  setName: (name: string) => void;
  /** 头顶聊天气泡：显示一句话几秒后淡出（无聊天大厅，只活在头顶） */
  say: (text: string) => void;
  /** 动作轮盘表情：招手/鞠躬/点头/伸懒腰/欢呼/比心（1~2 秒程序化时间线） */
  playEmote: (name: string) => void;
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
  const font = "500 40px 'HarmonyOS Sans SC', 'MiSans', 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.font = font;
  // 手动折行（measureText 对中英文混排都可靠），最多 4 行（放大字号后行数多一点少截断）
  const maxW = 436;
  const lines: string[] = [];
  for (const seg of text.split("\n")) {
    let line = "";
    for (const ch of seg) {
      if (ctx.measureText(line + ch).width > maxW) {
        lines.push(line);
        line = ch;
        if (lines.length === 4) break;
      } else {
        line += ch;
      }
    }
    if (lines.length === 4) {
      if (line) lines[3] = (lines[3] + line).slice(0, -1) + "…";
      break;
    }
    lines.push(line);
  }
  const lineH = 54;
  const padX = 30;
  const padY = 24;
  const tail = 18;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), 60);
  cv.height = Math.ceil(padY * 2 + lines.length * lineH + tail);
  // 尺寸变了之后画布会重置，重新设字体
  const c2 = cv.getContext("2d")!;
  c2.font = font;
  c2.textAlign = "center";
  c2.textBaseline = "middle";
  const boxW = textW + padX * 2;
  c2.beginPath();
  c2.roundRect((512 - boxW) / 2, 4, boxW, cv.height - tail - 4, 26);
  // 深色半透明底：和名牌同一套 UI 语言；场景有 UnrealBloom（阈值 0.72），
  // 浅色气泡会超过阈值被泛光点亮，像自带光源一样刺眼
  c2.fillStyle = "rgba(26, 18, 42, 0.88)";
  c2.fill();
  c2.strokeStyle = "rgba(255, 236, 200, 0.32)";
  c2.lineWidth = 2.5;
  c2.stroke();
  // 小尾巴
  c2.beginPath();
  c2.moveTo(256 - 14, cv.height - tail - 2);
  c2.lineTo(256, cv.height - 2);
  c2.lineTo(256 + 14, cv.height - tail - 2);
  c2.closePath();
  c2.fillStyle = "rgba(26, 18, 42, 0.88)";
  c2.fill();
  c2.fillStyle = "rgba(255, 244, 222, 0.96)";
  lines.forEach((l, i) => c2.fillText(l, 256, 4 + padY + i * lineH + lineH / 2));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const w = Math.min(3.6, 1.35 + (textW / 512) * 3.4);
  return { texture: tex, w, h: w * (cv.height / 512) };
}

// 伊莱娜手写动作的复用临时量（避免每帧分配）
const _eq1 = new THREE.Quaternion();
const _eq2 = new THREE.Quaternion();
const _ev1 = new THREE.Vector3();
const _ev2 = new THREE.Vector3();
const _ev3 = new THREE.Vector3();

// ---- GLB 角色的菲涅尔边缘光（共享 uniforms，昼夜换色在 animate 里推进） ----
const rimColorUni = { value: new THREE.Color("#ffd9a8") };
const rimIntUni = { value: 0.3 };
const RIM_DAY = new THREE.Color("#ffd9a8");
const RIM_NIGHT = new THREE.Color("#aebfff");
function patchRimMaterial(mat: THREE.Material) {
  const m = mat as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || (m as unknown as { __rimmed?: boolean }).__rimmed) return;
  (m as unknown as { __rimmed?: boolean }).__rimmed = true;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = rimColorUni;
    shader.uniforms.uRimInt = rimIntUni;
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform vec3 uRimColor;\nuniform float uRimInt;\nvoid main() {")
      .replace(
        "#include <fog_fragment>",
        /* glsl */ `
        // 菲涅尔边缘光：视角掠过表面处泛起的光边（光遇角色的逆光轮廓）
        float rimF = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
        gl_FragColor.rgb += uRimColor * rimF * uRimInt;
        #include <fog_fragment>`
      );
  };
}

/** 披风材质：普通 toon 双面——形变与法线全部由 CapeSim 物理每帧驱动。
 *  自带暖色 emissive（默认强度 0）：太阳在背后时透光，光遇披风的逆光感 */
function makeCapeMaterial(color: THREE.Color, gradientMap: THREE.DataTexture | null, emissive = "#ffb877") {
  return new THREE.MeshToonMaterial({
    color,
    side: THREE.DoubleSide,
    gradientMap: gradientMap ?? undefined,
    emissive: new THREE.Color(emissive),
    emissiveIntensity: 0,
  });
}

/** 接触阴影贴图：中心实边缘羽化的径向渐变（角色脚下的柔和暗斑） */
let _shadowTex: THREE.Texture | null = null;
function shadowTexture(): THREE.Texture {
  if (_shadowTex) return _shadowTex;
  const size = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(20, 14, 34, 0.85)");
  g.addColorStop(0.5, "rgba(20, 14, 34, 0.4)");
  g.addColorStop(1, "rgba(20, 14, 34, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _shadowTex = new THREE.CanvasTexture(cv);
  return _shadowTex;
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
  const glbOf: Partial<Record<AvatarModel, { url: string; scale: number; y: number; ry: number; targetHeight: number }>> = {
    minion: { url: "/models/minion-a01.glb", scale: 1, y: 0, ry: 0, targetHeight: 1.25 },
    corgi: { url: "/models/corgi.glb", scale: 1, y: 0, ry: 0, targetHeight: 1.15 },
    duck: { url: "/models/duck.glb", scale: 1, y: 0, ry: 0, targetHeight: 1.32 },
    platypus: { url: "/models/platypus.glb", scale: 1, y: 0, ry: 0, targetHeight: 1.18 },
    seal: { url: "/models/seal.glb", scale: 1, y: 0, ry: 0, targetHeight: 1.12 },
    owl: { url: "/models/owl.glb", scale: 1, y: 0, ry: 0, targetHeight: 1.32 },
    hooded: { url: "/models/rogue-hooded.glb", scale: 1, y: 0, ry: 0, targetHeight: 1.72 },
    elaina: { url: "/models/elaina.glb", scale: 0.39, y: 0.57, ry: 0, targetHeight: 1.72 },
  };
  // 外部角色加载失败时继续使用下方程序化角色。
  let importedModel: THREE.Object3D | null = null;
  let importedMixer: THREE.AnimationMixer | null = null;
  const importedActions = new Map<string, THREE.AnimationAction>();
  let importedCurrent = "";
  let importedReady = false;
  let importedDisplayHeight = 1.72;
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
        const meshMats = (obj as THREE.Mesh).material;
        if (meshMats) for (const mm of Array.isArray(meshMats) ? meshMats : [meshMats]) patchRimMaterial(mm);
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

      // 各资源的建模单位从厘米到米不等。按真实包围盒统一视觉高度，并把最低点贴到角色根节点。
      group.updateMatrixWorld(true);
      importedModel.updateMatrixWorld(true);
      let bounds = new THREE.Box3().setFromObject(importedModel);
      const rawHeight = bounds.max.y - bounds.min.y;
      if (Number.isFinite(rawHeight) && rawHeight > 1e-4) {
        const normalize = glb.targetHeight / rawHeight;
        importedModel.scale.multiplyScalar(normalize);
        group.updateMatrixWorld(true);
        importedModel.updateMatrixWorld(true);
        bounds = new THREE.Box3().setFromObject(importedModel);
        const rootY = group.getWorldPosition(new THREE.Vector3()).y;
        importedModel.position.y += rootY - bounds.min.y + 0.015;
        importedDisplayHeight = glb.targetHeight;
        if (elainaRoot) elainaBaseY = importedModel.position.y;
      }

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
  const outerCapeMat = outerCape.material as THREE.MeshToonMaterial;
  // 注意：mesh 不带偏移——CapeSim 的顶点/锚点/碰撞都在 group 坐标系里表达
  group.add(outerCape);

  // 内层：静态贴身后襟（层次感来自颜色差，不与外层布互穿）
  const innerGeo = new THREE.PlaneGeometry(0.56, 0.42, 6, 6);
  innerGeo.translate(0, -0.21, 0);
  innerGeo.rotateX(0.14);
  const innerCape = new THREE.Mesh(innerGeo, makeCapeMaterial(capeInner, kit.gradient, "#ffd9a0"));
  const innerCapeMat = innerCape.material as THREE.MeshToonMaterial;

  // ---- 接触阴影：脚下柔和暗斑（腾空淡出并轻微扩散），全部模型通用 ----
  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.42 })
  );
  contactShadow.rotation.x = -Math.PI / 2;
  group.add(contactShadow);
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
  nameSprite.visible = !opts.self;
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
  let stretch = 0; // 起跳蹬伸（腾空瞬间拉长）
  let flapPulse = 0; // 扑翼脉冲
  let accelSm = 0; // 平滑加速度（起跑前倾/急停后仰）
  let lastSpeed = 0;
  let prevAir = 0;
  let prevVy = 0; // 上一帧 vy（落地冲击强度用）

  // ---- 动作物理通道（略欠阻尼弹簧：滞后起步、过头回弹、急停反仰） ----
  const mTorsoX = new Spring(150, 17); // 躯干俯仰（起跑/急停/滑翔）
  const mBankZ = new Spring(80, 11); // 转弯侧倾
  const mGaitAmp = new Spring(110, 15); // 步态幅度（起步甩开、急停收步的过渡）
  const mHeadLagY = new Spring(45, 8); // 头部转向滞后（先身转头再跟上）
  // 动作轮盘的物理通道：表情目标先算增量，弹簧负责过渡（自动得到预备滞后与收尾回弹）
  const mEmTorso = new Spring(85, 10);
  const mEmArmX = new Spring(85, 10);
  const mEmArmLZ = new Spring(85, 10);
  const mEmArmRZ = new Spring(85, 10);
  const mEmHeadX = new Spring(70, 9);
  const mEmHeadZ = new Spring(70, 9);
  const mEmHop = new Spring(160, 12); // cheer 小跳（欠阻尼多一点，弹起来）
  // 待机小动作：站立久了会重心转移/背手/歪头（光遇的小人会自己"活着"），慢弹簧进出场
  let idleT = 0; // 连续站立时长
  let idleAct = 0; // 0 无 / 1 重心转移 / 2 背手 / 3 歪头
  let idleActT = 0;
  const mIdleLean = new Spring(18, 7); // 重心侧倾（很慢）
  const mIdleArmX = new Spring(26, 8); // 双臂后收（背手）
  const mIdleHeadZ = new Spring(22, 7); // 歪头
  // 伊莱娜的根部动作物理（俯仰/升降/侧倾/步幅：起跑、急停、躺卧起身都带惯性过渡）
  const mElainaPitch = new Spring(90, 16);
  const mElainaLift = new Spring(120, 20);
  const mElainaRoll = new Spring(90, 16);
  const mElainaAmp = new Spring(110, 15);
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

  // ---- 动作轮盘表情 ----
  const EMOTE_DUR: Record<string, number> = { wave: 1.7, bow: 1.9, nod: 1.1, stretch: 2.1, cheer: 1.6, heart: 1.8 };
  let emoteName: string | null = null;
  let emoteT = 0;
  const playEmote = (name: string) => {
    if (!EMOTE_DUR[name]) return;
    emoteName = name;
    emoteT = 0;
  };

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

  // 角色接收阴影：走进树荫/山影里身体跟着变暗（光遇的角色会"进入"阴影）
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.receiveShadow = true;
  });

  return {
    group,
    say,
    playEmote,
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
        if (sit) playImported(singleAnimModels.has(modelChoice) ? "Lie_Idle" : "Sit_Floor_Idle", true);
        else if (air === 2) playImported("Jump_Idle", true);
        else if (air === 1) playImported("Jump_Start", false);
        else if (animalModels.has(modelChoice)) playImported(speed > 0.2 && modelChoice !== "minion" ? "walk" : "idle", true);
        else if (speed > 4.6) playImported("Running_A", true);
        else if (speed > 0.2) playImported("Walking_A", true);
        else playImported("Unarmed_Idle", true);
      }
      const speedN = Math.min(1, speed / 7.2);
      const vy = state.vy ?? 0;
      sitLerp = THREE.MathUtils.lerp(sitLerp, sit ? 1 : 0, 1 - Math.pow(0.002, dt));
      // 步频与地面速度挂钩：步长随幅度放大（走小步跑大步），脚下打滑的本质是步频和位移脱钩。
      // 转向仍推进步频（转身碎步）
      const strideLen = 0.34 + 0.5 * speedN;
      const stepRate = THREE.MathUtils.clamp((Math.PI * speed) / strideLen, 3.0, 24);
      walkPhase += dt * (stepRate + Math.min(6, Math.abs(yawVel)) * 1.4);
      jumpBlend = THREE.MathUtils.lerp(jumpBlend, air > 0 ? 1 : 0, Math.min(1, dt * 6));
      glideBlend = THREE.MathUtils.lerp(glideBlend, air === 2 ? 1 : 0, Math.min(1, dt * 5));
      riseBlend = THREE.MathUtils.lerp(riseBlend, air > 0 && vy > 0.8 ? 1 : 0, Math.min(1, dt * 5));
      fallBlend = THREE.MathUtils.lerp(fallBlend, air > 0 && vy < -0.8 ? 1 : 0, Math.min(1, dt * 5));
      squash = Math.max(0, squash - dt * 4);
      stretch = Math.max(0, stretch - dt * 3.2);
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
      // 起跳蹬伸/落地缓冲：腾空瞬间蹬地拉长（发力感），触地按落速压缩再弹回（重量感）
      if (air > 0 && prevAir === 0) stretch = Math.max(stretch, 0.45);
      if (air === 0 && prevAir > 0) squash = Math.max(squash, Math.min(0.85, 0.25 + Math.abs(prevVy) * 0.06));
      prevAir = air;
      prevVy = vy;
      const airN = Math.max(jumpBlend, glideBlend);
      const ground = 1 - airN;

      // ---- 动作轮盘：时间推进与目标增量（经典/伊莱娜共用时间线） ----
      // 经典小人的表情不直接摆姿势：先算目标增量，经弹簧应用——
      // 起手的预备滞后与收尾的过冲回弹由物理涌现，不用手写缓动
      if (emoteName) {
        emoteT += dt;
        if (emoteT >= (EMOTE_DUR[emoteName] ?? 1.4)) emoteName = null;
      }
      const emoteP = emoteName ? emoteT / (EMOTE_DUR[emoteName] ?? 1.4) : 0;
      const emoteEnv = emoteName ? Math.sin(Math.PI * Math.min(1, emoteP * 1.12)) : 0;
      const emoteGrounded = air === 0 && speed < 0.4 && !sit;
      let eTorso = 0, eArmX = 0, eArmLZ = 0, eArmRZ = 0, eHeadX = 0, eHeadZ = 0, eHop = 0;
      if (emoteName && !elainaRoot) {
        const p = emoteP;
        const env = emoteEnv;
        // 预备动作：发力前先反向蓄一下（鞠躬先微挺胸、欢呼先微蹲）——anticipation
        const ant = p < 0.16 ? Math.sin((p / 0.16) * Math.PI) : 0;
        switch (emoteName) {
          case "wave": // 招手：右臂举高摆动
            eArmRZ = -env * 2.15;
            eArmX = -env * 0.2;
            eHeadZ = env * 0.12;
            break;
          case "bow": // 鞠躬：先微挺再上身前倾，双手贴身
            if (emoteGrounded) {
              eTorso = -0.07 * ant + env * 0.6;
              eArmX = env * 0.3 - 0.04 * ant;
            }
            break;
          case "nod": // 点头：两连点
            eHeadX = Math.sin(p * Math.PI * 4) * 0.3;
            break;
          case "stretch": // 伸懒腰：双臂上举后仰
            eArmLZ = env * 2.3;
            eArmRZ = -env * 2.3;
            if (emoteGrounded) {
              eTorso = -env * 0.14;
              eHeadX = -env * 0.22;
            }
            break;
          case "cheer": // 欢呼：先微蹲再双臂高举小跳
            eArmLZ = env * (2.2 + Math.sin(p * Math.PI * 6) * 0.25);
            eArmRZ = -env * (2.2 + Math.cos(p * Math.PI * 6) * 0.25);
            if (emoteGrounded) eHop = Math.abs(Math.sin(p * Math.PI * 2.5)) * 0.16 * env - 0.05 * ant;
            eHeadX = -env * 0.18;
            break;
          case "heart": // 比心：双手收到胸前
            eArmX = -env * 1.15;
            eArmLZ = env * 0.55;
            eArmRZ = -env * 0.55;
            eHeadZ = Math.sin(p * Math.PI * 2) * 0.15;
            break;
        }
      }

      // ---- 待机小动作：连续站立超 6 秒随机来一个（重心转移/背手/歪头），走动/坐下/表情即打断 ----
      if (speed < 0.2 && air === 0 && !sit && !emoteName && !elainaRoot) {
        idleT += dt;
        idleActT += dt;
        if (idleAct === 0 && idleT > 6 && idleActT > 5) {
          idleAct = 1 + Math.floor(Math.random() * 3);
          idleActT = 0;
        } else if (idleAct > 0 && idleActT > 8) {
          idleAct = 0;
          idleActT = 0;
        }
      } else {
        idleT = 0;
        idleAct = 0;
        idleActT = 0;
      }

      // 平滑加速度 → 前倾角（起跑前倾、急停后仰，光遇的重量感）
      const accelRaw = (speed - lastSpeed) / Math.max(dt, 1e-3);
      lastSpeed = speed;
      accelSm = THREE.MathUtils.lerp(accelSm, THREE.MathUtils.clamp(accelRaw, -12, 12), Math.min(1, dt * 5));
      const leanAcc = THREE.MathUtils.clamp(accelSm * 0.014, -0.16, 0.2);

      // 落地压缩（横向鼓出）/ 起跳蹬伸（纵向拉长）——squash 与 stretch 独立并存
      const sq = (1 - squash * 0.16) * (1 + stretch * 0.1);
      bodyGroup.scale.set((1 + squash * 0.1) * (1 - stretch * 0.06), sq, (1 + squash * 0.1) * (1 - stretch * 0.06));

      // 躯干：盘坐后靠 / 跑动前倾+加速度 / 滑翔大幅前倾——目标过弹簧，
      // 起跑先滞后半拍再前倾过头回弹，急停后仰再回正（动作物理的核心通道）。
      // 坡度步态：沿朝向采样地形，上坡前倾蹬坡、下坡后仰刹车
      const fx = Math.sin(group.rotation.y);
      const fz = Math.cos(group.rotation.y);
      const slopeLean =
        THREE.MathUtils.clamp(
          (terrainHeight(group.position.x + fx * 0.6, group.position.z + fz * 0.6) -
            terrainHeight(group.position.x - fx * 0.6, group.position.z - fz * 0.6)) *
            0.9,
          -0.4,
          0.4
        ) *
        (0.2 + speedN * 0.5) *
        ground *
        (1 - sitLerp);
      const torsoTarget =
        -0.5 * sitLerp +
        (0.1 * speedN + leanAcc) * (1 - sitLerp) * ground +
        THREE.MathUtils.clamp(0.38 - vy * 0.07, 0.08, 0.95) * glideBlend + // 俯冲低头/爬升抬头（能量飞行的姿态反馈）
        0.15 * jumpBlend * (1 - glideBlend) +
        slopeLean;
      bodyGroup.rotation.x = mTorsoX.step(torsoTarget, dt) + mEmTorso.step(eTorso, dt);
      // 压弯（整体侧倾，过弹簧：入弯压肩回正带一点回弹）
      const groundBank = THREE.MathUtils.clamp(-yawVel * 0.055, -0.3, 0.3) * (0.3 + speedN) * ground;
      const glideBank = THREE.MathUtils.clamp(-yawVel * 0.035, -0.22, 0.22) * glideBlend;
      group.rotation.z = mBankZ.step(groundBank + glideBank, dt);
      // 侧移倾身：横移时向移动方向压身（朝向右移 → 顶向右倾 → rotation.z 为负）
      const latV = (state.vx ?? 0) * Math.cos(group.rotation.y) - (state.vz ?? 0) * Math.sin(group.rotation.y);
      const strafeLean = THREE.MathUtils.clamp(-latV * 0.02, -0.1, 0.1) * ground * (1 - sitLerp);
      // 重心左右晃（跳跳步的步感）+ 侧移倾身 + 待机重心转移 + cheer 小跳（弹簧自带落地回弹）
      bodyGroup.rotation.z =
        (speed > 0.2 ? Math.sin(walkPhase) * (0.028 + 0.03 * speedN) : 0) * ground * (1 - sitLerp) +
        strafeLean +
        mIdleLean.step(idleAct === 1 ? 0.06 : 0, dt);

      bodyGroup.position.y =
        -0.3 * sitLerp +
        (speed > 0.2 ? Math.abs(Math.sin(walkPhase)) * 0.055 * (0.45 + speedN) : Math.sin(t * 1.4) * 0.012) -
        airN * 0.06 +
        mEmHop.step(eHop, dt);

      // ---- 四肢（两段关节：步态 → 空中分层 → 盘坐） ----
      // 步态：大腿摆动、小腿在恢复期屈膝（相位差 ~1.15rad），手臂与同侧腿反相。
      // 幅度过弹簧：起步甩开、急停收步有半拍惯性，步频和身体重量对上。
      // 转身碎步：慢速大角速度转向时叠加小幅迈步（光遇转身会挪小步）
      const turnShuffle = THREE.MathUtils.clamp(Math.abs(yawVel) * 0.3, 0, 0.55) * (1 - Math.min(1, speed * 1.6)) * ground * (1 - sitLerp);
      const walkAmp = mGaitAmp.step(Math.max(speed > 0.2 ? 0.35 + speedN * 0.65 : 0, turnShuffle) * ground * (1 - sitLerp), dt);
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
      // 动作轮盘增量（弹簧）叠加在基础姿态上，替换原来的绝对覆盖
      const armSwL = -strideL;
      const armSwR = -strideR;
      armL.root.rotation.x =
        armSwL * (0.18 + speedN * 0.5) * walkAmp * 2 - 0.6 * riseBlend - 0.25 * fallBlend + 0.28 * glideBlend - 0.5 * sitLerp +
        mEmArmX.step(eArmX, dt) +
        mIdleArmX.step(idleAct === 2 ? 0.38 : 0, dt);
      armR.root.rotation.x =
        armSwR * (0.18 + speedN * 0.5) * walkAmp * 2 - 0.6 * riseBlend - 0.25 * fallBlend + 0.28 * glideBlend - 0.5 * sitLerp +
        mEmArmX.x +
        mIdleArmX.x;
      armL.root.rotation.z = 0.16 + 1.45 * glideBlend + 0.8 * fallBlend - flapPulse * 0.45 + armSwL * 0.08 * walkAmp + mEmArmLZ.step(eArmLZ, dt);
      armR.root.rotation.z = -0.16 - 1.45 * glideBlend - 0.8 * fallBlend + flapPulse * 0.45 + armSwR * 0.08 * walkAmp + mEmArmRZ.step(eArmRZ, dt);
      // 肘：跑步更弯、滑翔前伸、其余自然微弯
      const elbow = -(0.3 + (0.35 + speedN * 0.55) * walkAmp + 0.25 * riseBlend + 0.5 * glideBlend + 0.15 * fallBlend) * (1 - sitLerp) - 0.35 * sitLerp;
      armL.joint.rotation.x = elbow;
      armR.joint.rotation.x = elbow;
      // 招手时前臂绕轴摆（正弦快摆不弹簧化，弹簧只管起收）
      armR.joint.rotation.z = emoteName === "wave" && !elainaRoot ? Math.sin(emoteP * Math.PI * 5) * 0.5 * emoteEnv : 0;

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

      // 头：待机慢张望 + 滑翔抬头看前方 + 转向滞后（身先转头后跟，弱弹簧串出 secondary motion）
      headGroup.rotation.y =
        (1 - speedN) * ground * (1 - sitLerp) * Math.sin(t * 0.33 + opts.hue) * 0.26 +
        mHeadLagY.step(-THREE.MathUtils.clamp(yawVel * 0.09, -0.45, 0.45), dt);
      headGroup.rotation.z = Math.sin(t * 1.1 + opts.hue) * 0.035 * ground + mEmHeadZ.step(eHeadZ, dt) + mIdleHeadZ.step(idleAct === 3 ? 0.15 : 0, dt);
      headGroup.rotation.x = Math.sin(t * 0.9) * 0.02 + speedN * 0.1 - glideBlend * 0.7 + mEmHeadX.step(eHeadX, dt);

      // 没有专用飞行动画的导入模型也随状态调整整体姿态，避免在空中直立行走。
      if (importedModel && !elainaRoot) {
        const importedPitch = air === 2 ? THREE.MathUtils.clamp(0.3 - vy * 0.06, 0.05, 0.8) : air === 1 ? -0.08 : 0;
        importedModel.rotation.x = THREE.MathUtils.lerp(importedModel.rotation.x, importedPitch, Math.min(1, dt * 5));
        importedModel.rotation.z = THREE.MathUtils.lerp(importedModel.rotation.z, air === 2 ? THREE.MathUtils.clamp(-yawVel * 0.025, -0.14, 0.14) : 0, Math.min(1, dt * 5));
      }

      // 滑翔时名牌随肩线下压并前移：身体前倾后固定高度的名牌会飘在半空，远看像和角色脱开
      if (importedReady) {
        const sitDrop = sit ? Math.min(0.82, importedDisplayHeight * 0.5) : 0;
        const tagY = importedDisplayHeight + 0.38 - glideBlend * 0.35 - sitDrop;
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
        outerCapeSim.step(dt, outerPins, windWorld, pose, glideBlend * 0.9, bodyGroup.rotation.x, bodyGroup.position.y, bodyGroup.scale.x);
      }

      // 伊莱娜：展示动画（抬头段循环）做基底，状态用手写骨骼动作 + 根运动表达。
      // 根部俯仰/升降/侧倾全部过弹簧：起跑前倾、急停回弹、躺下与起身都是带惯性的过渡
      if (elainaRoot) {
        let pitch = 0.08 * speedN + THREE.MathUtils.clamp(accelSm * 0.012, -0.12, 0.2); // 跑动前倾
        let lift = 0;
        const seated = !!state?.seated;
        if (sit && !seated) {
          pitch = -Math.PI / 2; // 绕身体中心向后放平
          lift = -0.44; // 轴心已居中：把中心压到离地 ~0.13（背部厚度的一半）
        } else if (sit && seated) {
          pitch = -0.12; // 坐椅子/秋千：上身微后靠，身体立着（座位高度由外部驱动）
          lift = 0.06;
        } else if (air === 2) {
          pitch = THREE.MathUtils.clamp(0.38 - vy * 0.07, 0.08, 0.95); // 滑翔俯冲角随真实垂直速度（俯冲低头/爬升抬头）
          lift = -0.05;
        } else if (air === 1) {
          pitch = -0.05; // 腾空微后仰
        }
        // 坡度步态（与程序化小人同一套采样）+ 动作轮盘：鞠躬真正弯腰、点头小幅点身
        pitch += slopeLean;
        if (!sit && air === 0) {
          if (emoteName === "bow") pitch += emoteEnv * 0.5;
          else if (emoteName === "nod") pitch += Math.sin(emoteP * Math.PI * 4) * 0.1 * emoteEnv;
        }
        elainaRoot.rotation.x = mElainaPitch.step(pitch, dt);
        elainaRoot.rotation.z = mElainaRoll.step(Math.sin(walkPhase) * 0.05 * speedN, dt);
        const bounce = air > 0 || sit ? 0 : Math.abs(Math.sin(walkPhase)) * (0.035 + 0.05 * speedN); // 步伐弹跳
        elainaRoot.position.y = mElainaLift.step(elainaBaseY + lift + bounce, dt);

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
          if (sit && !seated) {
            // 躺平：双臂微微张开
            swing(elainaBones.armL, _ev2, 0.35);
            swing(elainaBones.armR, _ev2, -0.35);
          } else if (sit && seated) {
            // 坐姿：大腿前伸水平、小腿垂下，双手搭在腿上
            swing(elainaBones.thighL, _ev2, 1.45);
            swing(elainaBones.thighR, _ev2, 1.45);
            swing(elainaBones.shinL, _ev2, -1.5);
            swing(elainaBones.shinR, _ev2, -1.5);
            swing(elainaBones.armL, _ev2, 0.5);
            swing(elainaBones.armR, _ev2, -0.5);
          } else if (air === 2) {
            // 滑翔：双臂向侧上方展开，双腿并拢微后掠
            swing(elainaBones.armL, _ev2, 1.25);
            swing(elainaBones.armR, _ev2, -1.25);
            swing(elainaBones.thighL, _ev1, -0.12);
            swing(elainaBones.thighR, _ev1, -0.12);
          } else if (speed > 0.3 && air === 0) {
            // 走/跑：迈步 + 摆臂（与程序化小人同一套相位），步幅过弹簧（起步/收步过渡）
            const run = THREE.MathUtils.clamp((speed - 4.2) / 3.5, 0, 1);
            const amp = mElainaAmp.step(0.38 + run * 0.42, dt);
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

          // ---- 动作轮盘：只覆盖手臂（走路时腿照常迈，边走边招手） ----
          if (emoteName) {
            const p = emoteP;
            const env = emoteEnv;
            switch (emoteName) {
              case "wave":
                swing(elainaBones.armR, _ev2, 1.6 * env + 0.1);
                swing(elainaBones.foreR, _ev1, Math.sin(p * Math.PI * 5) * 0.55 * env);
                break;
              case "bow":
                swing(elainaBones.armL, _ev2, 0.55 * env);
                swing(elainaBones.armR, _ev2, 0.55 * env);
                break;
              case "nod":
                break; // 头骨不单独抓，点头以双臂轻垂示意
              case "stretch":
              case "cheer":
                swing(elainaBones.armL, _ev2, 2.1 * env + 0.1);
                swing(elainaBones.armR, _ev2, -(2.1 * env + 0.1));
                swing(elainaBones.foreL, _ev2, 0.3 * env);
                swing(elainaBones.foreR, _ev2, -0.3 * env);
                break;
              case "heart":
                swing(elainaBones.armL, _ev2, 0.85 * env);
                swing(elainaBones.armR, _ev2, -0.85 * env);
                swing(elainaBones.foreL, _ev1, 1.15 * env);
                swing(elainaBones.foreR, _ev1, 1.15 * env);
                break;
            }
          }
        }
      }

      // 眼睛：偶尔眨一下（scale.y 压扁）
      const blink = ((t * 0.6 + opts.hue * 0.13) % 4.7) < 0.14 ? 0.12 : 1;
      eyes.forEach((e) => e.scale.set(1, 1.5 * blink, 0.55));

      // ---- 接触阴影：贴地暗斑随高度淡出扩散（水面/深海上自然沉底不可见） ----
      const shadowGroundY = terrainHeight(group.position.x, group.position.z);
      const airH = Math.max(0, group.position.y - shadowGroundY);
      const shOpacity = 0.42 * THREE.MathUtils.clamp(1 - airH / 3.5, 0, 1);
      (contactShadow.material as THREE.MeshBasicMaterial).opacity = shOpacity;
      contactShadow.visible = shOpacity > 0.01;
      const shScale = (importedReady ? 1.15 : 0.85) * (1 + airH * 0.1);
      contactShadow.scale.set(shScale, shScale, 1);
      contactShadow.position.set(0, shadowGroundY + 0.03 - group.position.y, 0);

      // ---- 披风逆光透光：太阳在角色背后时布面泛起暖光（飞离太阳时最明显，光遇的披风感） ----
      if (!importedReady) {
        const backlit =
          THREE.MathUtils.clamp(
            -(lightState.sunDir.x * Math.sin(group.rotation.y) + lightState.sunDir.z * Math.cos(group.rotation.y)),
            0,
            1
          ) * Math.max(0, lightState.sunDir.y * 2);
        const glow = backlit * (0.3 + 0.4 * Math.max(speedN, glideBlend));
        outerCapeMat.emissiveIntensity = glow * 0.6;
        innerCapeMat.emissiveIntensity = glow;
      }

      // ---- GLB 边缘光颜色随昼夜（昼暖夜冷） ----
      rimColorUni.value.lerpColors(RIM_DAY, RIM_NIGHT, lightState.night);
      rimIntUni.value = 0.26 + 0.18 * (1 - lightState.night);

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
