import * as THREE from "three";
import { terrainHeight, ISLAND_RADIUS, WATER_LEVEL } from "./heightfield";

/**
 * 第三人称操控：WASD 相对相机方向移动、Shift 奔跑、E 坐下、
 * 拖拽环顾、滚轮拉近。角色贴合地形，小跳一下也是允许的。
 */
export interface ControlsState {
  pos: THREE.Vector3;
  yaw: number; // 角色朝向
  mov: number; // 0/1/2
  sit: boolean;
}

export class PlayerControls {
  readonly state: ControlsState = {
    pos: new THREE.Vector3(0, 3, 8),
    yaw: 0,
    mov: 0,
    sit: false,
  };

  camYaw = Math.PI; // 相机绕角色的方位角
  camPitch = 0.32;
  camDist = 7.5;

  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private vy = 0;
  private jumping = false;
  private enabled = false;
  private dom: HTMLElement;

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.dom = dom;
    window.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      const k = e.key.toLowerCase();
      if (k === "e") this.state.sit = !this.state.sit;
      if (k === " ") this.jump();
      this.keys.add(k);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());

    dom.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.camYaw -= (e.clientX - this.lastX) * 0.005;
      this.camPitch = THREE.MathUtils.clamp(this.camPitch + (e.clientY - this.lastY) * 0.004, 0.05, 1.15);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    dom.addEventListener("pointerup", () => (this.dragging = false));
    dom.addEventListener(
      "wheel",
      (e) => {
        this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * 0.008, 3.5, 13);
      },
      { passive: true }
    );
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (!v) this.keys.clear();
  }

  /** 出生点 */
  spawnAt(x: number, z: number) {
    this.state.pos.set(x, terrainHeight(x, z), z);
  }

  private jump() {
    if (this.jumping || this.state.sit) return;
    this.jumping = true;
    this.vy = 5.2;
  }

  update(dt: number) {
    const s = this.state;
    let mx = 0;
    let mz = 0;
    if (this.enabled) {
      if (this.keys.has("w") || this.keys.has("arrowup")) mz -= 1;
      if (this.keys.has("s") || this.keys.has("arrowdown")) mz += 1;
      if (this.keys.has("a") || this.keys.has("arrowleft")) mx -= 1;
      if (this.keys.has("d") || this.keys.has("arrowright")) mx += 1;
    }
    const moving = (mx !== 0 || mz !== 0) && !s.sit;
    const running = moving && (this.keys.has("shift") || this.keys.has("shiftleft"));

    if (moving) {
      if (s.sit) s.sit = false;
      const len = Math.hypot(mx, mz);
      const dirX = mx / len;
      const dirZ = mz / len;
      // 相机朝向转世界方向
      const cos = Math.cos(this.camYaw);
      const sin = Math.sin(this.camYaw);
      const wx = dirX * cos - dirZ * sin;
      const wz = dirX * sin + dirZ * cos;
      const speed = running ? 7.2 : 3.6;
      s.pos.x += wx * speed * dt;
      s.pos.z += wz * speed * dt;

      // 朝向平滑转向移动方向
      const targetYaw = Math.atan2(wx, wz);
      let diff = targetYaw - s.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      s.yaw += diff * Math.min(1, dt * 10);
    }
    s.mov = !moving ? 0 : running ? 2 : 1;

    // 岛界约束
    const r = Math.hypot(s.pos.x, s.pos.z);
    if (r > ISLAND_RADIUS - 1) {
      s.pos.x *= (ISLAND_RADIUS - 1) / r;
      s.pos.z *= (ISLAND_RADIUS - 1) / r;
    }

    // 贴地 + 小跳
    const ground = Math.max(terrainHeight(s.pos.x, s.pos.z), WATER_LEVEL - 0.25);
    if (this.jumping) {
      this.vy -= 14 * dt;
      s.pos.y += this.vy * dt;
      if (s.pos.y <= ground) {
        s.pos.y = ground;
        this.jumping = false;
        this.vy = 0;
      }
    } else {
      s.pos.y = THREE.MathUtils.lerp(s.pos.y, ground, Math.min(1, dt * 12));
    }

    // 相机跟随
    const focus = new THREE.Vector3(s.pos.x, s.pos.y + 1.7, s.pos.z);
    const cx = focus.x + Math.sin(this.camYaw) * this.camDist * Math.cos(this.camPitch);
    const cz = focus.z + Math.cos(this.camYaw) * this.camDist * Math.cos(this.camPitch);
    const cy = focus.y + Math.sin(this.camPitch) * this.camDist;
    const camGround = terrainHeight(cx, cz) + 0.8;
    const target = new THREE.Vector3(cx, Math.max(cy, camGround), cz);
    this.camera.position.lerp(target, Math.min(1, dt * 7));
    this.camera.lookAt(focus);
  }

  /** 入场前的环岛慢镜头 */
  cinematicOrbit(t: number) {
    const a = t * 0.08;
    this.camera.position.set(Math.cos(a) * 26, 8 + Math.sin(t * 0.1) * 1.2, Math.sin(a) * 26);
    this.camera.lookAt(0, 2.5, 0);
  }
}
