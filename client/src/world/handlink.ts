import * as THREE from "three";

/**
 * 牵手光带：一条发光的丝线连着两个人的手腕（光遇式的光弧）。
 *
 * 实现为一条 InstancedMesh 光珠链：每对玩家 18 颗光珠沿二次贝塞尔排布，
 * 中点随距离轻微下垂、随时间呼吸明灭，端点吸附在两人抬起的手腕上。
 * 每帧由主循环喂入配对列表，数量上限 MAX_PAIRS 对。
 */

const DOTS_PER_PAIR = 18;
const MAX_PAIRS = 8;

export class HandLinks {
  readonly mesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
  private vMid = new THREE.Vector3();
  private vP = new THREE.Vector3();

  constructor() {
    const geo = new THREE.SphereGeometry(0.05, 8, 6);
    const mat = new THREE.MeshBasicMaterial({
      color: "#ffe3ae",
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, DOTS_PER_PAIR * MAX_PAIRS);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    // 初始全部隐藏
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < this.mesh.count; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
  }

  /**
   * @param pairs 每对 {a, b}：两端的「手腕」世界坐标
   */
  update(pairs: { a: THREE.Vector3; b: THREE.Vector3 }[], t: number) {
    const n = Math.min(pairs.length, MAX_PAIRS);
    let idx = 0;
    for (let p = 0; p < n; p++) {
      const { a, b } = pairs[p];
      this.vA.copy(a);
      this.vB.copy(b);
      const dist = this.vA.distanceTo(this.vB);
      // 中点下垂：近了几乎绷直，远了像柔柔的丝带
      const sag = Math.min(0.65, dist * 0.12);
      this.vMid.copy(this.vA).add(this.vB).multiplyScalar(0.5);
      this.vMid.y -= sag;
      for (let i = 0; i < DOTS_PER_PAIR; i++) {
        const tt = i / (DOTS_PER_PAIR - 1);
        // 二次贝塞尔
        const u = 1 - tt;
        this.vP.set(
          u * u * this.vA.x + 2 * u * tt * this.vMid.x + tt * tt * this.vB.x,
          u * u * this.vA.y + 2 * u * tt * this.vMid.y + tt * tt * this.vB.y,
          u * u * this.vA.z + 2 * u * tt * this.vMid.z + tt * tt * this.vB.z
        );
        this.dummy.position.copy(this.vP);
        // 流光：亮珠沿带子跑 + 端点更亮
        const wave = 0.6 + 0.4 * Math.sin(tt * Math.PI);
        const run = 0.55 + 0.45 * Math.sin(tt * 10 - t * 5 + p);
        this.dummy.scale.setScalar(0.75 + wave * run * 0.7);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(idx++, this.dummy.matrix);
      }
    }
    // 多余的隐藏
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    while (idx < this.mesh.count) this.mesh.setMatrixAt(idx++, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
