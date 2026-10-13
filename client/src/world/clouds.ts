import * as THREE from "three";
import { puffTexture } from "./fxtextures";
import { lightState } from "./lightstate";
import { desat } from "./toon";

/**
 * 云海 · 三代
 *
 * 二代是「每朵云 N 个 SpriteMaterial + N 个 Sprite」：全场景 272 个云 sprite，
 * 吃掉约 66% 的 draw call，透明排序每帧还要遍历 272 个对象；更要命的是
 * SpriteMaterial **完全不受光照**，贴图里只有 alpha 没有任何明暗信息 ——
 * 所以整朵云恒色，"蓬松体积感"在那套结构里根本做不出来。
 *
 * 三代把整片云海压成 **1 个 InstancedMesh（1 个 draw call）**：
 *
 *   1. billboard 在**顶点着色器**里做：实例矩阵只提供平移 + 缩放，**不含旋转**；
 *      把实例中心变换到视空间后，直接在视空间里按 quad 的 xy 铺开 —— 永远正对镜头。
 *      （若让实例矩阵带旋转，billboard 会被"再转一次"，云的朝向随实例旋转乱掉。）
 *   2. "体积感"在**片元着色器**里做：用 UV 反推半球法线（圆心正对镜头、边缘侧对
 *      镜头），对太阳做 lambert 受光，再叠一圈掠射边缘光当"厚度"。这是 impostor
 *      云唯一能产生"顶亮底暗 + 边缘受光"的办法。
 *   3. 排布改「平底花椰菜」：底部一圈小 puff 的**可见下缘正好落在基面**上（平底），
 *      顶部一簇大 puff 压在上面（花椰菜顶），整朵云再朝太阳侧水平偏置 12% 的 scale。
 *   4. 位置固定、只有缓慢风向漂移（不再绕原点公转 —— 那看起来像"云海围着你转"），
 *      飘浮是 t 的**绝对函数**而不是逐帧积分，帧率无关。
 *
 * 数量：26+8+6=40 朵 / 272 个 puff → 8+2+2=12 朵 / 88 个 puff。
 * 密度靠"单朵放大 + 重叠"补：云海单朵宽 1.1×S（S=140~210），角直径 40°~56°，
 * 8 朵按 45° 均布 → 环带基本闭合（原来那 26 朵全在 y=-8~-3.5、被不透明海面
 * 整片切掉，可见像素是 0，所以这一层是净增）。
 */

const TAU = Math.PI * 2;
/** 黄金角：让 puff 在圆盘里尽量散开，避免随机聚堆 */
const GOLDEN_ANGLE = 2.39996323;

/**
 * puff 的可见半径（相对 quad 边长）。
 * puffTexture() 的 alpha 在贴图半径 0.9 处已经归零 → 边长 s 的 quad 实际"占空间"
 * 的半径是 0.45·s。所有"底部不许越出基面"的判断都用这个常数，而不是 0.5·s ——
 * 留 10% 余量，因为贴图边缘还有那圈低频扰动削出来的缺口。
 */
const PUFF_VISIBLE_R = 0.45;

/**
 * 云海专用弱雾系数。
 * 场景雾是 FogExp2，白昼 0.0038 / 黄昏 0.0046 / 夜 0.0055；按 0.0046 算，
 * r=268 处雾权重 = 1-exp(-(0.0046·268)²) = 78% —— 远侧云海会被直接抹平成一片
 * 米色，团块结构完全消失。云海只吃 45%：同一位置权重降到 26%，结构保留。
 */
const CLOUD_FOG_SCALE = 0.45;
/** 取不到 scene.fog 时的兜底，与 scene.ts 的 new FogExp2(0xeecfa4, 0.0046) 一致 */
const FOG_FALLBACK_HEX = "#eecfa4";
const FOG_FALLBACK_DENSITY = 0.0046;

/**
 * 云亮度上限 = 霾色线性亮度 × 1.06。
 * 为什么要封顶：云是"被照亮的物体"不是光源，一旦比背后的天空亮，就会在地平线上
 * "跳出来"；而 lightstate.ts 写明 bloom 的亮度高通阈值是 0.8（且在 tone-map 之前
 * 作用于线性缓冲）。实测当前色板：白昼霾色(雾色)线性亮度 ≈0.73、白昼天空地平线
 * ≈0.81、黄昏霾色 ≈0.65、黄昏地平线 ≈0.73。所以云压到 1.06×霾色即恒在天空之下。
 */
const MAX_OVER_HAZE = 1.06;
/**
 * 夜间上限的绝对下限。
 * 夜雾 (#2a3354) 线性亮度只有 0.035，比夜空地平线 (#43507e ≈0.089) 还暗；
 * 若直接套用"霾色 × 1.06"，云会退化成和雾一样暗的空白（看不出有云）。
 * 0.075 仍低于夜空地平线，既保住"不亮过天空"，又让夜间云是可见的暗蓝灰剪影。
 */
const NIGHT_LUM_CAP = 0.075;
/**
 * 暗面亮度相对亮面的最大比例。
 * 0.70 是"高空看云底部"的实测取舍：0.56 时从云海下方看过去，整片云底是
 * 一块死灰的硬块（下表面的法线都朝下，天光项≈0，只剩 0.6·lamSun，而且几乎
 * 没有变化），贴在海面的亮霾上像一块剪影，边缘反而显硬。云底部其实是靠
 * **海面与天穹的反弹光**照亮的，所以底色必须抬到接近亮面 —— 光遇的云也是高调
 * （high-key）的：最暗处仍有亮面七成左右，靠这一点余量保住蓬松感。
 */
const MAX_SHADOW_RATIO = 0.7;

/**
 * 风：沿海平面的固定方向做**有界**漂移。
 * 不用"恒定速度 + 越界回绕"是因为回绕时整片云会瞬移一段（可见的跳变），
 * 恒定速度跑满 10 分钟昼夜周期还会把整圈云推过岛屿上空。正弦有界漂移峰值速度
 * ≈ WIND_AMP·2π/WIND_PERIOD = 0.54 m/s（慢风），永不出界、永无跳变。
 */
const WIND_DIR_X = -0.80;
const WIND_DIR_Z = -0.60;
const WIND_AMP = 18; // 位移幅度（米）
const WIND_PERIOD = 210; // 周期（秒）

/** 呼吸位移幅度/周期：0~1.5m（只向上，绝不把底部推下基面），周期 10~20s */
const BREATH_AMP_MIN = 0.5;
const BREATH_AMP_MAX = 1.5;
const BREATH_PERIOD_MIN = 10;
const BREATH_PERIOD_MAX = 20;

/** 受光面偏置：整朵云朝太阳侧水平偏移 12% 的 scale */
const SUN_BIAS_FRAC = 0.12;
/** 受光面偏置的方位低通时间常数（秒）：相位切换/初始化时不会"啪"地跳一下 */
const SUN_BIAS_TAU = 1.5;

/** 云海 y 范围（见下方 SEA_* 注释里的取舍理由），必须在 WATER_LEVEL 之上 */
const SEA_Y_MIN = 1.2;
const SEA_Y_MAX = 4.8;

/**
 * 云海（远环）的高度取舍：
 *
 * 硬约束：water.ts 的海面是 y = WATER_LEVEL = 0.55 的**不透明**平面
 * （transparent:false + depthWrite:true），半径 0~500。相机在水面之上，于是
 * "任何 y < 0.55 的片元"从相机发出的射线必然先穿过海面 → 深度测试直接丢弃。
 * 所以云海的可见下缘必须整体高于 0.55，否则不管放多远都会被切掉（原来的 26 朵
 * 低云在 y = -8 ~ -3.5，208/272 个 sprite 彻底不可见就是这个原因）。
 *
 * 选 y = 1.2 ~ 4.8 而不是任务书里的另一个备选 y = -1 ~ +3：
 *   - 下界 1.2：比海面高 0.65m。相机在 y≈4~6，远云的底缘刚好收在水天线上，
 *     "贴在水面上的一层云海"的观感就来自这个几乎贴地的高度。
 *   - 上界 4.8：给远侧一点前后层次，不至于是一张平板。
 *   - 若用 -1 ~ +3，则 -1 ~ 0.55 这一段仍在水下，海面会在云体**内部**切出一道
 *     水平硬边（切线的屏幕高度由该云的距离决定，不是地平线），柔边 puff 被
 *     切出刀口，很难看；而换成 1.2 只多花 0.65m 高度就完全避免。
 * 同时**丢掉半径 < 165 的近处那批**：它们本来就 100% 不可见，抬上来又会
 * 直接悬在岛头上；近景交给雾和海面。
 */

/**
 * 固定种子 PRNG（mulberry32）：云的布局必须可复现 —— 截图 A/B、复查同一朵云、
 * 数 puff 都要有同一个答案，Math.random 会给每次刷新不同的画面。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一朵云的形态 */
interface CloudShape {
  /** 云的整体宽度（世界米） */
  scale: number;
  /** puff 的竖向压扁比（sy = sx × squash）：云海层压扁、高空薄云压得更扁 */
  squash: number;
  /** 顶部大 puff 数（3~4） */
  top: number;
  /** 底部小 puff 数（4~6） */
  bottom: number;
}

export function createClouds(): {
  group: THREE.Group;
  update: (t: number, dt?: number) => void;
  setPhase: (night: number, dawn: number) => void; // night 夜晚度, dawn 暖色度(黄昏/黎明)
} {
  const group = new THREE.Group();
  const rnd = mulberry32(0x5eed1a7);

  // ---------------- 云的排布 ----------------
  // 云海 8 朵 × 8 puff = 64；中景 2 × 7 = 14；高空 2 × 5 = 10 —— 合计 88（≤90）
  const SEA_COUNT = 8;
  const SEA_PUFFS = 8;
  const MID_COUNT = 2;
  const MID_PUFFS = 7;
  const HIGH_COUNT = 2;
  const HIGH_PUFFS = 5;
  const TOTAL = SEA_COUNT * SEA_PUFFS + MID_COUNT * MID_PUFFS + HIGH_COUNT * HIGH_PUFFS;

  // 每实例的 CPU 侧数据。用并排的 Float32Array 而不是对象数组：
  // update() 每帧都要遍历一遍，扁平数组没有指针追逐、也不会产生垃圾。
  const basePos = new Float32Array(TOTAL * 3); // 固定位置（云本地 y=0 已换算成世界 y）
  const puffBiasR = new Float32Array(TOTAL); // 受光面偏置半径 = 0.12 × 该云的 scale
  const puffSeed = new Float32Array(TOTAL); // 呼吸相位
  const puffOmega = new Float32Array(TOTAL); // 呼吸角频率
  const puffAmpY = new Float32Array(TOTAL); // 呼吸幅度
  const attrSeed = new Float32Array(TOTAL);
  const attrTint = new Float32Array(TOTAL * 3);
  const attrOpacity = new Float32Array(TOTAL);
  const attrSize = new Float32Array(TOTAL);

  const geo = new THREE.PlaneGeometry(1, 1);
  const instMatrix = new Float32Array(TOTAL * 16);
  let n = 0;

  /**
   * 写入一个 puff：位置 + quad 尺寸 + 实例属性。
   * 实例矩阵手写（列主序，[0]/[5]/[10] 是各轴缩放、[12..14] 是平移、[15]=1）：
   * 只给平移+缩放、**不给旋转**，billboard 才不会被重复旋转。
   */
  const emit = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    tint: number,
    opacity: number,
    seed: number,
    ampY: number,
    omega: number,
    biasR: number
  ) => {
    const o = n * 16;
    instMatrix[o] = sx;
    instMatrix[o + 5] = sy;
    instMatrix[o + 10] = 1;
    instMatrix[o + 12] = x;
    instMatrix[o + 13] = y;
    instMatrix[o + 14] = z;
    instMatrix[o + 15] = 1;

    basePos[n * 3] = x;
    basePos[n * 3 + 1] = y;
    basePos[n * 3 + 2] = z;
    puffBiasR[n] = biasR;
    puffSeed[n] = seed;
    puffOmega[n] = omega;
    puffAmpY[n] = ampY;
    attrSeed[n] = rnd() * TAU;
    attrTint[n * 3] = tint;
    attrTint[n * 3 + 1] = tint;
    attrTint[n * 3 + 2] = tint;
    attrOpacity[n] = opacity;
    attrSize[n] = sx;
    n++;
  };

  /** 生成一朵云：底部一圈小 puff 贴着基面 + 顶部一簇大 puff 压上去 */
  const buildCloud = (
    cx: number,
    baseY: number,
    cz: number,
    shape: CloudShape,
    topTint: number,
    bottomTint: number,
    topAlpha: number,
    bottomAlpha: number
  ) => {
    const S = shape.scale;
    const squash = shape.squash;
    const biasR = SUN_BIAS_FRAC * S; // 受光面偏置：整朵云一起偏移，不是逐 puff 各自偏

    // 顶部大 puff：比底部大一圈，负责"花椰菜"的隆起轮廓
    const sxTop = S * (0.42 + rnd() * 0.10);
    const yTop = sxTop * squash * PUFF_VISIBLE_R * 1.35;
    for (let i = 0; i < shape.top; i++) {
      const a = i * GOLDEN_ANGLE + rnd() * 0.5;
      const r = S * 0.24 * Math.sqrt(rnd());
      const sx = sxTop * (0.88 + rnd() * 0.24);
      const sy = sx * squash;
      emit(
        cx + Math.cos(a) * r,
        baseY + yTop + rnd() * sy * 0.12,
        cz + Math.sin(a) * r,
        sx,
        sy,
        topTint * (0.94 + rnd() * 0.06), // 顶面本身就亮一点（顶亮底暗的一半来自这里）
        topAlpha * (0.88 + rnd() * 0.24),
        rnd() * TAU,
        BREATH_AMP_MIN + rnd() * (BREATH_AMP_MAX - BREATH_AMP_MIN),
        TAU / (BREATH_PERIOD_MIN + rnd() * (BREATH_PERIOD_MAX - BREATH_PERIOD_MIN)),
        biasR
      );
    }

    // 底部小 puff：y 取 "sy × 可见半径"，也就是**可见下缘正好压在基面**上。
    // 这是"平底"的全部秘密 —— 不是把云切成平面，而是让每个 puff 与基面相切。
    const sxBot = S * (0.26 + rnd() * 0.06);
    for (let i = 0; i < shape.bottom; i++) {
      const a = i * GOLDEN_ANGLE + rnd() * 0.6;
      const r = S * 0.40 * Math.sqrt(rnd());
      const sx = sxBot * (0.85 + rnd() * 0.3);
      const sy = sx * squash;
      emit(
        cx + Math.cos(a) * r,
        baseY + sy * PUFF_VISIBLE_R,
        cz + Math.sin(a) * r,
        sx,
        sy,
        bottomTint * (0.92 + rnd() * 0.10),
        bottomAlpha * (0.9 + rnd() * 0.2),
        rnd() * TAU,
        BREATH_AMP_MIN + rnd() * (BREATH_AMP_MAX - BREATH_AMP_MIN),
        TAU / (BREATH_PERIOD_MIN + rnd() * (BREATH_PERIOD_MAX - BREATH_PERIOD_MIN)),
        biasR
      );
    }
  };

  // ---- 高空薄云（先写：单 mesh 内只能按实例顺序混合，远/高的先画才不会盖住近处）----
  for (let i = 0; i < HIGH_COUNT; i++) {
    const a = rnd() * TAU;
    const r = 200 + rnd() * 180;
    buildCloud(
      Math.cos(a) * r,
      60 + rnd() * 35,
      Math.sin(a) * r,
      { scale: 160 + rnd() * 80, squash: 0.34, top: 2, bottom: 3 },
      0.98,
      0.86,
      0.16 + rnd() * 0.08,
      0.13 + rnd() * 0.07
    );
  }

  // ---- 中景 ----
  for (let i = 0; i < MID_COUNT; i++) {
    const a = rnd() * TAU;
    const r = 120 + rnd() * 80;
    buildCloud(
      Math.cos(a) * r,
      14 + rnd() * 12,
      Math.sin(a) * r,
      { scale: 90 + rnd() * 40, squash: 0.58, top: 3, bottom: 4 },
      1.0,
      0.9,
      0.34 + rnd() * 0.10,
      0.30 + rnd() * 0.10
    );
  }

  // ---- 云海（远环）----
  // 方位按 45° 均布 + 小抖动，半径/宽度随机；先按半径从大到小排，保证远处的先混合。
  const seaSlots: { x: number; z: number; y: number; s: number; r: number }[] = [];
  for (let i = 0; i < SEA_COUNT; i++) {
    const a = (i / SEA_COUNT) * TAU + (rnd() - 0.5) * 0.24;
    const r = 175 + rnd() * 125;
    seaSlots.push({
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      y: SEA_Y_MIN + rnd() * (SEA_Y_MAX - SEA_Y_MIN),
      s: 140 + rnd() * 70,
      r,
    });
  }
  seaSlots.sort((a, b) => b.r - a.r);
  for (const s of seaSlots) {
    // squash 0.58：这是"云海"和"糊满整片天"的分界。实测 0.80 时云海单朵高约 90m，
    // 8 朵 + 中景 + 高空叠起来会把整片天空铺满，地平线上只剩一层均匀的米色"纱"
    // （整屏区域亮度方差几乎为 0），完全失去"云"的轮廓；0.55~0.60 时它才是贴着
    // 水天线的一条云带。不透明度 0.40~0.60：8 个 puff 互相重叠，单层再高一点内部
    // alpha 就饱和成一整块死白，团块感全部消失（柔边靠重叠堆出来，不靠单层不透明）。
    buildCloud(
      s.x,
      s.y,
      s.z,
      { scale: s.s, squash: 0.58, top: 4, bottom: 4 },
      1.0,
      0.86,
      0.46 + rnd() * 0.14,
      0.40 + rnd() * 0.14
    );
  }

  if (n !== TOTAL) throw new Error(`云 puff 预算错位：写入 ${n} ≠ 预算 ${TOTAL}`);

  // ---------------- 材质 ----------------
  const uniforms = {
    uMap: { value: puffTexture() },
    uSunDir: { value: new THREE.Vector3().copy(lightState.sunDir) },
    uCloudLit: { value: new THREE.Color("#fff6ea") },
    uCloudShadow: { value: new THREE.Color("#8e9ab4") },
    uRimColor: { value: new THREE.Color("#ffffff") },
    uOpacity: { value: 1 },
    uFogColor: { value: new THREE.Color(FOG_FALLBACK_HEX) },
    uFogDensity: { value: FOG_FALLBACK_DENSITY * CLOUD_FOG_SCALE },
  };

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false, // 云的 alpha 是柔边，写深度会把后续 puff 整片剔掉，硬边立刻出现
    depthTest: true, // 但仍要被不透明物（海面/地形）遮挡
    uniforms,
    vertexShader: /* glsl */ `
      uniform vec3 uSunDir;
      attribute float aSeed;
      attribute vec3 aTint;
      attribute float aOpacity;
      attribute float aSize;

      varying vec2 vUv;
      varying vec2 vQ;
      varying vec3 vTint;
      varying float vOpacity;
      varying float vSize;
      varying vec3 vSunView;
      varying vec3 vUpView;
      varying vec3 vViewPos;

      void main() {
        vUv = uv;
        vTint = aTint;
        vOpacity = aOpacity;
        vSize = aSize;

        // uv → 以 quad 中心为原点的 [-1,1]²：片元里要用它反推半球法线。
        // 顺手用 aSeed 给每个 puff 一个固定的法线倾斜（±0.15 rad）：88 个 puff 的
        // 受光面如果完全一致，一眼就看出是同一个模板复制出来的，倾斜后明暗有了
        // 个体差异（旋转是线性变换，在顶点里转再插值 = 在片元里转，白拿）。
        vec2 q = uv * 2.0 - 1.0;
        float tilt = sin(aSeed) * 0.15;
        float ct = cos(tilt);
        float st = sin(tilt);
        vQ = vec2(q.x * ct - q.y * st, q.x * st + q.y * ct);

        // 太阳方向转到**视空间**再传给片元：片元里的半球法线用的是视空间轴
        // （x=镜头右、y=镜头上、z=朝镜头）。两者不在同一坐标系里点乘，镜头一转
        // 受光面就会在屏幕上左右摆。viewMatrix 由 three 每帧自动喂入。
        vSunView = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
        // 世界"上"方向也转到视空间：片元拿它算天光，保证"顶亮底暗"永远成立
        vUpView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);

        // 实例矩阵只有平移 + 缩放，所以列向量长度就是各轴缩放
        vec3 iScale = vec3(
          length(instanceMatrix[0].xyz),
          length(instanceMatrix[1].xyz),
          length(instanceMatrix[2].xyz)
        );
        vec4 centerView = modelViewMatrix * (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0));
        // billboard：在**视空间**里把 quad 的 xy 铺开，永远正对镜头
        centerView.xy += position.xy * iScale.xy;
        vViewPos = centerView.xyz;
        gl_Position = projectionMatrix * centerView;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uCloudLit;
      uniform vec3 uCloudShadow;
      uniform vec3 uRimColor;
      uniform float uOpacity;
      uniform vec3 uFogColor;
      uniform float uFogDensity;

      varying vec2 vUv;
      varying vec2 vQ;
      varying vec3 vTint;
      varying float vOpacity;
      varying float vSize;
      varying vec3 vSunView;
      varying vec3 vUpView;
      varying vec3 vViewPos;

      void main() {
        vec4 tex = texture2D(uMap, vUv);
        if (tex.a < 0.004) discard; // 云占屏比例大，先丢掉完全透明的片元省混合带宽

        // UV → 半球法线：这是"贴纸"和"体积团块"的分界。
        // r=0 处 n=(0,0,1) 正对镜头（受光面），r=1 处 n.z→0 侧对镜头（掠射面）。
        // （vQ 就是顶点里算好的 vUv*2-1 并叠了 aSeed 倾斜；不倾斜时与它完全等价。）
        vec2 q = vQ;
        float r2 = min(1.0, dot(q, q));
        vec3 n = normalize(vec3(q, sqrt(max(0.0, 1.0 - r2))));
        vec3 V = normalize(-vViewPos);

        // 半球受光由两项组成：
        //   lamSky —— 天光（世界正上方）。它保证"顶亮底暗"在任何时刻都成立，
        //             这也是云有体积感的**主要**来源（光遇的云就是被天穹从上面照亮的）。
        //             另一层保险：黎明/黄昏的换灯瞬间，scene.ts 的日月都没升起来，
        //             太阳方向会退化成竖直向下，只靠 lamSun 会让整朵云变成一块死平板。
        //   lamSun —— 太阳（夜=月亮）方位光，给受光面/背光面的**方位**对比。
        // +0.5 偏置是"环境光地板"：背光面也不死黑（光遇的暗部被环境抬得很高）。
        float lamSky = dot(n, vUpView) * 0.5 + 0.5;
        float lamSun = dot(n, vSunView) * 0.5 + 0.5;
        float lam = mix(lamSky, lamSun, 0.6);
        vec3 col = mix(uCloudShadow, uCloudLit, pow(lam, 1.2));
        // 掠射边缘光 = "厚度"：只看 n·V，与太阳无关，所以整圈轮廓都有一层发亮的边
        float sizeN = clamp(vSize / 160.0, 0.0, 1.0);
        float rimW = 3.0 - 0.6 * sizeN; // 大团 puff 边缘更宽更柔，小团更紧
        col += uRimColor * pow(1.0 - max(dot(n, V), 0.0), rimW) * 0.35;
        col *= vTint;

        float a = tex.a * vOpacity * uOpacity;

        // 云海专用弱雾（density × 0.45）：rgb 混向雾色的同时按 (1-雾权重) 收 alpha，
        // 这样远处云是"融进霾里消失"，而不是糊成一块米色贴纸。
        float fd = uFogDensity * length(vViewPos);
        float fogF = 1.0 - exp(-fd * fd);
        col = mix(col, uFogColor, fogF);
        a *= (1.0 - fogF);

        gl_FragColor = vec4(col, a);
      }
    `,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, TOTAL);
  mesh.name = "cloudSea";
  // 云的几何体只是原点处的一张单位 quad，包围球半径 <1：靠包围球做视锥剔除会在
  // 原点离开视野时把整片云剔掉（billboard 的展开是在顶点着色器里做的，CPU 不知道）。
  mesh.frustumCulled = false;
  // 半透明按 renderOrder + 深度排序；而本 mesh 的世界坐标是**原点**（岛心），
  // 在相机眼里是"最近"的透明物 → 不指定的话它会被排到最后画，把玩家身上的
  // 加法光效（风线/牵手光带/光尘）再糊一遍。云是背景，先画。
  mesh.renderOrder = -1;
  // 云的实例矩阵每帧都要改（漂移/呼吸/受光面偏置），显式声明为动态用法
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  (mesh.instanceMatrix.array as Float32Array).set(instMatrix);
  mesh.instanceMatrix.needsUpdate = true;

  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(attrSeed, 1));
  geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(attrTint, 3));
  geo.setAttribute("aOpacity", new THREE.InstancedBufferAttribute(attrOpacity, 1));
  geo.setAttribute("aSize", new THREE.InstancedBufferAttribute(attrSize, 1));

  group.add(mesh);

  // ---------------- 昼夜调色 ----------------
  // 三组基色：白昼 → 黄昏/黎明（玫瑰金）→ 夜（月光蓝灰），与原来 setPhase 的结构一致。
  // 暗面统一走 desat：云的底面只有环境光，去饱和 + 偏冷蓝才像"被天空照亮的下巴"，
  // 也顺带和 toon.ts 的全项目降饱和色板对齐。
  const DAY_LIT = new THREE.Color("#fff6ea");
  const DAY_DUSK_LIT = new THREE.Color("#ffd8ae");
  const NIGHT_LIT = new THREE.Color("#55618c");
  const DAY_SHADOW = desat(new THREE.Color("#8e9ab4"), 0.3);
  const DUSK_SHADOW = desat(new THREE.Color("#7a6f96"), 0.3);
  const NIGHT_SHADOW = desat(new THREE.Color("#232c47"), 0.3);

  const _lit = new THREE.Color();
  const _shadow = new THREE.Color();
  const _rim = new THREE.Color();
  /** 线性相对亮度：封顶用 */
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  // update() 用到的状态
  let lastT = 0;
  // 受光面偏置的方位直接以当前太阳方位起步（否则开局头 1.5 秒云会从"不偏"滑到"偏"）
  const sunXZ = Math.hypot(lightState.sunDir.x, lightState.sunDir.z) || 1;
  let biasX = lightState.sunDir.x / sunXZ;
  let biasZ = lightState.sunDir.z / sunXZ;
  const litU = uniforms.uCloudLit.value;
  const shadowU = uniforms.uCloudShadow.value;
  const rimU = uniforms.uRimColor.value;
  const fogU = uniforms.uFogColor.value;

  /** 每帧同步雾（淡色 + 弱密度）：云海要跟场景雾一致，否则昼夜切换时云会自己变色 */
  const syncFog = () => {
    const parent = group.parent;
    const fog = parent instanceof THREE.Scene ? parent.fog : null;
    if (fog instanceof THREE.FogExp2) {
      fogU.copy(fog.color);
      uniforms.uFogDensity.value = fog.density * CLOUD_FOG_SCALE;
    }
  };

  return {
    group,
    /**
     * @param t  场景时钟（秒），scene.ts:424 `clouds.update(t)` 传的就是它
     * @param dt 可选帧长（秒）。不传时用 t 的差分兜底 —— 保证运动与帧率无关。
     *           （2026 现状：唯一调用点 scene.ts 只传 t；签名保持向后兼容。）
     */
    update: (t: number, dt?: number) => {
      const d = Math.min(dt !== undefined ? dt : t - lastT, 0.1);
      lastT = t;
      const step = d > 0 ? d : 1 / 60;

      // 受光面偏置的方位：低通跟踪当前太阳方位（xz 归一化），时间常数 SUN_BIAS_TAU。
      // 用 exp(-d/τ) 而不是固定系数，切帧率时收敛速度才不会变。
      const sx = lightState.sunDir.x;
      const sz = lightState.sunDir.z;
      const len = Math.sqrt(sx * sx + sz * sz) || 1;
      const k = 1 - Math.exp(-step / SUN_BIAS_TAU);
      biasX += (sx / len - biasX) * k;
      biasZ += (sz / len - biasZ) * k;

      // 风：**绝对赋值**（t 的函数），不是逐帧累加 —— 帧率抖动不会留下永久偏移
      const windP = (t / WIND_PERIOD) * TAU;
      const wLen = Math.sqrt(WIND_DIR_X * WIND_DIR_X + WIND_DIR_Z * WIND_DIR_Z);
      const windX = (WIND_DIR_X / wLen) * Math.sin(windP) * WIND_AMP;
      const windZ = (WIND_DIR_Z / wLen) * Math.sin(windP) * WIND_AMP;

      const m = mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < TOTAL; i++) {
        // 呼吸：0 ~ amp 的**非负**正弦。取非负是因为 puff 的可见下缘正好切在基面上
        // （"平底"），向下摆会立刻把底部推过基面；同时它也是 t 的绝对函数。
        const breath = (0.5 + 0.5 * Math.sin(t * puffOmega[i] + puffSeed[i])) * puffAmpY[i];
        const o = i * 16;
        const br = puffBiasR[i];
        m[o + 12] = basePos[i * 3] + windX + biasX * br;
        m[o + 13] = basePos[i * 3 + 1] + breath;
        m[o + 14] = basePos[i * 3 + 2] + windZ + biasZ * br;
      }
      // 只改了平移，其余元素（各轴缩放、[15]）保持不变 —— 实例矩阵是原地更新，无分配
      mesh.instanceMatrix.needsUpdate = true;
    },
    // 云色随昼夜：白昼亮白 → 黄昏/黎明染玫瑰金 → 夜晚沉入暗蓝灰（比天穹稍亮，月光感）
    setPhase: (night: number, dawn: number) => {
      syncFog();
      uniforms.uSunDir.value.copy(lightState.sunDir);

      _lit.copy(DAY_LIT).lerp(DAY_DUSK_LIT, dawn).lerp(NIGHT_LIT, night);
      _shadow.copy(DAY_SHADOW).lerp(DUSK_SHADOW, dawn).lerp(NIGHT_SHADOW, night);
      // 云被大气包裹：混进霾色才不会像"贴上去的白纸"
      _lit.lerp(fogU, 0.35);
      _shadow.lerp(fogU, 0.34);

      // 封顶：云不许亮过背后的天空（夜晚另给一个下限，见 NIGHT_LUM_CAP）
      const cap = THREE.MathUtils.lerp(lum(fogU) * MAX_OVER_HAZE, NIGHT_LUM_CAP, night);
      const litLum = lum(_lit);
      if (litLum > cap) _lit.multiplyScalar(cap / litLum);
      // 暗面压到亮面的一定比例内：保证"顶亮底暗"始终可读
      const shadowLum = lum(_shadow);
      const shadowCap = lum(_lit) * MAX_SHADOW_RATIO;
      if (shadowLum > shadowCap) _shadow.multiplyScalar(shadowCap / shadowLum);

      // 边缘光取 (亮面-暗面) 的 42%：加完仍落在明暗区间里，不会把云顶到天空之上
      _rim.copy(_lit).sub(_shadow).multiplyScalar(0.42);

      litU.copy(_lit);
      shadowU.copy(_shadow);
      rimU.copy(_rim);
      // 夜里稍薄一点，让月光和星星能透出来
      uniforms.uOpacity.value = 1 - 0.1 * night;
    },
  };
}
