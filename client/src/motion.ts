import * as THREE from "three";

/**
 * 动作物理通道：弹簧-质点（半隐式欧拉积分）。
 *
 * 光遇的重量感不在关键帧里，在过渡里——起步时身体滞后半拍再前倾过头、
 * 急停时后仰回弹、落地压扁再弹回、转弯外侧压肩再回正。
 * 把每个姿态增量接上一个略欠阻尼的弹簧，滞后/超调/回弹就自然涌现，
 * 不用为每种情况手写缓动曲线。
 */
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

  /** 向目标步进一帧，返回新当前值。dt 封顶防低帧率积分爆炸。 */
  step(target: number, dt: number): number {
    const h = Math.min(dt, 1 / 30);
    const a = -this.k * (this.x - target) - this.c * this.v;
    this.v += a * h;
    this.x += this.v * h;
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
    const h = Math.min(dt, 1 / 30);
    this.v.x += (-this.k * (this.x.x - target.x) - this.c * this.v.x) * h;
    this.v.y += (-this.k * (this.x.y - target.y) - this.c * this.v.y) * h;
    this.v.z += (-this.k * (this.x.z - target.z) - this.c * this.v.z) * h;
    this.x.addScaledVector(this.v, h);
    return this.x;
  }

  snap(p: THREE.Vector3): this {
    this.x.copy(p);
    this.v.set(0, 0, 0);
    return this;
  }
}
