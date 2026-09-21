import * as THREE from "three";
import { terrainHeight, ISLAND_RADIUS, WATER_LEVEL } from "./heightfield";
import { resolveColliders, standGroundHeight } from "./colliders";

/**
 * 角色物理核心 · 光遇手感
 *
 * 与旧实现（散在 controls.update 里的三段 lerp）的本质区别：
 *  - 统一半隐式欧拉积分：所有模式只有加速度和速度，没有「lerp 到目标速度」的伪物理
 *  - 状态机：GROUND / AIR（自由落体）/ GLIDE（能量飞行）/ SWIM（浮力游泳）
 *  - 光遇手感参数集中在 FEEL：软重力、浮空跳跃、缓落终端速度、坡度滑行、水中浮游
 *  - 风/暖气流是外力场（updraftAt），扑翼是能量注入——飞行与地面同一套力学
 */
export const MAX_FLAPS = 3;

/** 光遇手感参数（集中调参用） */
export const FEEL = {
  gravity: 11.5, // 软重力：光遇的浮空感（旧值 19 = 火箭式落体）
  jumpImpulse: 6.4, // 配软重力：跳高 ~1.8m、滞空 ~1.1s（旧 1.1m/0.7s）
  fallTerminal: -8.5, // 落体终端速度：光遇落不快
  groundAccel: 16, // 地面加速（有惯性的起步，动画层的前倾弹簧配合）
  groundFriction: 11, // 松键收步的摩擦
  airAccel: 2.2, // 空中微操推力
  airDrag: 0.3, // 普通腾空的空气阻力
  walkSpeed: 3.6,
  runSpeed: 7.2,
  swimSpeed: 3.0, // 水中游速
  swimAccel: 8,
  buoyK: 30, // 浮力弹簧刚度（目标深度回弹）
  buoyC: 8, // 浮力阻尼
  swimSurfaceY: -0.28, // 水面漂浮的身体浸深
  swimDiveY: -1.05, // 按住 S 潜到的深度
  waterJump: 5.4, // 水中跃出水面的冲量
  slopeSlide: 0.55, // 坡度超过此值开始滑坡（高度差/米）
  slopeAccel: 6.5, // 滑坡/下坡加速度
  glide: {
    minSpeed: 2.8,
    maxSpeed: 17,
    pitchDown: -0.55,
    pitchUp: 0.45,
    pitchLerp: 2.8,
    naturalGlide: -0.14, // 无输入的自然下滑角
    stallSpeed: 5, // 空速不足强制低头
    trade: 1.15, // 重力↔空速的能量交换系数
    drag: 0.05, // 与速度成正比的巡航阻力
    dragBase: 0.15,
    engageVy: 1.2, // 上升余势衰减到此值后滑翔接管
    flapSpeed: 9.5, // 拍翅注入的空速
    flapPitch: 0.3, // 拍翅抬头角
  },
};

export interface PhysicsInput {
  moveX: number; // -1..1 屏幕系（W=-Z 方向等，与 WASD 同约定）
  moveZ: number;
  running: boolean;
  jumpPressed: boolean; // 本帧按下跳跃（沿）
  glideHeld: boolean; // 空格按住达到滑翔意图（时长阈值已在外层判断）
  camYaw: number; // 输入方向从相机系转世界系用
}

export type PhysicsEvent =
  | { type: "jump" }
  | { type: "flap" }
  | { type: "land"; impact: number } // impact = 落地时的 |vy|
  | { type: "glide"; open: boolean }
  | { type: "water"; enter: boolean };

/** 暖气流：篝火广场与灯塔山丘上空有柔和的上升气流（外力场） */
function updraftAt(x: number, z: number, y: number): number {
  let u = 0;
  const dFire = Math.hypot(x, z);
  if (dFire < 7 && y < 10) u += 3.4 * (1 - dFire / 7);
  const dHill = Math.hypot(x - 26, z + 28);
  if (dHill < 6 && y < 16) u += 2.8 * (1 - dHill / 6);
  return u;
}

export class CharacterPhysics {
  readonly vel = new THREE.Vector3(); // xz 水平 + y 垂直（统一在速度向量里）
  yaw = 0;
  yawVel = 0;
  airborne = false;
  gliding = false;
  inWater = false;
  flaps = MAX_FLAPS;
  flapTimer = 0; // mov=4 的显示时长
  glidePitch = 0;
  glideSpeed = 0;
  glideEngaged = false;
  private flapRegenT = 0;
  private wasAirborne = false;

  constructor(readonly pos: THREE.Vector3) {}

  get horizSpeed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  snapTo(x: number, z: number) {
    this.pos.set(x, terrainHeight(x, z), z);
    this.vel.set(0, 0, 0);
    this.airborne = false;
    this.gliding = false;
    this.glideEngaged = false;
    this.glidePitch = 0;
    this.glideSpeed = 0;
    this.inWater = false;
  }

  step(dt: number, input: PhysicsInput, events: PhysicsEvent[]) {
    const G = FEEL;
    this.flapTimer = Math.max(0, this.flapTimer - dt);

    const seaFloor = terrainHeight(this.pos.x, this.pos.z);
    const standable = standGroundHeight(this.pos);
    const solidGround = Math.max(seaFloor, standable); // 不含水面的可站地面
    const seaHere = solidGround < WATER_LEVEL - 0.8; // 脚下是海（深水区才游，浅滩照走）
    const waterSurface = WATER_LEVEL;

    // ---- 水面进出判定 ----
    if (seaHere && !this.inWater && !this.airborne && this.pos.y < waterSurface - 0.02 && this.pos.y <= solidGround + 0.05) {
      // 从浅滩走进深水：贴地走到海面以下时转入浮游
      if (this.pos.y < waterSurface - 0.05) {
        this.inWater = true;
        this.vel.y = Math.min(this.vel.y, 0.5);
        events.push({ type: "water", enter: true });
      }
    } else if (this.inWater && (!seaHere || this.pos.y > waterSurface + 0.15)) {
      this.inWater = false;
      events.push({ type: "water", enter: false });
    }
    // 空中落进深水
    if (seaHere && this.airborne && this.pos.y < waterSurface - 0.1) {
      this.airborne = false;
      this.gliding = false;
      this.glideEngaged = false;
      this.inWater = true;
      this.vel.y *= 0.25; // 入水阻尼
      events.push({ type: "water", enter: true });
    }

    // ---- 跳跃 / 拍翅（事件消费） ----
    if (input.jumpPressed) {
      if (this.inWater) {
        // 水中跃出水面
        this.vel.y = G.waterJump;
        this.inWater = false;
        this.airborne = true;
        events.push({ type: "jump" });
      } else if (!this.airborne) {
        this.vel.y = G.jumpImpulse;
        this.airborne = true;
        events.push({ type: "jump" });
      } else if (this.flaps > 0) {
        this.flaps--;
        this.flapTimer = 0.28;
        if (this.glideEngaged) {
          // 滑翔中拍翅 = 光翼冲程：注入能量并抬头，随后的能量公式自然转成爬升
          this.glideSpeed = Math.min(G.glide.maxSpeed, Math.max(this.glideSpeed, G.glide.flapSpeed));
          this.glidePitch = Math.max(this.glidePitch, G.glide.flapPitch);
        } else {
          this.vel.y = 7.0;
        }
        events.push({ type: "flap" });
      }
    }

    // ---- 滑翔接管时机：上升余势先自然衰减 ----
    if (input.glideHeld && this.airborne && !this.inWater) {
      if (!this.glideEngaged && this.vel.y < G.glide.engageVy) this.glideEngaged = true;
    } else {
      this.glideEngaged = false;
    }
    const glidingNow = this.glideEngaged;
    if (glidingNow !== this.gliding) {
      this.gliding = glidingNow;
      if (glidingNow) this.glideSpeed = Math.max(4, this.horizSpeed);
      events.push({ type: "glide", open: glidingNow });
    }

    // ---- 输入方向（相机系 → 世界系）：前 = -(sin,cos)，右 = (cos,-sin) ----
    const ilen = Math.hypot(input.moveX, input.moveZ);
    let wishX = 0;
    let wishZ = 0;
    let wishLen = 0;
    if (ilen > 0.01) {
      const dx = input.moveX / ilen;
      const dz = input.moveZ / ilen;
      const cos = Math.cos(input.camYaw);
      const sin = Math.sin(input.camYaw);
      wishX = (dx * cos + dz * sin);
      wishZ = (-dx * sin + dz * cos);
      wishLen = Math.min(1, ilen);
    }

    if (this.inWater) {
      // ================= SWIM：浮力 + 游泳 =================
      // 目标深度：默认浮在水面下一点，按住 S（后拉）下潜
      const targetY = waterSurface + (input.moveZ > 0.4 ? G.swimDiveY : G.swimSurfaceY);
      // 浮力弹簧 + 阻尼（水的阻尼远大于空气）
      this.vel.y += ((targetY - this.pos.y) * G.buoyK - this.vel.y * G.buoyC) * dt;
      // 水平游泳
      const cap = G.swimSpeed;
      const tx = wishX * cap * wishLen;
      const tz = wishZ * cap * wishLen;
      this.approachVelocity(tx, tz, G.swimAccel, dt);
      // 朝向游动方向
      this.faceVelocity(dt, 6);
      // 翼能回充（浮在水面也回）
      this.regenFlaps(dt);
      this.integrate(dt);
      // 不贴海底（浮力已把人托在水面）；越过浅滩边界自然退出水中
    } else if (this.glideEngaged) {
      // ================= GLIDE：能量飞行（俯冲攒速度、拉起换高度） =================
      const GL = G.glide;
      // 俯仰目标：前推(moveZ<0)=俯冲机头，后拉=爬升；无输入回中自然下滑角
      let pitchTarget = input.moveZ === 0 ? GL.naturalGlide : THREE.MathUtils.clamp(input.moveZ * 0.5, GL.pitchDown, GL.pitchUp);
      if (this.glideSpeed < GL.stallSpeed) pitchTarget = Math.min(pitchTarget, -0.25); // 失速低头
      this.glidePitch = THREE.MathUtils.lerp(this.glidePitch, pitchTarget, Math.min(1, dt * GL.pitchLerp));
      const sinP = Math.sin(this.glidePitch);
      const cosP = Math.cos(this.glidePitch);
      // 重力沿航向分量：爬升耗空速、俯冲补空速（能量交换）
      this.glideSpeed += -G.gravity * sinP * GL.trade * dt;
      this.glideSpeed -= (GL.dragBase + this.glideSpeed * GL.drag) * dt; // 巡航阻力
      this.glideSpeed = THREE.MathUtils.clamp(this.glideSpeed, GL.minSpeed, GL.maxSpeed);
      // 垂直 = 航迹垂直分量 + 暖气流托举
      this.vel.y = this.glideSpeed * sinP + updraftAt(this.pos.x, this.pos.z, this.pos.y) * 0.85;
      // 水平沿航向（转弯=转航向）
      const hs = this.glideSpeed * cosP;
      this.vel.x = Math.sin(this.yaw) * hs;
      this.vel.z = Math.cos(this.yaw) * hs;
      // A/D 倾斜转弯：速度越快转弯率越紧（大速度=大转弯半径）。
      // 注意符号：相机在角色后方，yaw 增大在画面上是左转——D(右)必须 yaw 减
      const turnRate = THREE.MathUtils.clamp(2.2 - this.glideSpeed * 0.06, 0.8, 2.2);
      if (input.moveX !== 0) {
        this.yaw -= input.moveX * turnRate * dt;
        this.yawVel = THREE.MathUtils.lerp(this.yawVel, -input.moveX * turnRate, Math.min(1, dt * 6));
      } else {
        this.yawVel = THREE.MathUtils.lerp(this.yawVel, 0, Math.min(1, dt * 4));
      }
      this.integrate(dt);
    } else if (this.airborne) {
      // ================= AIR：自由落体（软重力 + 终端速度） =================
      this.vel.y -= G.gravity * dt;
      const up = updraftAt(this.pos.x, this.pos.z, this.pos.y);
      this.vel.y += up * 0.45 * dt; // 未展翼时暖流只轻微上托
      if (this.vel.y < G.fallTerminal) this.vel.y = G.fallTerminal;
      // 空中微操：轻微推力，普通跳跃不凭空获得前进速度（无输入时只有阻力）
      const cap = Math.max(3.2, this.horizSpeed);
      const tx = wishX * cap * wishLen;
      const tz = wishZ * cap * wishLen;
      this.approachVelocity(tx, tz, wishLen > 0 ? G.airAccel : G.airDrag, dt);
      this.faceVelocity(dt, 9);
      this.integrate(dt);
    } else {
      // ================= GROUND：惯性起步/收步 + 坡度 =================
      const cap = input.running ? G.runSpeed : G.walkSpeed;
      const tx = wishX * cap * wishLen;
      const tz = wishZ * cap * wishLen;
      const accel = wishLen > 0.01 ? G.groundAccel : G.groundFriction;
      this.approachVelocity(tx, tz, accel, dt);
      // 坡度力：沿速度方向采样地形，上坡减速、下坡加速；陡坡滑坡（光遇的沙丘感）
      const sp = this.horizSpeed;
      if (sp > 0.15) {
        const nx = this.vel.x / sp;
        const nz = this.vel.z / sp;
        const ahead = terrainHeight(this.pos.x + nx * 0.5, this.pos.z + nz * 0.5);
        const behind = terrainHeight(this.pos.x - nx * 0.5, this.pos.z - nz * 0.5);
        const slope = ahead - behind; // >0 上坡
        if (slope > G.slopeSlide) {
          // 陡上坡：蹬不上去，往回溜
          this.vel.x -= nx * G.slopeAccel * dt;
          this.vel.z -= nz * G.slopeAccel * dt;
        } else if (slope < -G.slopeSlide) {
          // 陡下坡：滑坡加速，输入减半
          this.vel.x += -nx * G.slopeAccel * dt;
          this.vel.z += -nz * G.slopeAccel * dt;
        } else {
          this.vel.x -= nx * slope * 2.2 * dt;
          this.vel.z -= nz * slope * 2.2 * dt;
        }
      }
      this.faceVelocity(dt, 9);
      this.regenFlaps(dt);
      this.integrate(dt);
      // 贴地（含水面行走的浅滩：水面在地面之上时按水面走，旧逻辑保留）
      const ground = Math.max(solidGround, seaHere ? -Infinity : WATER_LEVEL - 0.25);
      if (this.pos.y < ground) this.pos.y = ground;
      // 走下悬崖 → 腾空
      if (this.pos.y > ground + 0.08) {
        this.pos.y = Math.max(this.pos.y - 0.5 * dt, ground); // 沿坡下滑贴合，避免悬空抖动
        if (this.pos.y > ground + 0.5) this.airborne = true;
      } else {
        // 地面贴合的柔性吸附（下坡不弹跳）
        this.pos.y = THREE.MathUtils.lerp(this.pos.y, ground, Math.min(1, dt * 14));
      }
    }

    // ---- 实体碰撞 + 岛界（所有模式统一） ----
    resolveColliders(this.pos, this.vel);
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > ISLAND_RADIUS - 1) {
      this.pos.x *= (ISLAND_RADIUS - 1) / r;
      this.pos.z *= (ISLAND_RADIUS - 1) / r;
    }

    // ---- 落地检测 ----
    if (this.airborne) {
      const ground = Math.max(terrainHeight(this.pos.x, this.pos.z), standGroundHeight(this.pos), seaHere ? -Infinity : WATER_LEVEL - 0.25);
      if (this.pos.y <= ground) {
        const impact = Math.abs(this.vel.y);
        this.pos.y = ground;
        this.airborne = false;
        this.vel.y = 0;
        this.glideEngaged = false;
        this.glidePitch = 0;
        if (this.gliding) {
          this.gliding = false;
          events.push({ type: "glide", open: false });
        }
        events.push({ type: "land", impact });
      }
    }
    this.wasAirborne = this.airborne;
    void this.wasAirborne;
  }

  /** 朝目标水平速度加速/减速，最多 accel·dt（真加速度而非 lerp） */
  private approachVelocity(tx: number, tz: number, accel: number, dt: number) {
    const dx = tx - this.vel.x;
    const dz = tz - this.vel.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-5) return;
    const step = Math.min(d, accel * dt);
    this.vel.x += (dx / d) * step;
    this.vel.z += (dz / d) * step;
  }

  /** 朝向平滑转向速度方向（地/空模式用） */
  private faceVelocity(dt: number, rate: number) {
    const sp = this.horizSpeed;
    if (sp > 0.3) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      let diff = targetYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const step = diff * Math.min(1, dt * rate);
      this.yaw += step;
      this.yawVel = THREE.MathUtils.lerp(this.yawVel, step / Math.max(dt, 1e-4), Math.min(1, dt * 8));
    } else {
      this.yawVel = THREE.MathUtils.lerp(this.yawVel, 0, Math.min(1, dt * 6));
    }
  }

  /** 翼能回充 */
  private regenFlaps(dt: number) {
    if (this.flaps < MAX_FLAPS) {
      this.flapRegenT += dt;
      if (this.flapRegenT > 1.1) {
        this.flapRegenT = 0;
        this.flaps++;
      }
    } else {
      this.flapRegenT = 0;
    }
  }

  private integrate(dt: number) {
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    if (this.airborne || this.inWater) this.pos.y += this.vel.y * dt;
    this.vel.y = Math.min(this.vel.y, 12);
  }
}
