import * as THREE from "three";

/**
 * 动作物理通道：弹簧-质点（半隐式欧拉积分）。
 *
 * 光遇的重量感不在关键帧里，在过渡里——起步时身体滞后半拍再前倾过头、
 * 急停时后仰回弹、落地压扁再弹回、转弯外侧压肩再回正。
 * 把每个姿态增量接上一个略欠阻尼的弹簧，滞后/超调/回弹就自然涌现，
 * 不用为每种情况手写缓动曲线。
 */

/** 子步长上限：1/120 秒。半隐式欧拉在这个步长下对项目里所有刚度都稳。 */
const SUB = 1 / 120;
/** 单帧最多子步数：防止卡顿之后「追帧」雪崩（8 × 1/120 ≈ 67ms 的模拟时间） */
const MAX_SUB = 8;

/** 把 dt 拆成若干子步：dt 大就多拆几步，而不是把 dt 截短（截短会让收敛变慢） */
function subSteps(dt: number): number {
  return Math.max(1, Math.min(MAX_SUB, Math.ceil(dt / SUB)));
}
export class Spring {
  /** 当前值 */
  x: number;
  /** 速度 */
  v = 0;

  /**
   * @param k 刚度（ω²）：越大追踪越快
   * @param c 阻尼（2ζω）：c = 2√k 为临界阻尼（无超调），
   *           取 ~0.75·2√k 得到一点点过冲回弹——光遇的味道
   * @param x0 初始值
   */
  constructor(public k: number, public c: number, x0 = 0) {
    this.x = x0;
  }

  /**
   * 向目标步进一帧，返回新当前值。
   *
   * 原来是 `const h = Math.min(dt, 1/30)` —— 把 dt **截短**。于是掉到 20fps
   * （dt = 1/20）时弹簧每帧只推进 1/30 秒，一秒真实时间只模拟了 20/30 = 0.667 秒，
   * **收敛速度只剩 2/3**，手感整体变「拖」。相机跟随和身体姿态都吃这个。
   *
   * 改成**子步**：dt 多大就拆成几步，模拟时间如实等于 dt，与帧率无关。
   * 半隐式欧拉在 h ≤ 1/120 下比原来更稳（原来 1/30 对高刚度弹簧反而更接近失稳边界）。
   */
  step(target: number, dt: number): number {
    const n = subSteps(dt);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - target) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }

  /** 瞬间置值（换状态防飞行） */
  snap(x: number) {
    this.x = x;
    this.v = 0;
  }
}

/** 常用配比：给定想要的安定时间，取略欠阻尼 */
export function bouncy(stiffness: number) {
  return { k: stiffness, c: 1.5 * Math.sqrt(stiffness) }; // ζ≈0.75
}

/** 三维弹簧（相机跟随等）：三个分量各自弹簧，物理同 Spring */
export class SpringV3 {
  readonly x = new THREE.Vector3();
  private readonly v = new THREE.Vector3();

  constructor(public k: number, public c: number) {}

  step(target: THREE.Vector3, dt: number): THREE.Vector3 {
    const n = subSteps(dt);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v.x += (-this.k * (this.x.x - target.x) - this.c * this.v.x) * h;
      this.v.y += (-this.k * (this.x.y - target.y) - this.c * this.v.y) * h;
      this.v.z += (-this.k * (this.x.z - target.z) - this.c * this.v.z) * h;
      this.x.addScaledVector(this.v, h);
    }
    return this.x;
  }

  snap(p: THREE.Vector3): this {
    this.x.copy(p);
    this.v.set(0, 0, 0);
    return this;
  }
}
