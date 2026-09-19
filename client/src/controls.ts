import * as THREE from "three";
import { terrainHeight, ISLAND_RADIUS, WATER_LEVEL } from "./heightfield";
import { resolveColliders, standGroundHeight } from "./colliders";

/**
 * 光遇式操控 · 二代
 *
 * - 动量移动：加速/减速有惯性，转弯时身体侧倾
 * - 跳跃 → 按住空格滑翔（缓降 + 前冲，披风展开）
 * - 腾空再按空格 = 扑翼（3 翼能，落地充能）
 * - 篝火与灯塔山丘有上升暖气流
 * - 滑翔时相机 FOV 微宽，速度感更足
 *
 * mov 状态码: 0 静止 / 1 行走 / 2 奔跑 / 3 滑翔 / 4 扑翼(瞬时)
 */
export interface ControlsState {
  pos: THREE.Vector3;
  yaw: number; // 朝向
  yawVel: number; // 转向角速度（供侧倾）
  mov: number;
  sit: boolean;
  airborne: boolean;
  flaps: number; // 剩余扑翼 0-3
}

export const MAX_FLAPS = 3;

export class PlayerControls {
  readonly state: ControlsState = {
    pos: new THREE.Vector3(0, 3, 8),
    yaw: 0,
    yawVel: 0,
    mov: 0,
    sit: false,
    airborne: false,
    flaps: MAX_FLAPS,
  };

  camYaw = Math.PI;
  camPitch = 0.32;
  camDist = 7.5;

  onLand: (() => void) | null = null;
  onFlap: (() => void) | null = null;
  onJump: (() => void) | null = null;
  onSit: ((sitting: boolean) => void) | null = null;

  /** 当前水平速度（米/秒，供动画使用） */
  get horizSpeed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** 当前垂直速度（米/秒，空中姿势分层用） */
  get verticalVel(): number {
    return this.vy;
  }

  /** 水平速度向量（风线等特效使用） */
  get horizVel(): THREE.Vector3 {
    return this.vel;
  }

  private keys = new Set<string>();
  private vel = new THREE.Vector3(); // 水平速度
  private vy = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private jumpQueued = false;
  private flapTimer = 0; // mov=4 的显示时长
  private flapRegen = 0;
  private enabled = false;
  private led = false; // 被牵着：移动输入与物理都交给主循环的跟随逻辑
  private mouseLocked = false;
  private dom: HTMLElement;
  private baseFov = 55;

  /** 鼠标是否锁定在游戏内（供 UI 提示） */
  get isMouseLocked() {
    return this.mouseLocked;
  }

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.dom = dom;
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (k === " " || k.startsWith("arrow")) e.preventDefault();
      if (!this.enabled) return;
      if (k === "e" && !e.repeat) {
        this.state.sit = !this.state.sit;
        this.onSit?.(this.state.sit);
      }
      if (k === " " && !e.repeat) this.jumpQueued = true;
      this.keys.add(k);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());

    dom.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
      // 光遇端游手感：点击画面即锁定鼠标，移动直接转视角；Esc 释放
      if (this.enabled && document.pointerLockElement !== dom) {
        (dom.requestPointerLock as () => Promise<void> | void)?.call(dom)?.catch?.(() => {});
      }
    });
    // 锁定状态下用 movementX/Y 连续转视角（鼠标右移=视角右转）
    dom.addEventListener("pointermove", (e) => {
      if (document.pointerLockElement === dom) {
        this.camYaw -= e.movementX * 0.0026;
        this.camPitch = THREE.MathUtils.clamp(this.camPitch + e.movementY * 0.0021, 0.05, 1.15);
        return;
      }
      if (!this.dragging) return;
      // 未锁定时拖拽同样「右拖=视角右转」，两种模式方向一致
      this.camYaw -= (e.clientX - this.lastX) * 0.005;
      this.camPitch = THREE.MathUtils.clamp(this.camPitch + (e.clientY - this.lastY) * 0.004, 0.05, 1.15);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    dom.addEventListener("pointerup", () => (this.dragging = false));
    document.addEventListener("pointerlockchange", () => {
      this.mouseLocked = document.pointerLockElement === dom;
    });
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

  /** 被牵（true）/ 自由（false）。被牵时输入与跳跃失效，位置由牵手跟随写入 */
  setLed(v: boolean) {
    if (this.led === v) return;
    this.led = v;
    if (v) {
      this.keys.clear();
      this.vel.set(0, 0, 0);
      this.jumpQueued = false;
    }
  }

  /** 被牵时由跟随逻辑写入运动量（供动画/披风风场使用） */
  setCarriedMotion(hSpeed: number, vy: number) {
    this.vel.set(Math.sin(this.state.yaw) * hSpeed, 0, Math.cos(this.state.yaw) * hSpeed);
    this.vy = vy;
  }

  spawnAt(x: number, z: number) {
    this.state.pos.set(x, terrainHeight(x, z), z);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.state.airborne = false;
  }

  /** 暖气流：篝火广场与灯塔山丘上空有柔和的上升气流 */
  private updraftAt(x: number, z: number, y: number): number {
    let u = 0;
    const dFire = Math.hypot(x, z);
    if (dFire < 7 && y < 10) u += 3.4 * (1 - dFire / 7);
    const dHill = Math.hypot(x - 26, z + 28);
    if (dHill < 6 && y < 16) u += 2.8 * (1 - dHill / 6);
    return u;
  }

  update(dt: number) {
    const s = this.state;
    if (this.led) {
      // 被牵着走：位置已由牵手跟随写入，这里只跟镜头（还能东张西望）
      this.state.yawVel = THREE.MathUtils.lerp(this.state.yawVel, 0, Math.min(1, dt * 6));
      this.updateCamera(dt);
      return;
    }
    let ix = 0;
    let iz = 0;
    if (this.enabled) {
      if (this.keys.has("w") || this.keys.has("arrowup")) iz -= 1;
      if (this.keys.has("s") || this.keys.has("arrowdown")) iz += 1;
      if (this.keys.has("a") || this.keys.has("arrowleft")) ix -= 1;
      if (this.keys.has("d") || this.keys.has("arrowright")) ix += 1;
    }
    const inputLen = Math.hypot(ix, iz);
    const moving = inputLen > 0.01 && !s.sit;
    const running = moving && this.keys.has("shift");

    // ---- 水平动量（腾空时转向收敛，像布一样飘） ----
    const targetSpeed = s.airborne ? (this.keys.has(" ") ? 9.2 : 6.0) : running ? 7.2 : 3.6;
    let tx = 0;
    let tz = 0;
    if (moving || s.airborne) {
      let dx: number, dz: number;
      if (moving) {
        dx = ix / inputLen;
        dz = iz / inputLen;
      } else {
        // 腾空无输入：维持当前朝向的前冲
        dx = Math.sin(s.yaw);
        dz = Math.cos(s.yaw);
      }
      // 相机相对方向（对任意 camYaw 都成立）：
      // 前向 = -(sin,cos)，右向 = (cos,-sin)
      const cos = Math.cos(this.camYaw);
      const sin = Math.sin(this.camYaw);
      tx = (dx * cos + dz * sin) * targetSpeed;
      tz = (-dx * sin + dz * cos) * targetSpeed;
    }
    const accel = s.airborne ? 2.2 : 10;
    this.vel.x = THREE.MathUtils.lerp(this.vel.x, tx, Math.min(1, accel * dt));
    this.vel.z = THREE.MathUtils.lerp(this.vel.z, tz, Math.min(1, accel * dt));
    s.pos.x += this.vel.x * dt;
    s.pos.z += this.vel.z * dt;

    // ---- 朝向与侧倾 ----
    const speedH = Math.hypot(this.vel.x, this.vel.z);
    if (moving && speedH > 0.3) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      let diff = targetYaw - s.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const step = diff * Math.min(1, dt * 9);
      s.yaw += step;
      s.yawVel = THREE.MathUtils.lerp(s.yawVel, step / Math.max(dt, 1e-4), Math.min(1, dt * 8));
    } else {
      s.yawVel = THREE.MathUtils.lerp(s.yawVel, 0, Math.min(1, dt * 6));
    }
    if (moving && s.sit) s.sit = false;

    // ---- 实体碰撞：树/岩石/灯塔/篝火不可穿越，贴着表面滑行 ----
    resolveColliders(s.pos, this.vel);

    // ---- 岛界（空中也留在岛上空） ----
    const r = Math.hypot(s.pos.x, s.pos.z);
    if (r > ISLAND_RADIUS - 1) {
      s.pos.x *= (ISLAND_RADIUS - 1) / r;
      s.pos.z *= (ISLAND_RADIUS - 1) / r;
    }

    // ---- 垂直：跳跃 / 滑翔 / 扑翼 / 暖气流 ----
    // 地面 = 地形高度，或已越过的实体顶面（岩石/灯塔环廊/木凳，站得上去）
    const ground = Math.max(terrainHeight(s.pos.x, s.pos.z), WATER_LEVEL - 0.25, standGroundHeight(s.pos));
    const glideHeld = this.keys.has(" ");

    if (this.jumpQueued) {
      this.jumpQueued = false;
      if (!s.airborne) {
        this.vy = 6.6;
        s.airborne = true;
        s.sit = false;
        this.onJump?.();
      } else if (s.flaps > 0) {
        this.vy = 7.0;
        s.flaps--;
        this.flapTimer = 0.28;
        this.onFlap?.();
      }
    }

    if (s.airborne) {
      const up = this.updraftAt(s.pos.x, s.pos.z, s.pos.y);
      if (glideHeld && this.vy < 0.6) {
        // 滑翔：柔和缓降；暖气流直接抬升缓降下限，篝火上方会被稳稳托起
        this.vy = Math.max(this.vy - 5 * dt, -1.7 + up);
      } else {
        this.vy -= 22 * dt;
        this.vy += up * 0.45 * dt; // 自由落体时暖流只轻微上托
      }
      this.vy = Math.min(this.vy, 12);
      s.pos.y += this.vy * dt;
      if (s.pos.y <= ground) {
        s.pos.y = ground;
        s.airborne = false;
        this.vy = 0;
        this.onLand?.();
      }
    } else {
      s.pos.y = THREE.MathUtils.lerp(s.pos.y, ground, Math.min(1, dt * 14));
      // 翼能恢复
      if (s.flaps < MAX_FLAPS) {
        this.flapRegen += dt;
        if (this.flapRegen > 1.1) {
          this.flapRegen = 0;
          s.flaps++;
        }
      }
    }

    // ---- mov 状态码 ----
    if (this.flapTimer > 0) {
      this.flapTimer -= dt;
      s.mov = 4;
    } else if (s.airborne) {
      s.mov = 3;
    } else {
      s.mov = speedH < 0.4 ? 0 : running ? 2 : 1;
    }

    // ---- 相机：跟随 + 速度感 FOV ----
    this.updateCamera(dt);
  }

  private updateCamera(dt: number) {
    const s = this.state;
    const speedH = Math.hypot(this.vel.x, this.vel.z);
    const glideHeld = this.keys.has(" ");
    const focus = new THREE.Vector3(s.pos.x, s.pos.y + 1.7, s.pos.z);
    const cx = focus.x + Math.sin(this.camYaw) * this.camDist * Math.cos(this.camPitch);
    const cz = focus.z + Math.cos(this.camYaw) * this.camDist * Math.cos(this.camPitch);
    const cy = focus.y + Math.sin(this.camPitch) * this.camDist;
    const camGround = terrainHeight(cx, cz) + 0.8;
    const target = new THREE.Vector3(cx, Math.max(cy, camGround), cz);
    this.camera.position.lerp(target, Math.min(1, dt * 7));
    this.camera.lookAt(focus);

    const fovTarget = this.baseFov + Math.min(1, speedH / 9.2) * 5 + (s.airborne && glideHeld ? 3 : 0);
    if (Math.abs(this.camera.fov - fovTarget) > 0.05) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fovTarget, Math.min(1, dt * 4));
      this.camera.updateProjectionMatrix();
    }
  }

  /** 入场前的环岛慢镜头 */
  cinematicOrbit(t: number) {
    const a = t * 0.08;
    this.camera.position.set(Math.cos(a) * 26, 8 + Math.sin(t * 0.1) * 1.2, Math.sin(a) * 26);
    this.camera.lookAt(0, 2.5, 0);
  }
}
