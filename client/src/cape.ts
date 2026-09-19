import * as THREE from "three";

/**
 * 披风布料仿真：Verlet 质点网格。
 *
 * 为什么这不像「预设摆动动画」：
 *  - 每个顶点是一个有质量的质点，受重力与相对风驱动（角色的加速度就是风）
 *  - 结构/剪切/弯曲约束每帧迭代求解，布有张力与 stiffness
 *  - 顶行钉在肩上：角色加速→布因惯性滞后甩动；急转→甩向外侧；滑翔→上风气流托起鼓成翼
 *  - 与身体近似碰撞 + 地面碰撞：坐下时披风自然堆叠在地面
 */
export class CapeSim {
  readonly mesh: THREE.Mesh;
  readonly cols: number;
  readonly rows: number;
  private pos: Float32Array;
  private prev: Float32Array;
  private constraints: { a: number; b: number; rest: number; k: number }[] = [];
  private rowLen = 0.06; // 每行网格的长度（锚距硬约束用）
  private acc = 0;
  private readonly dt = 1 / 60;
  private geo: THREE.BufferGeometry;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, private opts: { gravity?: number; damping?: number; iters?: number; drag?: number } = {}) {
    this.geo = geometry;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    const src = geometry.attributes.position as THREE.BufferAttribute;
    this.pos = new Float32Array(src.array as Float32Array);
    this.prev = new Float32Array(this.pos);
    const params = (geometry as unknown as { parameters?: { widthSegments: number; heightSegments: number } }).parameters;
    this.cols = (params?.widthSegments ?? 11) + 1;
    this.rows = (params?.heightSegments ?? 17) + 1;

    const idx = (i: number, j: number) => i * this.cols + j;
    const P = (n: number) => new THREE.Vector3(this.pos[n * 3], this.pos[n * 3 + 1], this.pos[n * 3 + 2]);
    const addC = (a: number, b: number, k: number) => this.constraints.push({ a, b, rest: P(a).distanceTo(P(b)), k });

    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.cols; j++) {
        if (j < this.cols - 1) addC(idx(i, j), idx(i, j + 1), 1); // 结构·横
        if (i < this.rows - 1) addC(idx(i, j), idx(i + 1, j), 1); // 结构·竖
        if (i < this.rows - 1 && j < this.cols - 1) {
          addC(idx(i, j), idx(i + 1, j + 1), 0.35); // 剪切（弱）
          addC(idx(i, j + 1), idx(i + 1, j), 0.35);
        }
        if (i < this.rows - 2) addC(idx(i, j), idx(i + 2, j), 0.25); // 弯曲（更弱）
      }
    }
    // 每行竖向步长（锚距硬约束的量尺）
    this.rowLen = Math.abs(P(0).y - P((this.rows - 1) * this.cols).y) / Math.max(1, this.rows - 1) || 0.06;
  }

  /**
   * @param dt 帧间隔
   * @param pins 顶行锚点（局部坐标，每 3 个一组，长度 = cols*3），由肩部世界位置换算而来
   * @param windLocal 作用于布的合外力（局部坐标系）：重力由内部加重
   * @param wingPose 滑翔翼形目标姿态（与 pos 同构）；物理位形与它按 wingBlend 插值后输出，
   *                 物理内部状态不受影响，退出滑翔时布料无跳变地回到纯仿真
   * @param wingBlend 0=纯物理 1=纯翼形
   */
  step(dt: number, pins: Float32Array, windLocal: THREE.Vector3, wingPose?: Float32Array | null, wingBlend = 0) {
    const gravity = this.opts.gravity ?? 14;
    const damping = this.opts.damping ?? 0.985;
    const iters = this.opts.iters ?? 5;

    this.acc = Math.min(this.acc + dt, this.dt * 3);
    while (this.acc >= this.dt) {
      this.acc -= this.dt;
      const h = this.dt;
      const n = this.pos.length / 3;

      // Verlet 积分（顶行 pin 除外）
      for (let v = this.cols; v < n; v++) {
        const o = v * 3;
        for (let c = 0; c < 3; c++) {
          const p = this.pos[o + c];
          const pr = this.prev[o + c];
          this.prev[o + c] = p;
          this.pos[o + c] = p + (p - pr) * damping + windLocal.getComponent(c) * h * h * 60;
        }
      }
      // 重力（局部 y-）
      for (let v = this.cols; v < n; v++) this.pos[v * 3 + 1] -= gravity * h * h * 60;

      // 约束松弛
      for (let it = 0; it < iters; it++) {
        for (const c of this.constraints) {
          const oa = c.a * 3;
          const ob = c.b * 3;
          const dx = this.pos[oa] - this.pos[ob];
          const dy = this.pos[oa + 1] - this.pos[ob + 1];
          const dz = this.pos[oa + 2] - this.pos[ob + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const diff = ((d - c.rest) / d) * 0.5 * c.k;
          const mx = dx * diff;
          const my = dy * diff;
          const mz = dz * diff;
          const aPinned = c.a < this.cols;
          const bPinned = c.b < this.cols;
          if (!aPinned) {
            this.pos[oa] -= mx * (bPinned ? 2 : 1);
            this.pos[oa + 1] -= my * (bPinned ? 2 : 1);
            this.pos[oa + 2] -= mz * (bPinned ? 2 : 1);
          }
          if (!bPinned) {
            this.pos[ob] += mx * (aPinned ? 2 : 1);
            this.pos[ob + 1] += my * (aPinned ? 2 : 1);
            this.pos[ob + 2] += mz * (aPinned ? 2 : 1);
          }
        }
        // 身体碰撞：躯干球 + 肩头球，把布推离；肩头球防止布翻越头顶到身前
        for (let v = this.cols; v < n; v++) {
          const o = v * 3;
          for (let s = 0; s < 2; s++) {
            const cy = s === 0 ? 0.8 : 1.16;
            const r = s === 0 ? 0.36 : 0.33;
            const dx = this.pos[o];
            const dy = this.pos[o + 1] - cy;
            const dz = this.pos[o + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < r * r && d2 > 1e-9) {
              const d = Math.sqrt(d2);
              const push = (r - d) / d;
              this.pos[o] += dx * push;
              this.pos[o + 1] += dy * push;
              this.pos[o + 2] += dz * push;
            }
          }
          // 单向前界：布面不能越过身体正面（防跳跃下落时被上掀风翻到身前穿模）
          if (this.pos[o + 2] > -0.06) {
            this.pos[o + 2] = -0.06;
            this.prev[o + 2] = Math.min(this.prev[o + 2], -0.06); // 同步速度，防反冲
          }
          if (this.pos[o + 1] < 0.03) this.pos[o + 1] = 0.03; // 地面
        }
      }

      // 顶行钉在肩上
      for (let j = 0; j < this.cols; j++) {
        const o = j * 3;
        this.pos[o] = pins[o];
        this.pos[o + 1] = pins[o + 1];
        this.pos[o + 2] = pins[o + 2];
        this.prev[o] = pins[o];
        this.prev[o + 1] = pins[o + 1];
        this.prev[o + 2] = pins[o + 2];
      }

      // 锚距硬约束：任意点到其所在列顶锚的距离不得超过链长上限(1.45 倍)。
      // 极端风(如远程玩家网络速度尖峰)再也拉不出丝，只是把布拉直到极限再弹回。
      for (let v = this.cols; v < n; v++) {
        const col = v % this.cols;
        const maxLen = Math.floor(v / this.cols) * this.rowLen * 1.45;
        const oa = col * 3;
        const o = v * 3;
        const dx = this.pos[o] - this.pos[oa];
        const dy = this.pos[o + 1] - this.pos[oa + 1];
        const dz = this.pos[o + 2] - this.pos[oa + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > maxLen && d > 1e-6) {
          const s = maxLen / d;
          this.pos[o] = this.pos[oa] + dx * s;
          this.pos[o + 1] = this.pos[oa + 1] + dy * s;
          this.pos[o + 2] = this.pos[oa + 2] + dz * s;
        }
      }
    }

    const attr = this.geo.attributes.position as THREE.BufferAttribute;
    if (wingPose && wingBlend > 0) {
      const b = Math.min(1, wingBlend);
      const out = attr.array as Float32Array;
      for (let v = 0; v < this.pos.length; v++) out[v] = this.pos[v] + (wingPose[v] - this.pos[v]) * b;
    } else {
      attr.copyArray(this.pos);
    }
    // 渲染前硬性前界：无论物理内部状态如何，输出几何绝不越过身体正面
    for (let i = 0; i < attr.count; i++) {
      if (attr.getZ(i) > -0.06) attr.setZ(i, -0.06);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}
