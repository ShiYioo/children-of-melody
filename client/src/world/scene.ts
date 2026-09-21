import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
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

export interface World {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  campfire: Campfire;
  wind: ReturnType<typeof createWindLines>;
  bursts: ReturnType<typeof createBursts>;
  addToScene: (obj: THREE.Object3D) => void;
  render: (dt: number, t: number) => void;
  resize: () => void;
  /** 昼夜循环：phase 0~1（0 黄昏 → 0.25 夜 → 0.5 黎明 → 0.75 白昼），全部客户端按同一时钟对齐 */
  setDayPhase: (phase: number) => void;
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
  sun.shadow.camera.left = -80;
  sun.shadow.camera.right = 80;
  sun.shadow.camera.top = 80;
  sun.shadow.camera.bottom = -80;
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

  // ---- 从太阳方向斜射下来的柔光柱（丁达尔） ----
  const sunDir = new THREE.Vector3(-0.62, 0.3, -0.42).normalize();
  const shafts = new THREE.Group();
  const shaftMat = new THREE.MeshBasicMaterial({
    color: "#ffedc4",
    transparent: true,
    opacity: 0.05,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
  const shaftGeo = new THREE.PlaneGeometry(3.2, 60);
  for (let i = 0; i < 9; i++) {
    const m = new THREE.Mesh(shaftGeo, shaftMat);
    const along = -14 + Math.random() * 40;
    m.position.set(-30 + along * -0.62 + (Math.random() - 0.5) * 26, 16 + Math.random() * 6, -20 + along * -0.42 + (Math.random() - 0.5) * 26);
    m.lookAt(m.position.clone().sub(sunDir.clone().multiplyScalar(30)));
    m.rotateX(Math.PI / 2);
    m.scale.set(0.6 + Math.random(), 1, 1);
    shafts.add(m);
  }
  scene.add(shafts);

  // ---- 后期：柔光 Bloom，让火焰/灯塔/光尘发出光遇式的柔辉 ----
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.58, // strength
    0.9, // radius
    0.72 // threshold
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
    sky.apply(skyPal);

    mixC(a.fogColor, b.fogColor, (scene.fog as THREE.FogExp2).color);
    (scene.fog as THREE.FogExp2).density = THREE.MathUtils.lerp(a.fogDensity, b.fogDensity, u);
    mixC(a.hemiSky, b.hemiSky, hemi.color);
    mixC(a.hemiGround, b.hemiGround, hemi.groundColor);
    hemi.intensity = THREE.MathUtils.lerp(a.hemiInt, b.hemiInt, u);
    mixC(a.ambientColor, b.ambientColor, ambient.color);
    ambient.intensity = THREE.MathUtils.lerp(a.ambientInt, b.ambientInt, u);
    mixC(a.sunColor, b.sunColor, sun.color);
    sun.intensity = THREE.MathUtils.lerp(a.sunInt, b.sunInt, u);
    sun.position.lerpVectors(a.sunPos, b.sunPos, u);
    shaftMat.opacity = THREE.MathUtils.lerp(a.shaftOpacity, b.shaftOpacity, u);
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
    wind,
    bursts,
    addToScene: (obj) => scene.add(obj),
    render(dt, t) {
      sky.update(t);
      water.update(t);
      clouds.update(t);
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
