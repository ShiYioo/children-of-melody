import * as THREE from "three";
import { createToonKit, painterlyGradient } from "./world/toon";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { CapeSim } from "./cape";
import { Spring } from "./motion";
import { terrainHeight } from "./heightfield";
import { lightState } from "./world/lightstate";
import { softDotTexture, softRingTexture } from "./world/fxtextures";
import { patchRimMaterial, updateRim } from "./world/rim";

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
  animate: (dt: number, t: number, speed: number, sit: boolean, air?: number, yawVel?: number, state?: { vy?: number; vx?: number; vz?: number; seated?: boolean; swim?: boolean }) => void;
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

// ---- 菲涅尔边缘光已抽到 world/rim.ts（角色与道具共用同一套） ----

/** painterlyGradient() 每次调用都会新建一张 DataTexture，材质初始化时取一次共用 */
let _glbGradient: THREE.DataTexture | null = null;
function glbGradient(): THREE.DataTexture {
  return (_glbGradient ??= painterlyGradient());
}

/**
 * 把 glTF 的 PBR 材质统一到全岛的 toon 美术语言。
 *
 * 为什么必须转：GLB 角色是 `MeshStandardMaterial`（PBR：metalness / roughness /
 * normalMap 一起做微表面着色），而程序化角色与整个岛都是 `MeshToonMaterial`
 * （把 N·L 量化成几档色阶）。两者并排出现时一眼就能看出「一个是从别的管线导入的、
 * 一个是在这个项目里画的」——这就是审查里说的「混合美术语言」。
 *
 * 三个「PBR 味」的来源，逐个去掉：
 *  1. metalness / roughness 的镜面项 —— toon 没有这一项。去掉后表面立刻变哑光。
 *  2. normalMap 的微表面起伏 —— 留着会让色阶上出现连续明暗过渡，和 toon 的硬边色阶打架。
 *     这里本来也没接。
 *  3. 自发光。`elaina.glb` 的 10 个材质全是 `baseColorFactor:[0,0,0,1]` + 纯 emissiveMap
 *     （作者把整张外观烘进了 emissiveMap）。**直接丢掉 emissive 会变成一个纯黑块**，
 *     所以遇到「底色是黑、没有漫反射贴图、但有 emissiveMap」的材质，就把
 *     emissiveMap 当作漫反射贴图接过来，让它重新参与光照，而不是自发光。
 *     同时保留一层**减弱的**自发光作为下限，避免个别部件塌成黑块。
 */
function toonifyGLBMaterial(mat: THREE.Material): THREE.Material {
  const src = mat as THREE.MeshStandardMaterial;
  const flags = mat as unknown as { isMeshStandardMaterial?: boolean; isMeshToonMaterial?: boolean };
  // ⚠ 这里**不能**用「已经在源材质上打过标记就跳过」的写法。
  // SkeletonUtils.clone 是**共享材质**的：第一个实例转换时会新建材料、
  // 源材质始终保持原样。如果在源材质上打标记，第二个实例（另一个玩家 / NPC）
  // 再遍历时就会直接返回那个**未转换的 Standard 材质**，
  // 于是"自己看是 toon、看别人还是 PBR"。
  // 转换本身是幂等的（不修改源材质），所以重复调用是安全且正确的。
  if (!flags.isMeshStandardMaterial || flags.isMeshToonMaterial) return mat;

  const colorIsBlack = src.color ? src.color.r + src.color.g + src.color.b < 0.02 : true;
  const useEmissiveAsMap = !src.map && colorIsBlack && !!src.emissiveMap;
  const map = src.map ?? (useEmissiveAsMap ? src.emissiveMap : null);
  const color = useEmissiveAsMap || (colorIsBlack && !src.map) ? new THREE.Color(1, 1, 1) : src.color.clone();

  const toon = new THREE.MeshToonMaterial({
    color,
    map,
    gradientMap: glbGradient(),
    vertexColors: src.vertexColors,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: src.alphaTest,
    side: src.side,
    depthWrite: src.depthWrite,
  });
  const hasGlow = !!src.emissiveMap || (!!src.emissive && src.emissive.r + src.emissive.g + src.emissive.b > 0.001);
  if (hasGlow) {
    // 减弱到 0.35：保留一点「灵体自发光」的气质（光遇的角色本来就会微微发亮），
    // 但不再靠它承担整张外观 —— 那才是「两张皮」的根源。
    toon.emissive = (src.emissive ? src.emissive.clone() : new THREE.Color(1, 1, 1)).multiplyScalar(0.35);
    if (src.emissiveMap) toon.emissiveMap = src.emissiveMap;
    toon.emissiveIntensity = 1;
  }
  toon.name = src.name ? `${src.name}__toon` : "glb__toon";
  return toon;
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

  // ---- 角色材质统一入口 ----
  // **这里修的是一个真实存在过的 bug。** `toon.ts` 的 `mat()` 签名是
  // `mat(color, vertexColors = false, brushRepeat = 2)` —— 第三个参数**默认 2**，
  // 而同文件顶部的设计注释写的是「传 0 表示不用笔触图（纯色 + ramp，角色用）」。
  // 结果 `avatar.ts` 里 10 处 `kit.mat(color)` 全都没传第三个参数，
  // 角色的每一块皮肤都被**静默**糊上了一层笔刷噪声。
  //
  // 尺度算一下就知道为什么这叫"塑料感"：笔刷贴图在角色身上按 1.5m 见方铺 2 次
  // → 每格 0.75m，贴图里柔斑直径 26~54px/256px → 实际柔斑 **7.6~15.8cm**，
  // 只有部件尺寸的 1/10。审查 1.5 说「建议改成波长 ≥ 8 倍部件尺寸的低频色斑」，
  // 对 1.5m 高的角色来说 8 倍就是 12m —— 现实答案就是**别用笔刷图**，纯色 + ramp。
  //
  // 注意：必须定义在 `createAvatar` 的**函数体顶层**。第一版我顺手插在
  // `makeLeg()` 里，结果出了 6 个 TS2304 —— `cmat` 只在 `makeLeg` 内部可见。
  // 以后加角色材质一律走这个包装；要笔刷请显式调 `kit.mat(c, false, N)`。
  const cmat = (color: string, vertexColors = false) => kit.mat(color, vertexColors, 0);
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
        const mesh = obj as THREE.Mesh;
        if (!mesh.material) return;
        // 顺序要紧：先统一美术语言（PBR → toon），再注入轮廓光。
        // 反过来的话 patchRimMaterial 打在旧材质上，换材质时轮廓光就丢了。
        const orig = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const conv = orig.map(toonifyGLBMaterial);
        mesh.material = conv.length === 1 ? conv[0]! : conv;
        for (const mm of conv) patchRimMaterial(mm);
        if (obj.name.toLowerCase().includes("cape")) {
          for (const mm of conv) if (mm && "color" in mm) (mm as THREE.MeshStandardMaterial).color.setHSL(opts.hue / 360, 0.42, 0.52);
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
  // 兜帽/头发：**独立的一层色**，不再从披风色派生。
  // 原来 `hoodColor = capeOuter.offsetHSL(0, 0, -0.06)` —— 兜帽和披风同色，
  // 正面看头身之间没有色彩分层：脸是奶油、身体是奶油、头顶还是奶油，整颗头是一块。
  // 光遇的角色头顶（头发/兜帽）是独立成层的，这是头脸能被"读出来"的关键之一 ——
  // 和上一轮加袍摆是同一个思路：**用一层深浅把结构讲清楚，而不是靠描边**。
  // 取暖蜜色：与脸的 #f0dcc0、身体的 #f6ecd8 同属暖调但明显更深，放在一起不打架。
  const hoodColor = new THREE.Color("#eec08a");
  const skin = "#f6ecd8"; // 奶白
  const skinDark = "#e6d5ba";
  const faceDark = "#f0dcc0"; // 脸：暖调奶油（比身体的 #f6ecd8 暖一档，头身才有分界）
  // 曾经是 #2e2745（深紫）。那版把整颗头铺成深色，正面看像戴了面罩/头盔 ——
  // 这是全身上下**最不像光遇**的一点：光遇的脸是柔和的浅色，靠 bloom 让眼睛发光，
  // 不是靠深底去"衬"眼睛。我们的 bloom 阈值 0.8、眼睛线性亮度约 1.16，
  // 换成浅底照样过阈值、照样有光晕。

  // 腿（两段：大腿+小腿+脚，膝盖能弯）——短粗化：半径加粗，幼儿的胖藕腿
  interface Limb2 {
    root: THREE.Group; // 髋/肩
    joint: THREE.Group; // 膝/肘
  }
  // 同手臂：腿的三段半径也要连续。原来 0.092 → 0.074 → 0.086，两个跳变。
  const thighGeo = new THREE.CapsuleGeometry(0.092, 0.12, 6, 20);
  const shinGeo = new THREE.CapsuleGeometry(0.083, 0.10, 6, 20);
  const footGeo = new THREE.SphereGeometry(0.083, 14, 12);
  const makeLeg = (side: number): Limb2 => {
    const root = new THREE.Group();
    root.position.set(0.11 * side, 0.46, 0);
  const thigh = new THREE.Mesh(thighGeo, cmat(skinDark));
    thigh.position.y = -0.09;
    root.add(thigh);
    const joint = new THREE.Group();
    joint.position.y = -0.19;
    root.add(joint);
    const shin = new THREE.Mesh(shinGeo, cmat(skinDark));
    shin.position.y = -0.075;
    joint.add(shin);
    const foot = new THREE.Mesh(footGeo, cmat(skinDark));
    foot.position.set(0, -0.15, 0.03);
    joint.add(foot);
    thigh.castShadow = shin.castShadow = true;
    bodyGroup.add(root);
    return { root, joint };
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // ---- 身体：真正的蛋形（下宽上窄的胖藕躯干，比上下一样粗的胶囊更幼态） ----
  // 原来是 `SphereGeometry` + `scale` —— 那是个**纯椭球，上下完全对称**，
  // 而这里却写着「下宽上窄」。四角度自评里「躯干接近一个完美球体」就是这么来的。
  //
  // 现在按高度给一个锥度系数 k(t)，t 从 0（底）到 1（顶）：
  //   底部 ×1.06（下摆微外扩）→ 中部 ×0.97 → 顶部 ×0.70（肩部收束）
  // 这样才既有光遇那种「一颗圆头 + 一件圆袍」的幼态，又不是一个球。
  // 注意：最大半宽 0.315×1.06 = 0.334，仍小于披风碰撞体的 T_X=0.387，不会穿模。
  const eggK = (t: number) => 1.06 - 0.36 * t * t;
  // 蛋形躯干的半径剖面（x 方向，单位米）
  const rEgg = (y: number) => {
    const yl = (y - 0.60) / 0.345;
    if (Math.abs(yl) >= 1) return 0;
    return 0.315 * Math.sqrt(1 - yl * yl) * eggK((yl + 1) / 2);
  };
  // ---- 领口 / 下摆**做进剖面本身**，不再叠偏移球壳 ----
  // 原来这两处是"再套一层放大 4.5%~10% 的球壳"：两个曲面一相交必然是硬台阶。
  // 特写里领口像一块纸围兜、下摆像一道箍，整件衣服读作"套了几个圈"。
  // 改成在剖面上加两处**高斯鼓包** —— 表面连续、法线也连续，
  // 鼓包本身就是布的卷边，没有相交边，也就没有台阶。
  // 合并两层球壳会**把可见外表面缩小**，必须补回来：
  //   原来最宽处是「袍子外壳」= 0.315×1.06×1.045 = 0.349
  //   合进剖面后只剩「躯干本体」= 0.310  → 少了 11%
  // 后果很具体：披风碰撞体 T_X=0.364 是按 0.349 定的，
  // 身体一缩，碰撞体就显得大了一圈，披风裹到身前把身体两侧盖住 ✗
  // 所以整体乘回 0.349/0.310 = 1.126，让外表面回到原来的位置。
  const BODY_W = 1.126;
  const collarRoll = (y: number) => 0.030 * Math.exp(-(((y - 0.858) / 0.030) ** 2));
  const hemLip = (y: number) => 0.024 * Math.exp(-(((y - 0.418) / 0.024) ** 2));
  const bodyPts: THREE.Vector2[] = [];
  // ⚠️ 剖面点必须**从下往上**给！
  // LatheGeometry 按点的顺序决定绕序，反了就会让**全部法线朝内** ——
  // 材质是 FrontSide（默认），正面被背面剔除，整个躯干直接凭空消失 ✗
  // （我第一版写成了从上往下 0.952 → 0.242，实测 1364 个法线全部朝里、0 个朝外。）
  for (let i = 0; i <= 46; i++) {
    const y = 0.242 + (0.952 - 0.242) * (i / 46);
    bodyPts.push(new THREE.Vector2(Math.max(0.0008, (rEgg(y) + collarRoll(y) + hemLip(y)) * BODY_W), y));
  }
  const torsoGeo = new THREE.LatheGeometry(bodyPts, 30);
  // 袍子的颜色分界用**顶点色**，不用第二层几何体。
  // 领口以下 = 袍色，颈子以上 = 皮肤色，中间 2cm 软过渡 ——
  // 这是"一件衣服"该有的分界，而且不产生任何几何台阶。
  {
    const pos = torsoGeo.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const cSkin = new THREE.Color(skin);
    const cRobe = new THREE.Color("#ead6b6");
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.max(0, (0.890 - pos.getY(i)) / 0.020));
      tmp.copy(cSkin).lerp(cRobe, t);
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    torsoGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  }
  const torso = new THREE.Mesh(torsoGeo, cmat("#ffffff", true));
  // 剖面是圆的，这里把 z 压扁 —— 保留原来 (0.315, 0.345, 0.275) 的椭圆截面比例。
  // 剖面 y 已经是绝对世界高度，所以不需要再 position.y 了。
  torso.scale.set(1, 1, 0.275 / 0.315);
  torso.castShadow = true;
  bodyGroup.add(torso);

  // （袍子已经做进上面的剖面里了，这里不再有第二层球壳。）

  // （披风领口也已经做进上面的剖面里了 —— 见 collarRoll。）

  // ---- 手臂（两段：大臂+小臂+手，手肘微弯）——同样短粗，手是圆手套 ----
  // 四肢的**相邻段半径必须连续**，否则每一处跳变都是一道可见的缝。
  // 原来是 上臂 0.058 → 小臂 0.050 → 手 0.062：两个跳变，
  // 侧面看整条手臂是"一串珠子/一条毛毛虫" —— 这是全身上下最粗糙的一处。
  // 现在小臂提到 0.055（与上臂只差 3mm）、手收到 0.057（与小臂只差 2mm），
  // 三段的半径几乎连成一条线，缝就看不出来了。
  // 顺带把径向分段 16 → 20，轮廓更圆。
  const upperArmGeo = new THREE.CapsuleGeometry(0.058, 0.10, 6, 20);
  const foreArmGeo = new THREE.CapsuleGeometry(0.055, 0.085, 6, 20);
  const handGeo = new THREE.SphereGeometry(0.057, 14, 12);
  // 手臂挂点 = 躯干在肩高处的半宽 + 大臂半径的 60%。
  // 注意**必须带上 BODY_W**：剖面整体乘过 1.126，这里不跟就会脱开。
  // （原来公式里是裸的 0.315，合并袍壳之后就过期了。）
  // 取 60% 而不是 100%：让大臂**嵌进**躯干而不是与它相切 ——
  // 相切只碰在一条线上，侧面看是一道凹痕；嵌进去则是从体内长出来。
  const SHOULDER_Y = 0.638; // 肩高 0.82 在单位球坐标里的 y
  const shoulderHalfW =
    0.315 * Math.sqrt(1 - SHOULDER_Y * SHOULDER_Y) * eggK((SHOULDER_Y + 1) / 2) * BODY_W;
  const armX = shoulderHalfW + 0.058 * 0.6;
  const makeArm = (side: number): Limb2 => {
    const root = new THREE.Group();
    root.position.set(armX * side, 0.82, 0);
    root.rotation.z = -0.16 * side; // 微微外张
    // 这里原来有一个 r=0.076 的「肩关节球」。撤掉了 —— 它本身就是一处"球贴球"。
    // 当初加它是因为大臂与躯干**相切**（挂点写死 0.30 = 半宽 + 大臂半径），
    // 两者只碰在一条线上，需要一颗球去盖凹痕。
    // 现在挂点按"半宽 + 60% 大臂半径"算，大臂嵌进躯干 0.035m，
    // 直接从体内长出来，不再需要那颗球。
    const upper = new THREE.Mesh(upperArmGeo, cmat(skinDark));
    upper.position.y = -0.075;
    root.add(upper);
    const joint = new THREE.Group();
    joint.position.y = -0.155;
    root.add(joint);
    const fore = new THREE.Mesh(foreArmGeo, cmat(skinDark));
    fore.position.y = -0.06;
    joint.add(fore);
    const hand = new THREE.Mesh(handGeo, cmat(skin));
    hand.position.y = -0.125;
    joint.add(hand);
    upper.castShadow = true;
    bodyGroup.add(root);
    return { root, joint };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

  // ---- 头（大、圆、戴兜帽的面具脸） ----
  // 光遇的可爱一半来自头身比：整头再放大 12%（脸/眼/腮红/兜帽一起，
  // 兜帽压过的五官比例自动跟着对）——接近三头身的幼态比例
  const headGroup = new THREE.Group();
  headGroup.position.y = 1.18;
  headGroup.scale.setScalar(1.06);
  bodyGroup.add(headGroup);

  const face = new THREE.Mesh(new THREE.SphereGeometry(0.32, 26, 20), cmat(faceDark));
  face.scale.set(1, 1.06, 0.96);
  face.castShadow = true;
  headGroup.add(face);

  // ---- 面具 ----
  // 四角度转台里最刺眼的一点：**头就是一颗保龄球**。原因是 `faceDark` 铺满整个头球，
  // 颅骨和脸之间没有任何分界，眼睛和腮红像贴在一颗球上。
  // 光遇的脸是有边界的 —— 头顶归兜帽/头发，脸是一块有形状的面。
  //
  // 做法：在脸的前方叠一层**略微外凸、颜色略浅**的球面片，只覆盖正面 162°×85° 的范围。
  // 它比脸皮大 0.006（0.326 vs 0.32），所以永远浮在外面、不会 z-fighting；
  // 边界那一圈会吃到菲涅尔边光，正面就有了「一张脸」的轮廓。
  // 颜色第一版给 #3d3660（只比 faceDark #2e2745 亮一点），实测**太含蓄**：
  // 渲染出来只在下巴附近有一条略浅的带，没把"球"读成"脸"。加到 #4d4576 才立得住。
  // 注意 three 的球面参数化：phi=π/2 才是 +Z（正面），不是 0。
  const mask = new THREE.Mesh(
    new THREE.SphereGeometry(
      0.326, 24, 18,
      Math.PI * 0.5 - Math.PI * 0.45, Math.PI * 0.90, // phi：以 +Z 为中心
      Math.PI * 0.26, Math.PI * 0.47                   // theta：从眉线到下巴
    ),
    // 面具现在只做一件事：给脸一个**边界**，让眼睛和腮红不是"贴在一颗球上"。
    // 颜色从 #4d4576（深紫）改成比脸皮深一档的暖阴影 —— 是"眼窝的阴影"，不是"面罩"。
    // 浅底 + 发光眼睛就是光遇的做法，不需要深色去衬。
    cmat("#e0c6a6", false)
  );
  mask.scale.set(1, 1.06, 0.96); // 跟着脸皮一起压扁，否则边界会离缝
  headGroup.add(mask);

  // 灵魂大眼睛（bloom 里会微微发光）——光遇角色的脸只有眼睛，眼睛就是全部表情：
  // 再大一号、水滴形（下圆上尖）、带一点内八倾角 = 无辜感
  // 眼睛是光遇角色唯一的表情，必须真的吃到 bloom。
  // 线性白 #fffdf4 亮度约 0.98，而 bloom 阈值是 0.8 —— 原本只是"勉强过线"，
  // 稍微暗一点的环境里就完全没光晕。乘 1.35 稳定超过阈值
  // （composer 的 RT 是 HalfFloat，不会像 8bit 那样把它截断回 1.0）。
  // 注意别调太高：眼睛是画面里唯一的绝对高光，增益过大会糊成一团白斑。
  // 试过暖琥珀 #ffc25e×1.9（为了在浅面具上立住），**也退回了** —— 见 27 节。
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#fffdf4").multiplyScalar(1.18) });
  // 水滴形（下圆上尖）的尺寸常量提出来，眨眼动画共用，避免两处各写一份改漏。
  // 原来 0.108 半径 × 1.12 横向 = 半宽 0.121，而两眼中心只隔 ±0.112 —— 两只眼在
  // 鼻梁处直接重叠，远超脸宽的一半，正面看就是"一整块发光的白"。光遇的眼睛
  // 只占脸宽的两成左右，两眼中留出明显间隙，脸才是脸。
  // 四角度转台（tour2-0.png / cape-0.png）看下来：眼睛的**纵向**还是过大 ——
  // EYE_R 0.062 × EYE_SY 1.75 得到高 0.217，而脸径是 0.678，即**眼睛占了脸高的三成**，
  // 加上纯白 × 1.35 的过曝增益，正面看就是两颗"震惊的大眼睛"。
  // 收成 0.056 × 1.40 → 高 0.157（占脸高 23%），宽 0.119（占脸宽 17.5%），
  // 并把增益从 1.35 压到 1.18：**仍然过 bloom 阈值 0.8**（#fffdf4 线性约 0.98 × 1.18 ≈ 1.16），
  // 但不再糊成白斑，眼睛的形状能看出来。
  const EYE_R = 0.056;
  const EYE_SX = 1.06;
  const EYE_SY = 1.40;
  // EYE_SZ 0.62 → 0.45：原来眼睛前缘在 z=0.293，而脸面在该处是 0.286 ——
  // 凸出 7mm，是一颗**贴在脸上的球**（侧看有个鼓包）。
  // 光遇的眼睛是**嵌进脸里的扁片**：压到 0.45 并把 z 从 0.258 收到 0.262，
  // 前缘正好 0.262 + 0.056×0.45 = 0.287 ≈ 脸面 0.286 —— **齐平**，
  // 后半截埋进脸里，只留一片贴在脸面上，不再有鼓包。
  const EYE_SZ = 0.45;
  const eyeGeo = new THREE.SphereGeometry(EYE_R, 12, 10);
  const eyes: THREE.Mesh[] = [];
  for (const dx of [-0.115, 0.115]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.scale.set(EYE_SX, EYE_SY, EYE_SZ);
    // z 要顶到脸皮之外：脸是 r0.32、z 向压到 0.96 的椭球，在该 x/y 处表面在 z≈0.286，
    // 眼珠前缘必须越过它才看得见，否则会整颗埋进脸里。
    // 眼珠变小后前缘会往后缩（0.255 + 0.056×0.62 = 0.290，只剩 4mm 余量），
    // 所以 z 从 0.255 挪到 0.258，把余量恢复到和改小前一样。
    eye.position.set(dx, 0.02, 0.262);
    eye.rotation.z = dx < 0 ? 0.1 : -0.1; // 内八：外角微吊，幼态无辜
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

  // 兜帽：罩住后脑与头顶的半球。
  // 原来 phiLength = 0.62π（≈112°）、只后仰 0.45rad、半径 0.345 又略大于脸，
  // 帽檐一直垂到脸中线以下 —— 正面看整颗头是一颗米色球，两只眼睛被完全吞掉，
  // 角色的表情就没了（光遇的脸只有眼睛）。
  // 现在：帽檐收到 0.46π（≈83°，停在眉线以上）、后仰加大到 0.62rad、
  // 整体上移后移一点 —— 深色面具脸和发光的眼睛从帽檐下露出来，
  // 而从背后看仍是一只盖到后颈的兜帽。
  const hood = new THREE.Mesh(
    // 分段 20×14 → 28×20：头发和脸是**两个球面相交**，
    // 交接线就是那条相交曲线 —— 分段太低时它是锯齿状的（侧视特写里很明显）。
    new THREE.SphereGeometry(0.365, 28, 20, 0, Math.PI * 2, 0, Math.PI * 0.52),
    cmat("#ffffff", false)
  );
  (hood.material as THREE.MeshToonMaterial).color.copy(hoodColor);
  hood.position.set(0, 0.035, -0.02);
  hood.rotation.x = -0.46; // 向后仰，露出脸
  headGroup.add(hood);

  // ---- 双层披风（Verlet 布料物理，底边裁成不规则扇形） ----
  const shapeCape = (geo: THREE.PlaneGeometry, jag: number) => {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    // 半宽从几何体读，不要写死 0.41 —— 那是「宽 0.82」时的值，
    // 一旦改了披风宽度，k 的域就不再是 0~1，扇贝相位会整体错位、左右不对称
    const halfW = geo.parameters.width / 2;
    const smoothstep01 = (t: number) => {
      const c = Math.min(1, Math.max(0, t));
      return c * c * (3 - 2 * c);
    };
    // ---- 这里原来有个 bug，是「一道笔直竖条」的根源 ----
    // 原写法是 `if (pos.getY(i) > -0.01) continue;`，注释说「只动底边」，
    // 但这个条件**只排除了顶端那一行**（y 恰好 = 0），下面 14 行全都吃到了
    // 扇贝位移（最大 0.13m）和 0.86 的收窄。
    // 于是肩线那一行（全宽、无位移）和紧挨着的第二行（收窄、抬 0.13m）
    // 之间是一道**断崖**；卷到柱面上以后角度从 1.15 突降到 0.989，
    // 布面就在那里翻折 —— 正是背视里那条笔直竖条。
    //
    // 修法：把「收窄」和「抬高」都改成**沿高度平滑过渡**，而且两端点取值
    // 与原来完全一致（顶端 1.0 / 无位移，底端 0.86 / 全位移），
    // 所以披风的整体轮廓不变，只是把断崖抹平。
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const x = pos.getX(i);
      const k = x / halfW + 0.5; // 0~1 沿宽度
      // 过渡半径**必须 ≥ 0.3m**，这是算出来的、不是拍的：
      // 扇贝抬升幅度最大 0.13m，而行距只有 0.043m。
      // 过渡太快（相邻行的抬升量差 > 行距）会让行与行直接穿插。
      // 用解析几何逐条边算二面角 + 查行序，实测：
      //   半径 0.12 → 行序穿插 5 处、最锐二面角 180°、超 90° 的边 21 条  ✗
      //   半径 0.30 → 穿插 0、最锐 31.5°、超 90° 的边 0 条                ✓
      //   半径 0.60 → 穿插 0、最锐 29.6°、超 90° 的边 0 条                ✓
      // 取 0.6（全程过渡），两端点与原来一致：肩线全宽无位移、下摆收窄 14% 满位移。
      const h = smoothstep01(-y / 0.6); // 0 = 肩线，1 = 下摆
      // 宽度沿高度**由窄到宽**：肩部 0.86 → 下摆 1.00。
      //
      // 原来是 (1 - 0.14h)，即**上宽下窄** —— 方向反了。
      // 结果是顶端两角戳在肩膀外面（侧视图里那个硬直的方角），
      // 而本该外扩的下摆反而是最窄的一圈。
      //
      // 也试过「只把顶上两个角抹圆」的做法（乘一个 |k-0.5|²·(1-h)² 的场），
      // 被静止几何的二面角判据否掉了：横向梯度太大，0.22 的系数就造出 19 条超 90° 的边。
      // 现在这个写法只沿高度变化、没有横向梯度，每行 x 变化量约 0.019（列距 0.058），安全。
      pos.setX(i, x * (0.86 + 0.14 * h));
      // 底缘裁成 4 个匀称的扇贝 + 一点不规则抖动。
      // 原来是 |sin(k*2.7π)| 的 3 个半波，波峰高低差很多、且没有对称性，
      // 远看像被撕开的纸边；光遇的下摆是有节奏的圆弧扇贝。
      const lobe = 0.5 - 0.5 * Math.cos(k * Math.PI * 8);
      pos.setY(i, y + jag * h * (0.13 * lobe + 0.035 * Math.sin(k * 17.3 + 1.1)));
    }
  };
  // 长 0.9 → 0.60、宽 0.82 → 0.70：
  // 原来下摆垂到 y≈0.12（几乎贴地），从背后看整条腿都被吃掉，角色只剩"一颗球 + 一口钟"；
  // 而 0.82 的宽度也大于手臂外缘（±0.358），正面看披风两侧从身体后面支棱出来，
  // 像背后贴了一块平板。光遇的披风到大腿中段、宽度收在肩线以内，小腿和脚要露出来。
  const outerGeo = new THREE.PlaneGeometry(0.7, 0.6, 12, 14);
  outerGeo.translate(0, -0.3, 0); // 顶端为固定轴
  shapeCape(outerGeo, 1);

  // ---- 把平铺的披风「卷」到躯干背面上 ----
  // 原来披风是一张 XY 平面：正面看是块平板，**侧面看是一根零厚度的竖直细条**，
  // 两侧边缘还是笔直的。这是全场最假的一处（四角度转台截图 tour2-90.png 一眼可见）。
  // 光遇的披风是**包着肩膀往下垂**的曲面，而且越往下越张开。
  //
  // 做法：把局部 x 当作圆柱上的弧长绕 Y 轴卷起来，
  // 曲率半径 `R` 随高度从 `topR` 线性长到 `botR` —— 越往下半径越大，
  // 披风才会「垂坠外扩」而不是「挂一块帘子」。
  // 注意：平面默认法线朝 +Z，而披风挂在身体背后，+Z 正指向身体，
  // 所以把两侧往 +Z 卷 = 往身体方向包 ✓ 符号不用取反。
  const wrapCape = (geo: THREE.PlaneGeometry, topR: number, botR: number, halfArc: number) => {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const halfW = geo.parameters.width / 2;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // 0 = 顶端（肩线），1 = 底端。用固定长度归一并钳制：
      // 下摆被 shapeCape 裁过，最深处大概在 -0.44，不是 -0.6
      const t = Math.min(1, Math.max(0, -y / 0.5));
      const R = topR + (botR - topR) * t;
      const th = (x / halfW) * halfArc;
      pos.setX(i, Math.sin(th) * R);
      pos.setZ(i, R * (1 - Math.cos(th)));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  };
  // halfArc 保持 1.15。**试过降到 0.95，只把自相交门的 inside 从 17 降到 14 —— 不是主因，已回退。**
  // 现状记录：外层披风被自相交门稳定判为 selfIntersecting（17/195 个顶点"在自己体内"），
  // epsilon 从 3e-5 扫到 8e-3（266 倍）一个不差，**不是数值伪影**；
  // 但俯视/侧视/背视三张隔离图里它都是一张光滑连续曲面，**看不出折叠**。
  // 内层披风（halfArc 0.95、7×7 网格）干净通过。
  // 下一步该做的判据：拿一张**解析生成的、绝对干净**的同形柱面片喂同一个门 ——
  // 若它也报 inside，则说明射线奇偶判定不适用于**开放的曲面**（它是为闭合体定义的）。
  wrapCape(outerGeo, 0.34, 0.54, 1.15);

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
  // 内层同样卷起来，且半径要**明确小于外层**（外层 0.34~0.54）。
  // 第一版给到 0.29~0.40，和外层几乎同心 —— 两层布互相穿插，
  // 侧看是一排竖条纹（z-fighting），截图 cape-90.png 里那根"波纹带"就是它。
  wrapCape(innerGeo, 0.24, 0.33, 0.95);
  const innerCape = new THREE.Mesh(innerGeo, makeCapeMaterial(capeInner, kit.gradient, "#ffd9a0"));
  const innerCapeMat = innerCape.material as THREE.MeshToonMaterial;
  // 披风也要吃统一的菲涅尔边缘光：否则整条披风没有任何边，
  // 背影在暗背景里糊成一团（原来只有躯干和头挂了两个 BackSide 背壳球）
  patchRimMaterial(outerCapeMat);
  patchRimMaterial(innerCapeMat);

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

  // ---- 轮廓光：全身统一的菲涅尔边光 ----
  // 原来这里是「躯干一个 BackSide 球壳 + 头一个 BackSide 球壳」，有三个毛病：
  //  · 四肢 / 脸 / 手脚 / 披风**全都没有边** —— 躯干一圈亮、手臂是断的，
  //    观感像「上身包了个发光壳」；
  //  · 壳是 `MeshBasicMaterial` 纯色，**不随光源方向变化** —— 太阳在哪它都亮，
  //    是「探照灯式的假边缘」。光遇的轮廓光是**逆光时才强、顺光时几乎没有**；
  //  · 壳是按躯干/头的椭球放大的，姿势一变就穿帮。
  // 现在改成与 GLB 角色、披风、道具**同一套**的菲涅尔 rim，一次铺满 bodyGroup：
  // 它是跟着视线的掠射角走的，逆光自然强、顺光自然弱，且四肢能连上。
  bodyGroup.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) patchRimMaterial(mm);
  });

  // ---- 头顶小烛光（球体 + 光晕）----
  // 原来只有一个纯色小球，**没有任何发光纹理或光晕** —— 在 bloom 里就是个硬边圆点。
  // 光遇角色的头顶光点是有明显 bloom 光晕的。
  // 光晕做成 wisp 的**子节点**：位置与呼吸缩放一起继承，不用每帧单独同步。
  // 颜色要够亮才能过 bloom 阈值（合成器是 HalfFloatType，阈值看的是**线性** Rec709 亮度，
  // 需 > 0.8）：`#fff2cf` 转线性后约 0.893，中心能亮起来。
  const wisp = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 10, 8),
    new THREE.MeshBasicMaterial({ color: capeInner.clone().lerp(new THREE.Color("#fff2cf"), 0.55) })
  );
  wisp.position.y = 1.72;
  const wispGlowMat = new THREE.SpriteMaterial({
    map: softDotTexture(),
    color: new THREE.Color("#fff2cf").multiplyScalar(1.7), // 拉到 HDR 范围，让 bloom 抓得住
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const wispGlow = new THREE.Sprite(wispGlowMat);
  wispGlow.scale.setScalar(0.42);
  wisp.add(wispGlow); // 子节点：跟着 wisp 的位置和呼吸缩放走
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
  // 原来是一圈 `RingGeometry(0.95, 1.28, 44)` 的**硬边几何环**，
  // 加一个 `CircleGeometry(0.95)` 的**硬边实心圆盘** —— 两者都是纯色、无贴图。
  // 圆盘尤其糟：一块均匀发亮的实心圆，边缘像刀切；圆环是 44 段折线。
  // 光遇里没有这种"几何图形"，只有柔和的径向光晕。
  //
  // 改用 fxtextures 的径向渐变贴图。**尺寸要反推，别直接套原来的半径**：
  // softRingTexture 的亮带落在半径 0.72×(S/2)，想让亮带对齐原来环的中线
  // (0.95+1.28)/2 = 1.115，则 S = 1.115/0.36 ≈ 3.1。
  const haloY = 0.06;
  const ringMat = new THREE.MeshBasicMaterial({
    map: softRingTexture(),
    color: "#ffb45e",
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 3.1), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = haloY;
  group.add(ring);

  // 光池：softDotTexture 中心最亮、向外柔和淡出到 0.5×S。
  // S=2.0 → 可见半径约 1.0，对齐原来半径 0.95 的圆盘，但边缘是化开的。
  const discMat = new THREE.MeshBasicMaterial({
    map: softDotTexture(),
    color: "#ffb45e",
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.0), discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = haloY - 0.01;
  group.add(disc);

  const moteCount = 10;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(moteCount * 3);
  const motePh = new Float32Array(moteCount);
  for (let i = 0; i < moteCount; i++) motePh[i] = Math.random();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  // 音符微光。两处必须修：
  //  1) 原来没有 map —— three 的 points.glsl.js 只在 `#ifdef USE_MAP` 下采样
  //     gl_PointCoord，所以这 10 粒微光渲染出来是**实心方块**，不是光点。
  //  2) 亮度只有 color(线性 0.543) × opacity(0.85) = 0.46，一直在 bloom 阈值 0.8 以下，
  //     所谓"发光"从未发生过。改成从基准色 copy 后乘 lightState.fxGain()（进 HDR），
  //     每帧刷新以跟随昼夜。
  const moteBase = new THREE.Color("#ffb45e");
  const moteMat = new THREE.PointsMaterial({
    color: moteBase.clone().multiplyScalar(lightState.fxGain()),
    map: softDotTexture(),
    size: 0.14,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  group.add(motes);

  // ---- 动画状态 ----
  let sitLerp = 0;
  let walkPhase = 0;
  let ringEnergy = 0;
  let swimBlend = 0; // 游泳姿态混合（入水快、出水稍慢，避免"弹射"上岸）
  let swimPhase = 0; // 划水相位：频率随游速
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
        else if (swimBlend > 0.5) playImported("Unarmed_Idle", true); // GLB 无游泳片段：水中改待机漂（程序化小人才有完整游泳动作）
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
      // 步频必须由**腿实际能迈出的距离**反解出来。
      //
      // 原来这里写 `strideLen = 0.34 + 0.5 * speedN`，但这个 strideLen 除了算 stepRate
      // 之外**再没被任何代码用过** —— 腿的真实摆幅在下面几百行，是
      // `strideL * 0.55 * walkAmp`。两者之间没有任何联系，所以"步幅 × 步频 = 位移"
      // 这个关系从一开始就没成立过，脚必然打滑。注释里写的"步长随幅度放大"
      // 只是意图，没有落到代码上。
      //
      // 正确关系：一步走的距离 = 2·LEG·sin(摆角)，且一个完整步态周期（2π）走两步，
      // 即一步对应 π 弧度。于是 stepRate = π·speed / (2·LEG·sin(摆角))。
      // 摆角与下面同源：walkAmp 的目标值是 0.35 + speedN·0.65，腿的摆角系数随速度
      // 从 0.55 长到 1.10（"走小步跑大步"真正生效），髋到脚 LEG ≈ 0.52 m。
      const LEG = 0.52;
      const swingNow = (0.55 + speedN * 0.55) * (0.35 + speedN * 0.65);
      const strideLen = 2 * LEG * Math.sin(Math.max(0.06, swingNow));
      const stepRate = THREE.MathUtils.clamp((Math.PI * speed) / strideLen, 3.0, 26);
      // 转向**不再**额外推进步频。原来这里是
      //   walkPhase += dt * (stepRate + min(6, |yawVel|) * 1.4)
      // 加得最多 8.4 rad/s，而位移一点没变 —— 高速时这是纯打滑。
      // "转身碎步"已经在下面的 turnShuffle 里正确表达了：它只改**幅度**、且按
      // (1 - speed*1.6) 随速度淡出，所以原地转身才碎步，跑动中不受影响。
      walkPhase += dt * stepRate;
      jumpBlend = THREE.MathUtils.lerp(jumpBlend, air > 0 ? 1 : 0, Math.min(1, dt * 6));
      glideBlend = THREE.MathUtils.lerp(glideBlend, air === 2 ? 1 : 0, Math.min(1, dt * 5));
      swimBlend = THREE.MathUtils.lerp(swimBlend, state.swim ? 1 : 0, Math.min(1, dt * (state.swim ? 5 : 3)));
      swimPhase += dt * (2.0 + speedN * 4.5) * (0.15 + swimBlend);
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
        (0.1 * speedN + leanAcc) * (1 - sitLerp) * ground * (1 - swimBlend) +
        THREE.MathUtils.clamp(0.38 - vy * 0.07, 0.08, 0.95) * glideBlend + // 俯冲低头/爬升抬头（能量飞行的姿态反馈）
        0.15 * jumpBlend * (1 - glideBlend) +
        1.25 * swimBlend + // 游泳俯卧：躯干几乎放平（脸朝前下）
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
        (speed > 0.2 ? Math.abs(Math.sin(walkPhase)) * 0.055 * (0.45 + speedN) : Math.sin(t * 1.4) * 0.012) * (1 - swimBlend) -
        airN * 0.06 +
        Math.sin(swimPhase * 2) * 0.035 * swimBlend + // 划水节拍的浮沉
        mEmHop.step(eHop, dt);

      // ---- 四肢（两段关节：步态 → 空中分层 → 盘坐） ----
      // 步态：大腿摆动、小腿在恢复期屈膝（相位差 ~1.15rad），手臂与同侧腿反相。
      // 幅度过弹簧：起步甩开、急停收步有半拍惯性，步频和身体重量对上。
      // 转身碎步：慢速大角速度转向时叠加小幅迈步（光遇转身会挪小步）
      const turnShuffle = THREE.MathUtils.clamp(Math.abs(yawVel) * 0.3, 0, 0.55) * (1 - Math.min(1, speed * 1.6)) * ground * (1 - sitLerp);
      const walkAmp = mGaitAmp.step(Math.max(speed > 0.2 ? 0.35 + speedN * 0.65 : 0, turnShuffle) * ground * (1 - sitLerp) * (1 - swimBlend), dt);
      const strideL = Math.sin(walkPhase);
      const strideR = Math.sin(walkPhase + Math.PI);
      const kneeBase = 0.5 + speedN * 0.6;
      const kneeL = Math.max(0, Math.sin(walkPhase - 1.15)) * kneeBase;
      const kneeR = Math.max(0, Math.sin(walkPhase + Math.PI - 1.15)) * kneeBase;
      // 游泳：双腿交替打水（髋部 ±0.4rad，膝微屈保持流线型）
      const kickL = Math.sin(swimPhase * 2);
      const kickR = Math.sin(swimPhase * 2 + Math.PI);

      // 腿：walk 摆 + rise 伸展 + fall 前抬收膝 + glide 并拢后掠（与躯干轴对齐） + sit 盘腿 + swim 打水
      legL.root.rotation.x =
        strideL * (0.55 + speedN * 0.55) * walkAmp - 0.15 * riseBlend - 0.55 * fallBlend + 1.05 * glideBlend - 1.45 * sitLerp +
        kickL * 0.4 * swimBlend;
      legL.joint.rotation.x =
        kneeL * 1.6 * walkAmp + 0.15 * riseBlend + 0.95 * fallBlend - 0.05 * glideBlend + 1.45 * sitLerp +
        0.25 * swimBlend;
      legR.root.rotation.x =
        strideR * (0.55 + speedN * 0.55) * walkAmp - 0.15 * riseBlend - 0.55 * fallBlend + 1.05 * glideBlend - 1.45 * sitLerp +
        kickR * 0.4 * swimBlend;
      legR.joint.rotation.x =
        kneeR * 1.6 * walkAmp + 0.15 * riseBlend + 0.95 * fallBlend - 0.05 * glideBlend + 1.45 * sitLerp +
        0.25 * swimBlend;

      // 臂：walk 反相摆 + rise 后上摆 + fall 侧举 + glide 向前上方伸出（从翼面前缘探出，不被布盖住） + sit 放前
      // 动作轮盘增量（弹簧）叠加在基础姿态上，替换原来的绝对覆盖
      const armSwL = -strideL;
      const armSwR = -strideR;
      // 游泳：双臂交替大回环划水（相位差半圈），外展让手肘离开躯干
      const strokeL = Math.sin(swimPhase);
      const strokeR = Math.sin(swimPhase + Math.PI);
      armL.root.rotation.x =
        armSwL * (0.18 + speedN * 0.5) * walkAmp * 2 - 0.6 * riseBlend - 0.25 * fallBlend + 0.28 * glideBlend - 0.5 * sitLerp +
        strokeL * 1.05 * swimBlend +
        mEmArmX.step(eArmX, dt) +
        mIdleArmX.step(idleAct === 2 ? 0.38 : 0, dt);
      armR.root.rotation.x =
        armSwR * (0.18 + speedN * 0.5) * walkAmp * 2 - 0.6 * riseBlend - 0.25 * fallBlend + 0.28 * glideBlend - 0.5 * sitLerp +
        strokeR * 1.05 * swimBlend +
        mEmArmX.x +
        mIdleArmX.x;
      armL.root.rotation.z = 0.16 + 1.45 * glideBlend + 0.8 * fallBlend - flapPulse * 0.45 + armSwL * 0.08 * walkAmp + 0.3 * swimBlend + mEmArmLZ.step(eArmLZ, dt);
      armR.root.rotation.z = -0.16 - 1.45 * glideBlend - 0.8 * fallBlend + flapPulse * 0.45 + armSwR * 0.08 * walkAmp - 0.3 * swimBlend + mEmArmRZ.step(eArmRZ, dt);
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
            .set(k * 0.66, 1.02, -0.17 - 0.05 * Math.abs(k) * 2)
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
        // 水里的风几乎传不到布上：风场按入水深度衰减
        windWorld.multiplyScalar(1 - swimBlend * 0.9);
        outerCapeSim.step(dt, outerPins, windWorld, pose, glideBlend * 0.9, bodyGroup.rotation.x, bodyGroup.position.y, bodyGroup.scale.x, swimBlend);
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
      eyes.forEach((e) => e.scale.set(EYE_SX, EYE_SY * blink, EYE_SZ));

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

      // ---- 边缘光颜色随昼夜（昼暖夜冷）----
      // 放在这里是因为角色每帧都会跑；道具共用同一对共享 uniform，一起变。
      updateRim();

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
      // 自发光增益每帧刷新（昼夜在变）。从基准色 copy 再乘，绝不在原地累乘。
      moteMat.color.copy(moteBase).multiplyScalar(lightState.fxGain());
    },
    setRing(color, energy) {
      ringEnergy = energy;
      if (color) {
        ringMat.color.copy(color);
        discMat.color.copy(color);
        moteBase.copy(color);
        moteMat.color.copy(moteBase).multiplyScalar(lightState.fxGain());
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
      wispGlowMat.dispose(); // map 是共享缓存的 softDotTexture，不能 dispose
      // rimMat 已随背壳法一起删除：轮廓光改走共享的菲涅尔注入，
      // 它不持有独立材质，没有东西需要在这里释放。
      outerCape.geometry.dispose();
      innerCape.geometry.dispose();
      for (const m of [outerCape.material, innerCape.material]) {
        for (const mat of Array.isArray(m) ? m : [m]) (mat as THREE.Material).dispose();
      }
    },
  };
}


