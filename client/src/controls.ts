import * as THREE from "three";
import { terrainHeight } from "./heightfield";
import { SpringV3 } from "./motion";
import { CharacterPhysics, MAX_FLAPS, type PhysicsEvent } from "./physics";

/**
 * 光遇式操控 · 二代
 *
 * - 动量移动：加速/减速有惯性，转弯时身体侧倾
 * - 单按空格跳跃；按住超过短阈值才展开披风滑翔
 * - 腾空再次按空格 = 扑翼（3 翼能，落地充能）
 * - 篝火与灯塔山丘有上升暖气流
 * - 滑翔时相机 FOV 微宽，速度感更足
 *
 * mov 状态码: 0 静止 / 1 行走 / 2 奔跑 / 3 滑翔 / 4 扑翼(瞬时) / 5 普通腾空
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

export { MAX_FLAPS };

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

  /** 角色物理核心（光遇手感状态机：地面/腾空/滑翔/游泳），直接驱动 state.pos */
  private readonly phys = new CharacterPhysics(this.state.pos);

  camYaw = Math.PI;
  camPitch = 0.32;
  camDist = 7.5;
  /** 相机跟随焦点弹簧（只平滑玩家移动的跟随；鼠标转视角是直接操作不走弹簧） */
  private readonly camSpring = new SpringV3(110, 19);
  private readonly _focusRaw = new THREE.Vector3();
  /** 平滑后的水平速度（速度前瞻用，防抖） */
  private readonly camLead = new THREE.Vector3();
  private readonly camFocus = new THREE.Vector3();

  onLand: ((impact: number) => void) | null = null;
  onFlap: (() => void) | null = null;
  onJump: (() => void) | null = null;
  onGlide: ((open: boolean) => void) | null = null;
  onSit: ((sitting: boolean) => void) | null = null;
  /** 入水/出水（水花等待接） */
  onWater: ((enter: boolean) => void) | null = null;

  /** 当前水平速度（米/秒，供动画使用） */
  get horizSpeed(): number {
    return this.phys.horizSpeed;
  }

  /** 当前垂直速度（米/秒，空中姿势分层用） */
  get verticalVel(): number {
    return this.phys.vel.y;
  }

  /** 水平速度向量（风线等特效使用） */
  get horizVel(): THREE.Vector3 {
    return this.phys.vel;
  }

  /** 滑翔物理状态（动画层读俯仰等） */
  get physics(): CharacterPhysics {
    return this.phys;
  }

  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private jumpQueued = false;
  private spacePressedAt = 0;
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
      // 正在输入框里打字（聊天）时不当作游戏按键
      if ((e.target as HTMLElement | null)?.matches?.("input, textarea, [contenteditable]")) return;
      const k = e.key.toLowerCase();
      if (k === " " || k.startsWith("arrow")) e.preventDefault();
      if (!this.enabled) return;
      if (k === "e" && !e.repeat) {
        this.state.sit = !this.state.sit;
        this.onSit?.(this.state.sit);
      }
      if (k === " " && !e.repeat) {
        this.jumpQueued = true;
        this.spacePressedAt = performance.now();
      }
      this.keys.add(k);
    });
  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    this.keys.delete(k);
    if (k === " ") this.spacePressedAt = 0;
  });
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
    // 拖拽转视角期间的浏览器原生行为与下载扩展(IDM/迅雷类"框选下载")全部拦下。
    // 用 document 捕获阶段：页面脚本先于 document_idle 注入的内容脚本注册，
    // 在事件到达扩展监听器之前就 stopImmediatePropagation（指针事件不受影响，转视角照常）
    document.addEventListener(
      "mousedown",
      (e) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest?.("input, textarea, [contenteditable]")) return; // 表单交互不受影响
        e.preventDefault(); // 阻断传统文本框选起点
        e.stopImmediatePropagation(); // 框选下载扩展靠 mousedown 起手，掐在起点
      },
      true
    );
    // Alt+拖拽是常见下载扩展的框选触发键，Alt 本身还会唤起浏览器菜单栏——吞掉
    window.addEventListener("keydown", (e) => {
      if (e.altKey) e.preventDefault();
    });
    document.addEventListener("dragstart", (e) => e.preventDefault());
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

  /** 某个键当前是否按住（秋千蹬踏等外围系统用） */
  isKeyDown(key: string) {
    return this.keys.has(key.toLowerCase());
  }

  /** 虚拟摇杆输入（触屏层写入；屏幕系 x 右 z 下，与 WASD 同约定） */
  touchMove = { x: 0, z: 0 };

  /** 触屏按钮模拟按键：down=true 走与物理键盘同一套逻辑（E 切坐、空格跳/按住滑翔） */
  virtualKey(key: string, down: boolean) {
    const k = key.toLowerCase();
    if (down) {
      if (this.enabled) {
        if (k === "e") {
          this.state.sit = !this.state.sit;
          this.onSit?.(this.state.sit);
        }
        if (k === " ") {
          this.jumpQueued = true;
          this.spacePressedAt = performance.now();
        }
        this.keys.add(k);
      }
    } else {
      this.keys.delete(k);
      if (k === " ") this.spacePressedAt = 0;
    }
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
      this.phys.vel.set(0, 0, 0);
      this.jumpQueued = false;
    }
  }

  /** 被牵时由跟随逻辑写入运动量（供动画/披风风场使用） */
  setCarriedMotion(hSpeed: number, vy: number) {
    this.phys.vel.set(Math.sin(this.state.yaw) * hSpeed, vy, Math.cos(this.state.yaw) * hSpeed);
  }

  spawnAt(x: number, z: number) {
    this.phys.snapTo(x, z);
    this.state.pos.copy(this.phys.pos);
    this.spacePressedAt = 0;
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
      // 虚拟摇杆覆盖键盘方向（触屏玩家）
      const joyLen = Math.hypot(this.touchMove.x, this.touchMove.z);
      if (joyLen > 0.08) {
        ix = this.touchMove.x;
        iz = this.touchMove.z;
      }
    }
    const inputLen = Math.hypot(ix, iz);
    const moving = inputLen > 0.01 && !s.sit;
    if (moving) s.sit = false; // 走动即起立
    const joyFull = Math.hypot(this.touchMove.x, this.touchMove.z) > 0.88;
    const running = moving && (this.keys.has("shift") || joyFull);
    const spaceHeldMs = this.spacePressedAt > 0 && this.keys.has(" ") ? performance.now() - this.spacePressedAt : 0;
    const glideHeld = this.phys.airborne && spaceHeldMs >= 150;

    // ---- 物理步进：一个完整状态机（地面/腾空/滑翔/游泳），所有积分在里面 ----
    const events: PhysicsEvent[] = [];
    this.phys.step(
      dt,
      {
        moveX: moving ? ix : 0,
        moveZ: moving ? iz : 0,
        running,
        jumpPressed: this.jumpQueued,
        glideHeld,
        camYaw: this.camYaw,
      },
      events
    );
    this.jumpQueued = false;

    // 物理状态 → 网络与动画读的 ControlsState（pos 是同一引用，无需拷贝）
    s.yaw = this.phys.yaw;
    s.yawVel = this.phys.yawVel;
    s.airborne = this.phys.airborne;
    s.flaps = this.phys.flaps;

    // ---- 物理事件 → 游戏回调 ----
    for (const e of events) {
      switch (e.type) {
        case "jump":
          s.sit = false;
          this.onJump?.();
          break;
        case "flap":
          this.onFlap?.();
          break;
        case "land":
          this.spacePressedAt = 0;
          this.onLand?.(e.impact);
          break;
        case "glide":
          this.onGlide?.(e.open);
          break;
        case "water":
          this.onWater?.(e.enter);
          break;
      }
    }

    // ---- mov 状态码 ----
    const speedH = this.phys.horizSpeed;
    if (this.phys.flapTimer > 0) {
      s.mov = 4;
    } else if (this.phys.airborne) {
      s.mov = glideHeld ? 3 : 5;
    } else {
      // 水中游泳复用行走码（动画不区分）
      s.mov = speedH < 0.4 ? 0 : running ? 2 : 1;
    }

    // ---- 相机：跟随 + 速度感 FOV ----
    this.updateCamera(dt);
  }

  private updateCamera(dt: number) {
    const s = this.state;
    const speedH = this.phys.horizSpeed;
    const glideHeld = this.phys.gliding;
    // 滑翔时镜头缓慢跟上航向：转弯时镜头自然跟到角色背后（光遇的跟随机），
    // 鼠标随时可以拽走。没有这层跟随，俯冲后用鼠标"转向"只转镜头不转航向，
    // 体感就是"转不动"
    if (glideHeld) {
      const heading = this.phys.yaw + Math.PI; // 相机在角色正后方的 camYaw
      let d = heading - this.camYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.camYaw += d * Math.min(1, dt * 1.4);
    }
    // 弹簧只挂在跟随焦点上：玩家移动的跟随带一点呼吸感。
    // 鼠标转视角是直接操作，必须 1:1 立即响应——弹簧若挂在相机位置上，
    // 快速转动时轨道目标绕焦点瞬移，弹簧追不上再触发距离保护直贴，视角就会猛跳
    const focusRaw = this._focusRaw.set(s.pos.x, s.pos.y + 1.7, s.pos.z);
    if (this.camSpring.x.distanceTo(focusRaw) > 8) this.camSpring.snap(focusRaw); // 入场/传送直接贴上
    const focus = this.camSpring.step(focusRaw, dt);
    const cx = focus.x + Math.sin(this.camYaw) * this.camDist * Math.cos(this.camPitch);
    const cz = focus.z + Math.cos(this.camYaw) * this.camDist * Math.cos(this.camPitch);
    const cy = focus.y + Math.sin(this.camPitch) * this.camDist;
    const camGround = terrainHeight(cx, cz) + 0.8;
    this.camera.position.set(cx, Math.max(cy, camGround), cz);
    // 速度前瞻：视线先看向要去的地方（光遇的镜头感），落点用平滑速度防抖
    this.camLead.lerp(this.phys.vel, Math.min(1, dt * 4));
    this.camFocus.copy(focus).addScaledVector(this.camLead, 0.16);
    this.camera.lookAt(this.camFocus);

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
