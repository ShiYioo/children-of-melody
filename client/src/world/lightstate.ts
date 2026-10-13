import * as THREE from "three";

/**
 * 全局光照状态：scene.setDayPhase 每帧写入，渲染层（水面/云）与角色层
 * （披风透光/边缘光/接触阴影）以及所有特效模块都从这里读——
 * 避免 avatar / fx 反向 import scene。
 */
export const lightState = {
  /** 太阳（夜=月亮）方向，指向光源 */
  sunDir: new THREE.Vector3(-0.62, 0.17, -0.42).normalize(),
  /** 夜晚度 0~1（0 纯白天 1 深夜） */
  night: 0,

  /**
   * 当前场景雾（由 scene.setDayPhase 每帧写入）。
   *
   * 给那些**自己写 GLSL 雾**的模块用（草地、水面……）：它们原来各自硬编码
   * 雾色/雾密度，于是夜里场景雾转成暗蓝、草地却还朝亮米色淡出，
   * 草地上会浮出一片片发亮的奶色斑块。
   */
  fogColor: new THREE.Color("#eecfa4"),
  fogDensity: 0.0046,

  /**
   * 自发光增益（HDR 线性倍数）。
   *
   * 这是整套特效能不能"真的发光"的总开关。原因：bloom 的亮度高通在
   * **tone-map 之前**、于线性 HDR 缓冲上工作，阈值是 0.8。任何片元的最终线性
   * 亮度必须超过 0.8 才会产生辉光，而 0.8 以上的部分还只有 (L-0.8)/0.01 的
   * 过渡（smoothWidth 被 UnrealBloomPass 硬编码成 0.01，几乎硬切）。
   *
   * 所以颜色不能再当作"0~1 的观感色"直接写出去，而必须乘一个 >1 的系数。
   *
   * **取值的依据是算出来的，不是拍脑袋**：加法混合下某个光点的实际贡献是
   * `color × opacity × 闪烁`，逐项代入最暗的那个（光尘 `#ffe9b8` 线性亮度 0.830、
   * opacity 0.5、闪烁峰值 1.0）：
   *   0.830 × 0.5 × 1.0 × 2.0 = 0.83  ← 刚好压在阈值上，等于"永远差一点"
   *   0.830 × 0.5 × 1.0 × 3.2 = 1.33  ← 稳定过阈值，才有真正的辉光
   * 所以白天取 3.2。夜间再叠 1.6 → 峰值约 2.0，暖光点会在冷色夜景里明确跳出来 ——
   * 这正是《光遇》的物理：暗处才是光的主场。
   */
  fxGain(): number {
    return 3.2 + this.night * 1.6;
  },
};

/**
 * 把"观感色"变成可用于自发光写入的 HDR 颜色：乘 fxGain。
 * 返回的是**缓存的临时 Color**，调用方应立刻用掉或 copy 走，不要持有。
 */
const _tmp = new THREE.Color();
export function fxColor(color: string | THREE.Color, gain = lightState.fxGain(), out = _tmp): THREE.Color {
  if (color instanceof THREE.Color) out.copy(color);
  else out.set(color);
  out.multiplyScalar(gain);
  return out;
}
