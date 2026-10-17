import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { createSky, type SkyPalette } from "./sky";
import { createTerrain } from "./terrain";
import { createWater } from "./water";
import { createClouds } from "./clouds";
import { createProps, type Campfire } from "./props";
import { createToonKit, setToonAnisotropy } from "./toon";
import { createMotes, createFireflies, createEmbers } from "./particles";
import { createWindLines } from "./windlines";
import { createBursts } from "./bursts";
import { lightState } from "./lightstate";
import { isTouchDevice } from "../touch";

// 水面波光色（随昼夜）：白昼暖金 / 黄昏深金 / 夜月冷白
const SPEC_DAY = new THREE.Color("#ffe9c0");
const SPEC_WARM = new THREE.Color("#ffb36b");
const SPEC_NIGHT = new THREE.Color("#cfd8ff");
// 光色随高度的真实大气散射：贴地平线的暖橙 / 月光的冷蓝
const _warmHorizon = new THREE.Color("#ff9d62");
const _moonLight = new THREE.Color("#a8b8e8");

export interface World {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  campfire: Campfire;
  wind: ReturnType<typeof createWindLines>;
  bursts: ReturnType<typeof createBursts>;
  addToScene: (obj: THREE.Object3D) => void;
  render: (dt: number, t: number, playerPos?: import("three").Vector3) => void;
  resize: () => void;
  /** 昼夜循环：phase 0~1（0 黄昏 → 0.25 夜 → 0.5 黎明 → 0.75 白昼），全部客户端按同一时钟对齐 */
  setDayPhase: (phase: number) => void;
  /** 花随琴动：让 pos 附近的发光小花亮起 */
  pulseFlowers: (pos: import("three").Vector3, r?: number, strength?: number) => void;
}

export function createWorld(container: HTMLElement): World {
  // ---- 渲染器（移动端降载：像素比 1.5 + 半分辨率阴影，保住手机帧率） ----
  const mobile = isTouchDevice();
  // ⚠ 不开 preserveDrawingBuffer:它是 Windows GPU 驱动上"画面随机闪现一块白色/
  //    垃圾纹理又瞬间消失"的经典诱因 —— 该选项禁止浏览器用标准 flip 合成,
  //    部分驱动在 copy 回退路径上有合成竞争。拍照快门(main.ts)在 render() 之后
  //    同一个 JS 任务里 toDataURL,缓冲在交还合成器前不会被清,不需要这个选项。
  //
  // ⚠ antialias 必须关:画面走 EffectComposer(SMAA 后处理负责抗锯齿),默认
  //   framebuffer 的 MSAA 完全用不上,却让驱动多维护一层 MSAA surface ——
  //   多一层就多一分"合成 tile 闪白/闪脏"的驱动路径(与 preserveDrawingBuffer
  //   同类的合成层异常)。高帧率 + 显存压力大的机器上尤其容易暴露。
  // powerPreference 同理不锁 high-performance:双显卡机器上强制独显会让每帧
  //   都走跨适配器拷贝,又是一条驱动相关的合成异常路径。
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // 笔触贴图接上各向异性过滤：默认 anisotropy=1 时，地面在掠射角会被过度 mip 糊掉
  setToonAnisotropy(renderer.capabilities.getMaxAnisotropy());
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xeecfa4, 0.0046);

  const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 1200);
  camera.position.set(0, 6, 14);

  // ---- 光照：永恒黄昏（暖阳 + 紫罗兰补光，冷暖对比是光遇配色的一半） ----
  const hemi = new THREE.HemisphereLight(0xffe2c0, 0x6a8fa0, 0.82);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0x8a7bd0, 0.36);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffd6a0, 1.65);
  sun.position.set(-37, 16, -25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  // 岛半径 58：±62 贴着岛界，阴影贴图像素密度提升 ~65%（边缘更利落）
  sun.shadow.camera.left = -62;
  sun.shadow.camera.right = 62;
  sun.shadow.camera.top = 62;
  sun.shadow.camera.bottom = -62;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  // ---- 世界陈设 ----
  const sky = createSky();
  scene.add(sky.mesh);

  const terrain = createTerrain();
  scene.add(terrain);

  const water = createWater(camera);
  scene.add(water.mesh);

  const clouds = createClouds();
  scene.add(clouds.group);

  // ---- 远岛剪影：地平线上的层叠山影，画面纵深（随相位染色，不受雾影响） ----
  const islandCv = document.createElement("canvas");
  islandCv.width = 256;
  islandCv.height = 128;
  {
    const ictx = islandCv.getContext("2d")!;
    ictx.fillStyle = "#ffffff";
    // 三层叠出岛影轮廓：远峰-主岛-近脚
    const blob = (cx: number, cy: number, rx: number, ry: number) => {
      ictx.beginPath();
      ictx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ictx.fill();
    };
    blob(128, 108, 120, 26);
    blob(96, 88, 70, 30);
    blob(168, 92, 60, 22);
    blob(128, 72, 34, 26);
    blob(110, 62, 18, 18);
    // 底边羽化进海面
    const fade = ictx.createLinearGradient(0, 92, 0, 128);
    fade.addColorStop(0, "rgba(255,255,255,1)");
    fade.addColorStop(1, "rgba(255,255,255,0)");
    ictx.globalCompositeOperation = "destination-out";
    ictx.fillStyle = fade;
    ictx.fillRect(0, 92, 256, 36);
    ictx.globalCompositeOperation = "source-over";
  }
  const islandTex = new THREE.CanvasTexture(islandCv);
  const farIslandMats: THREE.MeshBasicMaterial[] = [];
  const farIslands = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const m = new THREE.MeshBasicMaterial({ map: islandTex, transparent: true, depthWrite: false, fog: false, opacity: 0.85 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    const ang = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
    const d = 380 + Math.random() * 170;
    const w = 170 + Math.random() * 150;
    mesh.position.set(Math.cos(ang) * d, 14 + Math.random() * 22, Math.sin(ang) * d);
    mesh.scale.set(w, w * (0.16 + Math.random() * 0.1), 1);
    mesh.lookAt(0, mesh.position.y * 0.6, 0);
    farIslandMats.push(m);
    farIslands.add(mesh);
  }
  scene.add(farIslands);

  const kit = createToonKit();
  const props = createProps(kit);
  scene.add(props.group);

  const motes = createMotes();
  scene.add(motes.points);
  const fireflies = createFireflies();
  scene.add(fireflies.points);
  const embers = createEmbers();
  scene.add(embers.points);

  // ---- 滑翔风线 + 瞬态光效 ----
  const wind = createWindLines();
  scene.add(wind.lines);
  const bursts = createBursts();
  scene.add(bursts.group);

  // ---- 屏幕空间体积光（god rays 后处理）：AAA 的丁达尔 ----
  // 从太阳/月亮的「屏幕位置」向外径向采样：亮处（太阳圆盘/亮天空）沿光路泄漏成光芒，
  // 被树/云/角色剪影遮挡处自然断裂—— billboard 假光柱无论怎么摆都做不出"从日轮里发出来"
  const godRayShader = {
    uniforms: {
      tDiffuse: { value: null as THREE.Texture | null },
      uLightPos: { value: new THREE.Vector2(0.5, 0.5) }, // 光源屏幕 UV
      uIntensity: { value: 0 }, // 相位基调 × 朝向 × 地平线淡入
      uThreshold: { value: 0.55 }, // 只有够亮的像素才泄漏成光（太阳盘/亮空）
      uTint: { value: new THREE.Color("#ffe9c0") }, // 光芒色：昼暖夜冷
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 uLightPos;
      uniform float uIntensity;
      uniform float uThreshold;
      uniform vec3 uTint;
      varying vec2 vUv;

      void main() {
        vec4 base = texture2D(tDiffuse, vUv);
        if (uIntensity <= 0.001) {
          gl_FragColor = base;
          return;
        }
        // 从当前像素向光源屏幕位置径向步进采样：沿途的亮度按衰减累计成光芒
        vec2 delta = (uLightPos - vUv) / 40.0;
        vec2 uv = vUv;
        float decay = 1.0;
        vec3 ray = vec3(0.0);
        for (int i = 0; i < 40; i++) {
          uv += delta;
          vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
          float lum = max(max(s.r, s.g), s.b);
          ray += s * smoothstep(uThreshold, uThreshold + 0.35, lum) * decay;
          decay *= 0.94;
        }
        ray *= uTint / 40.0;
        gl_FragColor = vec4(base.rgb + ray * uIntensity * 2.2, base.a);
      }
    `,
  };
  const godState = {
    base: 0.5, // 相位基调（setDayPhase 写入）
    worldDir: new THREE.Vector3(0, 1, 0), // 当前主导天体方向（太阳或月亮）
  };
  // 复用临时量（体积光每帧投影，避免分配）
  const _godWorld = new THREE.Vector3();
  const _godNdc = new THREE.Vector3();
  const _godView = new THREE.Vector3();
  function updateGodRays() {
    const dir = godState.worldDir;
    // 光源世界点：沿天体方向放到天空球附近
    _godWorld.copy(dir).multiplyScalar(800).add(camera.position);
    _godNdc.copy(_godWorld).project(camera);
    const behind = _godNdc.z > 1 || _godNdc.z < -1;
    // 面向系数：背对太阳时没有径向光
    camera.getWorldDirection(_godView);
    const facing = Math.max(0, _godView.dot(dir));
    // 屏幕边缘软化：光源快出画面时收掉，避免边缘拉丝
    const ex = THREE.MathUtils.clamp(1.15 - Math.abs(_godNdc.x), 0, 1);
    const ey = THREE.MathUtils.clamp(1.15 - Math.abs(_godNdc.y), 0, 1);
    (godPass.uniforms.uLightPos.value as THREE.Vector2).set(_godNdc.x * 0.5 + 0.5, _godNdc.y * 0.5 + 0.5);
    godPass.uniforms.uIntensity.value = behind ? 0 : godState.base * facing * facing * ex * ey;
  }

  // ---- 后期：体积光 → Bloom → SMAA → 输出 ----
  // 显式使用 8 位颜色缓冲，避开部分 Windows/集显驱动对默认 HalfFloat
  // 合成目标的偶发 tile resolve 闪屏。Bloom 仍然在合成链中工作，最终输出
  // 已经过色调映射，不需要把整条后处理链放在半浮点 framebuffer 上。
  const composerTarget = new THREE.WebGLRenderTarget(
    container.clientWidth,
    container.clientHeight,
    {
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    }
  );
  composerTarget.texture.name = "CrescendoComposerTarget";
  const composer = new EffectComposer(renderer, composerTarget);
  // 抗锯齿走 SMAA 后处理，**不要**给 composer 的 RT 开 MSAA。
  //
  // 兼容性结论：浮点 RT 在部分驱动上即使 framebuffer 检查通过，resolve
  // 仍可能在特定相位输出错误的整块颜色；上面的 UnsignedByte RT 已经绕开这条路径。
  // 这里仍然不启用 MSAA，避免重复维护一层驱动相关的 resolve surface。
  //
  // SMAA 是独立全屏 pass，与 RT 格式无关，且顺带处理着色器锯齿（草叶、披风边缘）。
  composer.addPass(new RenderPass(scene, camera));
  const godPass = new ShaderPass(godRayShader);
  composer.addPass(godPass); // 体积光在 Bloom 之前：光芒先成形再被柔化
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.42, // strength：光遇的泛光很克制——发光的应该只有光源本身，不是整个画面
    0.85, // radius
    0.8 // threshold：抬高，只有真亮源才吃到辉光（旧 0.72 会把大片暖色都点亮）
  );
  composer.addPass(bloom);
  // 顺序要紧：three 的 SMAAPass 在 linear-srgb 下工作，必须在 OutputPass 之前
  const smaa = new SMAAPass();
  composer.addPass(smaa);
  composer.addPass(new OutputPass());

  let lastW = 0, lastH = 0;
  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    // 容器尺寸为 0（面板后台化等）时跳过：aspect=w/0=Infinity 会让
    // 投影矩阵永久带上 NaN，恢复可见后画面全黑
    if (w < 2 || h < 2) return;
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    // composer.setSize 内部已经按 pixelRatio 给**所有 pass**（含 SMAA）设过尺寸。
    // 原来后面又调了一次 smaa.setSize(w, h)（CSS 像素）：在 devicePixelRatio > 1
    // 的屏幕上，SMAA 的 edge/weight 缓冲会被设成一半分辨率，与颜色缓冲比例错位，
    // 混出整片异常色块。删掉那次重复调用即可。
    composer.setSize(w, h);
  };
  window.addEventListener("resize", resize);
  // 容器尺寸变化不一定会触发 window.resize（DevTools 停靠、面板显隐、iframe 宿主
  // 改尺寸…）。一旦画布/渲染目标尺寸和容器对不上，画面边缘会露出未渲染的条带
  // （白块/旧帧）。用 ResizeObserver 兜住这一类。
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => resize()).observe(container);
  }

  // ---- 昼夜循环：四阶段关键帧（黄昏→夜→黎明→白昼），平滑插值 ----
  // 色板统一降饱和 15%（光遇的克制感：水彩晕染，不是高饱和卡通）
  const C = (hex: string) => {
    const c = new THREE.Color(hex);
    const l = (c.r + c.g + c.b) / 3;
    return c.lerp(new THREE.Color(l, l, l), 0.15);
  };
  interface Phase {
    sky: SkyPalette;
    fogColor: THREE.Color;
    fogDensity: number;
    hemiSky: THREE.Color;
    hemiGround: THREE.Color;
    hemiInt: number;
    ambientColor: THREE.Color;
    ambientInt: number;
    sunColor: THREE.Color;
    sunInt: number;
    sunPos: THREE.Vector3;
    shaftOpacity: number;
    exposure: number;
  }
  const PHASES: Phase[] = [
    {
      // 黄昏（原本的永恒黄昏）
      sky: { zenith: C("#3b4a8f"), mid: C("#9a7bc0"), rose: C("#f2a48f"), horizon: C("#ffd9a3"), sea: C("#e8c9a8"), night: 0, sunEl: 0.22 },
      fogColor: C("#eecfa4"), fogDensity: 0.0046,
      hemiSky: C("#ffe2c0"), hemiGround: C("#6a8fa0"), hemiInt: 0.82,
      ambientColor: C("#8a7bd0"), ambientInt: 0.36,
      sunColor: C("#ffd6a0"), sunInt: 1.65, sunPos: new THREE.Vector3(-37, 16, -25),
      shaftOpacity: 0.05, exposure: 1.12,
    },
    {
      // 夜：星空铺满、月光清冷、萤火虫登场
      //
      // ⚠ 夜空调色本轮上调过，原因是实测：原来天顶 #0c1230 的线性亮度只有 0.0072，
      // 是**白昼天顶 0.208 的 1/26**；而地平线 0.089 反而是它的 11 倍。
      // 上下对比大得离谱，抬头就是一片死黑（整帧 darkPct 99.5%）。
      // 现在天顶 0.034、地平线 0.132，都约为白昼的 1/6 —— 是「看得清的深蓝夜」。
      //
      // 放心改：天穹是 BackSide 的**纯着色网格，不发光**，改它不会照亮场景。
      // 场景光照由 hemiSky / hemiGround / ambientColor 单独控制，两边互不影响。
      sky: { zenith: C("#232e6b"), mid: C("#2e3a7d"), rose: C("#414c8c"), horizon: C("#55639b"), sea: C("#333e66"), night: 1, sunEl: 0.5 },
      fogColor: C("#2a3354"), fogDensity: 0.0055,
      hemiSky: C("#4a5a9a"), hemiGround: C("#1c2a4a"), hemiInt: 0.5,
      ambientColor: C("#2c3a6e"), ambientInt: 0.3,
      sunColor: C("#9fb4e8"), sunInt: 0.4, sunPos: new THREE.Vector3(24, 34, -14),
      shaftOpacity: 0.012, exposure: 0.98,
    },
    {
      // 黎明：粉玫瑰色渐亮
      sky: { zenith: C("#5a6ab8"), mid: C("#9a90c8"), rose: C("#e8a8c0"), horizon: C("#ffc9d8"), sea: C("#d8b0c0"), night: 0.15, sunEl: 0.14 },
      fogColor: C("#dcc4d4"), fogDensity: 0.005,
      hemiSky: C("#ffd8e0"), hemiGround: C("#5a7a8a"), hemiInt: 0.75,
      ambientColor: C("#8a7bc0"), ambientInt: 0.36,
      sunColor: C("#ffd0b0"), sunInt: 1.2, sunPos: new THREE.Vector3(-34, 10, -25),
      shaftOpacity: 0.04, exposure: 1.06,
    },
    {
      // 白昼：明亮清透
      sky: { zenith: C("#4a7ac8"), mid: C("#7aa4d8"), rose: C("#b8d0e8"), horizon: C("#d8ecf4"), sea: C("#9ac8d8"), night: 0, sunEl: 0.85 },
      fogColor: C("#cfe0e8"), fogDensity: 0.0038,
      hemiSky: C("#eaf4ff"), hemiGround: C("#6a8fa0"), hemiInt: 0.9,
      ambientColor: C("#8a9ad0"), ambientInt: 0.42,
      sunColor: C("#fff2d8"), sunInt: 1.9, sunPos: new THREE.Vector3(-30, 38, -20),
      shaftOpacity: 0.06, exposure: 1.15,
    },
  ];
  const skyPal: SkyPalette = {
    zenith: PHASES[0].sky.zenith.clone(),
    mid: PHASES[0].sky.mid.clone(),
    rose: PHASES[0].sky.rose.clone(),
    horizon: PHASES[0].sky.horizon.clone(),
    sea: PHASES[0].sky.sea.clone(),
    night: 0,
    sunEl: 0.22,
  };
  // 萤火虫/光尘都是 ShaderMaterial：透明度**只能写 uniform**，不能写 `.opacity`
  // （three 的 WebGLMaterials 对 isShaderMaterial 分支只设 uniformsNeedUpdate=false，
  //  根本不读 material.opacity → 直接写 .opacity 是 no-op，萤火虫会昼夜满亮）
  const fireflyUniforms = (fireflies.points.material as THREE.ShaderMaterial).uniforms;
  const motesUniforms = (motes.points.material as THREE.ShaderMaterial).uniforms;

  // ---- 每帧复用的临时量：setDayPhase 在主循环里每帧调用，
  //      原来一帧会产生约 8 个堆对象 + 6 次 hex 字符串解析并触发 GC 尖峰 ----
  const _sunD = new THREE.Vector3();
  const _moonD = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  const _uTintNight = new THREE.Color("#c9d6ff");
  const _spec = new THREE.Color();
  const _silC = new THREE.Color();
  const _waterPhase = {
    sunDir: new THREE.Vector3(),
    fogColor: new THREE.Color(),
    fogDensity: 0,
    skyHi: new THREE.Color(),
    skyLo: new THREE.Color(),
    specColor: new THREE.Color(),
    night: 0,
  };
  /** 写到 out 里而不新建向量（原来每帧 2~4 个 Vector3） */
  const arcDir = (t: number, maxEl: number, azBase: number, azSpan: number, out: THREE.Vector3) => {
    const elv = Math.sin(t * Math.PI) * maxEl;
    const az = azBase + (t - 0.5) * azSpan;
    return out.set(Math.sin(az) * Math.cos(elv), Math.sin(elv), Math.cos(az) * Math.cos(elv));
  };

  function setDayPhase(phase: number) {
    const p = ((phase % 1) + 1) % 1;
    const seg = Math.min(3, Math.floor(p * 4));
    const next = (seg + 1) % 4;
    let u = p * 4 - seg;
    u = u * u * (3 - 2 * u); // smoothstep：阶段交界处过渡更柔
    const a = PHASES[seg];
    const b = PHASES[next];
    const mixC = (ca: THREE.Color, cb: THREE.Color, out: THREE.Color) => out.copy(ca).lerp(cb, u);
    mixC(a.sky.zenith, b.sky.zenith, skyPal.zenith);
    mixC(a.sky.mid, b.sky.mid, skyPal.mid);
    mixC(a.sky.rose, b.sky.rose, skyPal.rose);
    mixC(a.sky.horizon, b.sky.horizon, skyPal.horizon);
    mixC(a.sky.sea, b.sky.sea, skyPal.sea);
    // 雾也必须跟着相位走 —— 这一处之前是漏的。
    // PHASES 表里一直有 fogColor / fogDensity 两组值，但**没有任何代码把它写进 scene.fog**，
    // 昼夜循环改了天空、太阳、曝光、水面波光、云，唯独没改雾，于是雾恒为黄昏的亮米色
    // #eecfa4 —— 到深夜整片远景会被一层发亮的奶色霾糊住（近处亮、远处更亮，反物理）。
    // 密度本来就按相位给得不一样：黄昏 .0046 / 夜 .0055 / 黎明 .0050 / 白昼 .0038。
    // 云海是每帧读现场 scene.fog 的，所以修好这里它会自动跟着变。
    const fogNow = scene.fog as THREE.FogExp2;
    mixC(a.fogColor, b.fogColor, fogNow.color);
    fogNow.density = THREE.MathUtils.lerp(a.fogDensity, b.fogDensity, u);
    // 半球光与环境光同样必须跟着相位走 —— 和雾是完全一样的漏法：
    // PHASES 里一直有 hemiSky / hemiGround / hemiInt / ambientColor / ambientInt 五组值，
    // 但**没有任何代码把它们写进 hemi / ambient**。
    // 结果是深夜的半球光还是白昼的 0.82、环境光还是 0.36，草地被照成白昼一样的亮绿，
    // 只有篝火附近才像夜里 —— 夜景因此完全不像《光遇》。
    // 这一处修好，"越暗越靠自发光"才真正成为架构性质：环境压下去之后，
    // 光自然集中在火堆、灯塔、萤火虫和发光道具上。
    hemi.color.copy(a.hemiSky).lerp(b.hemiSky, u);
    hemi.groundColor.copy(a.hemiGround).lerp(b.hemiGround, u);
    hemi.intensity = THREE.MathUtils.lerp(a.hemiInt, b.hemiInt, u);
    ambient.color.copy(a.ambientColor).lerp(b.ambientColor, u);
    ambient.intensity = THREE.MathUtils.lerp(a.ambientInt, b.ambientInt, u);
    skyPal.night = THREE.MathUtils.lerp(a.sky.night, b.sky.night, u);
    skyPal.sunEl = THREE.MathUtils.lerp(a.sky.sunEl, b.sky.sunEl, u);
    mixC(a.sunColor, b.sunColor, sun.color);
    sun.intensity = THREE.MathUtils.lerp(a.sunInt, b.sunInt, u);

    // ---- 实时日月轨道：位置由时钟连续算出，光源、天空圆盘、光柱、水面波光跟随天体 ----
    // 弧线区间必须严格卡在色板相位上，否则会出现"黎明的暖光从月亮方向照来"的错位：
    // 太阳 p∈[0.5,1.0]（黎明相位升起→黄昏相位落下），月亮 p∈[0.12,0.48]（入夜升→黎明前落）
    const sunT = (p - 0.5) / 0.5;
    const moonT = (p - 0.12) / 0.36;
    const sunUp = sunT >= 0 && sunT <= 1;
    const moonUp = moonT >= 0 && moonT <= 1;
    const sunD = sunUp ? arcDir(sunT, 0.95, -0.35, 2.8, _sunD) : _sunD.copy(_down);
    const moonD = moonUp ? arcDir(moonT, 0.8, 2.6, -2.2, _moonD) : _moonD.copy(_down);
    const sunElv = sunUp ? Math.sin(sunT * Math.PI) * 0.95 : -1;
    const moonElv = moonUp ? Math.sin(moonT * Math.PI) * 0.8 : -1;
    // 光源 = 主导天体（交叉时段按高度切换）；强度再乘高度因子——初升/将落的光更弱
    const lead = sunElv >= moonElv ? sunD : moonD;
    const leadIsMoon = moonElv > sunElv;
    sun.position.copy(lead).multiplyScalar(60);
    const elvDim = 0.6 + 0.4 * THREE.MathUtils.clamp(Math.max(sunElv, moonElv) / 0.5, 0, 1);
    sun.intensity *= elvDim;
    // 光色随高度连续变化（大气散射的真实行为）：贴地平线时最暖（长路径散射），
    // 爬高逐渐转白；月亮主导时整体偏冷蓝——不再只靠相位关键帧的阶梯色
    const leadElv = Math.max(sunElv, moonElv);
    const lowSun = 1 - THREE.MathUtils.clamp(leadElv / 0.45, 0, 1);
    sun.color.lerp(_warmHorizon, lowSun * 0.55);
    if (leadIsMoon) sun.color.lerp(_moonLight, 0.6);
    const horizonFade = (elv: number) => THREE.MathUtils.clamp((elv + 0.08) / 0.14, 0, 1);
    sky.apply(skyPal, sunD, moonD, horizonFade(sunElv), horizonFade(moonElv));
    // 体积光基调：黄昏/黎明最盛（长光路），白昼中等，夜里月亮的冷光最克制
    godState.base = THREE.MathUtils.lerp(a.shaftOpacity, b.shaftOpacity, u) * 10;
    godState.worldDir.copy(lead);
    (godPass.uniforms.uTint.value as THREE.Color)
      .set("#ffe3b0")
      .lerp(_uTintNight, skyPal.night);
    renderer.toneMappingExposure = THREE.MathUtils.lerp(a.exposure, b.exposure, u);
    // 萤火虫入夜点亮、光尘入夜淡出（写 uniform，见上面的说明）
    if (fireflyUniforms.uOpacity) {
      fireflyUniforms.uOpacity.value = 0.75 * THREE.MathUtils.clamp(skyPal.night * 1.6, 0.04, 1);
    }
    if (motesUniforms.uOpacity) {
      motesUniforms.uOpacity.value = 0.5 * (1 - skyPal.night * 0.85);
    }

    // 光照状态共享：披风透光/边缘光/所有自发光增益都跟着昼夜走
    lightState.sunDir.copy(sun.position).normalize();
    lightState.night = skyPal.night;
    // 雾也共享出去：自己写 GLSL 雾的模块（草地/水面）要跟着场景一起变
    lightState.fogColor.copy((scene.fog as THREE.FogExp2).color);
    lightState.fogDensity = (scene.fog as THREE.FogExp2).density;
    // 暖色度（黄昏/黎明高、白昼和深夜低）：水面波光与云的染色共用
    const warm = Math.pow(1 - skyPal.night, 2) * (1 - THREE.MathUtils.clamp((skyPal.sunEl - 0.4) / 0.4, 0, 1));
    _spec.copy(SPEC_DAY).lerp(SPEC_WARM, warm).lerp(SPEC_NIGHT, skyPal.night);
    const fog = scene.fog as THREE.FogExp2;
    _waterPhase.sunDir.copy(sun.position);
    _waterPhase.fogColor.copy(fog.color);
    _waterPhase.fogDensity = fog.density;
    _waterPhase.skyHi.copy(skyPal.zenith);
    _waterPhase.skyLo.copy(skyPal.horizon);
    _waterPhase.specColor.copy(_spec);
    _waterPhase.night = skyPal.night;
    water.setPhase(_waterPhase);
    clouds.setPhase(skyPal.night, warm);
    // 远岛剪影随相位染色：雾色与天空中段的混合再压暗（大气透视的层次）
    _silC.copy(fog.color).lerp(skyPal.mid, 0.5).multiplyScalar(0.8 - skyPal.night * 0.25);
    for (const m of farIslandMats) m.color.copy(_silC);
  }
  setDayPhase(0);

  return {
    scene,
    camera,
    composer,
    campfire: props.campfire,
    pulseFlowers: props.pulseFlowers,
    wind,
    bursts,
    addToScene: (obj) => scene.add(obj),
    render(dt, t, playerPos) {
      sky.update(t);
      water.update(t);
      clouds.update(t);
      updateGodRays();
      props.updates.forEach((u) => u(t));
      motes.update(t);
      fireflies.update(t);
      embers.rise(dt);
      composer.render();
    },
    resize,
    setDayPhase,
  };
}
