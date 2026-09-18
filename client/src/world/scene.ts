import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createSky } from "./sky";
import { createTerrain } from "./terrain";
import { createWater } from "./water";
import { createClouds } from "./clouds";
import { createProps, type Campfire } from "./props";
import { createToonKit } from "./toon";
import { createMotes, createFireflies, createEmbers } from "./particles";

export interface World {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  campfire: Campfire;
  addToScene: (obj: THREE.Object3D) => void;
  render: (dt: number, t: number) => void;
  resize: () => void;
}

export function createWorld(container: HTMLElement): World {
  // ---- 渲染器 ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  sun.shadow.mapSize.set(2048, 2048);
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

  const kit = createToonKit();
  const props = createProps(kit);
  scene.add(props.group);

  const motes = createMotes();
  scene.add(motes.points);
  const fireflies = createFireflies();
  scene.add(fireflies.points);
  const embers = createEmbers();
  scene.add(embers.points);

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

  return {
    scene,
    camera,
    composer,
    campfire: props.campfire,
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
  };
}
