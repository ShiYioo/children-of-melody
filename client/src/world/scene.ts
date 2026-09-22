import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createSky, type SkyPalette } from "./sky";
import { createTerrain } from "./terrain";
import { createWater } from "./water";
import { createClouds } from "./clouds";
import { createProps, type Campfire } from "./props";
import { createToonKit } from "./toon";
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
  const renderer = new THREE.WebGLRenderer({ antialias: !mobile, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

  // ---- 后期：体积光 → Bloom → 输出 ----
  const composer = new EffectComposer(renderer);
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
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  };
  window.addEventListener("resize", resize);

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
      sky: { zenith: C("#0c1230"), mid: C("#1a2248"), rose: C("#2c3560"), horizon: C("#43507e"), sea: C("#26304f"), night: 1, sunEl: 0.5 },
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
  const fireflyMat = fireflies.points.material as THREE.PointsMaterial;

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
    skyPal.night = THREE.MathUtils.lerp(a.sky.night, b.sky.night, u);
    skyPal.sunEl = THREE.MathUtils.lerp(a.sky.sunEl, b.sky.sunEl, u);
    mixC(a.sunColor, b.sunColor, sun.color);
    sun.intensity = THREE.MathUtils.lerp(a.sunInt, b.sunInt, u);

    // ---- 实时日月轨道：位置由时钟连续算出，光源、天空圆盘、光柱、水面波光跟随天体 ----
    // 弧线区间必须严格卡在色板相位上，否则会出现"黎明的暖光从月亮方向照来"的错位：
    // 太阳 p∈[0.5,1.0]（黎明相位升起→黄昏相位落下），月亮 p∈[0.12,0.48]（入夜升→黎明前落）
    const sunT = (p - 0.5) / 0.5;
    const moonT = (p - 0.12) / 0.36;
    const arcDir = (t: number, maxEl: number, azBase: number, azSpan: number) => {
      const elv = Math.sin(t * Math.PI) * maxEl;
      const az = azBase + (t - 0.5) * azSpan;
      return new THREE.Vector3(Math.sin(az) * Math.cos(elv), Math.sin(elv), Math.cos(az) * Math.cos(elv));
    };
    const sunUp = sunT >= 0 && sunT <= 1;
    const moonUp = moonT >= 0 && moonT <= 1;
    const sunD = sunUp ? arcDir(sunT, 0.95, -0.35, 2.8) : new THREE.Vector3(0, -1, 0);
    const moonD = moonUp ? arcDir(moonT, 0.8, 2.6, -2.2) : new THREE.Vector3(0, -1, 0);
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
      .lerp(new THREE.Color("#c9d6ff"), skyPal.night);
    renderer.toneMappingExposure = THREE.MathUtils.lerp(a.exposure, b.exposure, u);
    // 萤火虫入夜点亮（白天几乎看不见），白天光尘入夜淡出（萤火虫接管）
    fireflyMat.opacity = 0.75 * THREE.MathUtils.clamp(skyPal.night * 1.6, 0.04, 1);
    (motes.points.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.5 * (1 - skyPal.night * 0.85);

    // 光照状态共享：披风透光/边缘光强度跟着太阳走
    lightState.sunDir.copy(sun.position).normalize();
    lightState.night = skyPal.night;
    // 暖色度（黄昏/黎明高、白昼和深夜低）：水面波光与云的染色共用
    const warm = Math.pow(1 - skyPal.night, 2) * (1 - THREE.MathUtils.clamp((skyPal.sunEl - 0.4) / 0.4, 0, 1));
    const spec = SPEC_DAY.clone().lerp(SPEC_WARM, warm).lerp(SPEC_NIGHT, skyPal.night);
    water.setPhase({
      sunDir: sun.position,
      fogColor: (scene.fog as THREE.FogExp2).color,
      fogDensity: (scene.fog as THREE.FogExp2).density,
      skyHi: skyPal.zenith,
      skyLo: skyPal.horizon,
      specColor: spec,
      night: skyPal.night,
    });
    clouds.setPhase(skyPal.night, warm);
    // 远岛剪影随相位染色：雾色与天空中段的混合再压暗（大气透视的层次）
    const silC = (scene.fog as THREE.FogExp2).color.clone().lerp(skyPal.mid, 0.5).multiplyScalar(0.8 - skyPal.night * 0.25);
    for (const m of farIslandMats) m.color.copy(silC);
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
