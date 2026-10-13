import * as THREE from "three";
import { lightState } from "./lightstate";

/**
 * 菲涅尔边缘光（轮廓光）—— 全场景统一的「逆光勾边」美术语言。
 *
 * 为什么单独成一个模块：这套边光最早只有 GLB 角色和程序化披风有，
 * 于是「角色有边、道具没边」；要把它铺到道具上时，如果让 props 反过来去
 * import avatar，依赖方向就反了（道具不该知道角色的存在）。
 * 放在这里两边都能用，且只有这一个地方推进颜色。
 *
 * 注入点是**同一个**、对 `MeshStandardMaterial` 与 `MeshToonMaterial` 都成立：
 * 两者的片元着色器都声明了 `varying vec3 vViewPosition`，
 * 也都带 `#include <fog_fragment>`，所以在 `void main()` 之后、
 * fog 之前插一段就能同时覆盖两种材质。
 */
const RIM_DAY = new THREE.Color("#ffd9a8");
const RIM_NIGHT = new THREE.Color("#aebfff");

/**
 * 完全顺光时残留的边光比例（逆光系数 = `mix(RIM_BACK_FLOOR, 1.0, 逆光度)`）。
 *
 * 取 0.35 而不是 0：边光同时是**造型手段**，不只是"光效"。顺光时若边光归零，
 * 角色的肩线、披风边缘、道具轮廓会一起糊进背景里，整个人像纸片一样塌下去 ——
 * 光遇的顺光镜头里轮廓也是清楚的，只是"亮得像自发光"那种假边没有了。
 */
const RIM_BACK_FLOOR = 0.35;

/** 共享 uniforms：所有被注入的材质引用**同一批**对象，改一处全场景同时变 */
export const rimColorUni = { value: RIM_DAY.clone() };
export const rimIntUni = { value: 0.3 };

/**
 * 太阳（夜里是月亮）方向：**世界空间**、由物体指向光源，与 `lightState.sunDir` 同源。
 *
 * 必须和另外两个 uniform 一样是**全场景共享的同一个对象**：`onBeforeCompile` 里
 * 把它挂进每个材质的 uniforms 表，所以太阳一转，108 个道具材质一起转，
 * 而 program 依然只有一份（program 的缓存键是材质状态 + `onBeforeCompile.toString()`，
 * 与 uniform 的取值无关；只要这里始终是同一个函数、同一个对象，就不会分裂）。
 *
 * 为什么不直接用 three 已经算好的 `directionalLights[0].direction`（本来就是视图空间）：
 * 那个结构体定义在 `#if NUM_DIR_LIGHTS > 0` 里，一旦某个变体编译成"没有平行光"
 * （阴影/特殊通道、以后换个场景），整个片元着色器会直接编译失败；
 * 自带 uniform 则永远存在。代价是片元里多一次 `viewMatrix * vec4`（4 乘 3 加），可以忽略。
 */
export const rimSunUni = { value: lightState.sunDir.clone() };

/** 每帧推进一次边光的颜色、强度与太阳方向（昼暖夜冷，夜里更亮一点以勾出轮廓） */
export function updateRim(): void {
  rimColorUni.value.lerpColors(RIM_DAY, RIM_NIGHT, lightState.night);
  rimIntUni.value = 0.26 + 0.18 * (1 - lightState.night);
  // 太阳/月亮方向每帧同步（scene.setDayPhase 每帧写 lightState.sunDir，
  // 这里只是 copy 一次三分量，没有新建对象、没有逐材质 setValue）
  rimSunUni.value.copy(lightState.sunDir);
}

/** 给材质注入菲涅尔边缘光（幂等：同一个材质对象只会被注入一次） */
export function patchRimMaterial(mat: THREE.Material): void {
  // 显式读标志位：写成 `A | B` 联合类型时 TS 会把对方的标志位窄化成 never
  const flags = mat as unknown as {
    isMeshStandardMaterial?: boolean;
    isMeshToonMaterial?: boolean;
    __rimmed?: boolean;
  };
  if ((!flags.isMeshStandardMaterial && !flags.isMeshToonMaterial) || flags.__rimmed) return;
  // 这里用「在材质自身上打标记」是**正确**的：patchRimMaterial 是**原地修改**
  // 这个材质对象（写 onBeforeCompile），不像 GLB 材质统一那样会另建新对象。
  // 所以标记如实反映「这个材质已经被注入过」。
  flags.__rimmed = true;
  const m = mat as THREE.MeshStandardMaterial;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = rimColorUni;
    shader.uniforms.uRimInt = rimIntUni;
    shader.uniforms.uRimSunDir = rimSunUni;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        "uniform vec3 uRimColor;\nuniform float uRimInt;\nuniform vec3 uRimSunDir;\nvoid main() {"
      )
      .replace(
        "#include <fog_fragment>",
        /* glsl */ `
        // ---- 菲涅尔边缘光：视角掠过表面处泛起的光边（光遇的逆光轮廓） ----
        float rimF = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);

        // ---- 逆光系数：太阳在物体背后时边光才强，顺光时只剩一点保形 ----
        // 空间：normal 与 vViewPosition 都在**视图空间**（three 的
        //   normal_fragment_begin 用 normalMatrix 转过，vViewPosition = -mvPosition.xyz），
        //   而 uRimSunDir 是世界空间、指向光源，所以先用内建 viewMatrix 转到视图空间。
        // 符号：vViewPosition 是「片元 → 相机」，太阳方向是「片元 → 光源」。
        //   两者反向（dot ≈ -1）＝相机在看背光的那一面 → 逆光，故取 max(0, -dot)。
        //   反过来若写成 +dot，就变成"太阳在相机背后（顺光）时边光最亮"，
        //   正是要修掉的探照灯假边 —— 所以这个负号是这段的全部。
        vec3 rimV = normalize(vViewPosition);
        vec3 rimSunV = normalize((viewMatrix * vec4(uRimSunDir, 0.0)).xyz);
        float rimBack = clamp(-dot(rimV, rimSunV), 0.0, 1.0);

        gl_FragColor.rgb += uRimColor * (rimF * uRimInt * mix(${RIM_BACK_FLOOR}, 1.0, rimBack));
        #include <fog_fragment>`
      );
  };
}
