import * as THREE from "three";
import type { RemotePlayers } from "./remote";
import { LANDMARKS, terrainHeight } from "./heightfield";
import { resolveColliders } from "./colliders";
import { TRACKS } from "./audio/tracks";

/**
 * 连不上服务器时的「岛上原有的旅人」：
 * 五位 NPC 各带一首歌，在地标之间慢慢走，偶尔坐下。
 * 走近他们，同样能听见歌渐渐变清晰。
 */
interface NpcState {
  key: string;
  target: THREE.Vector3;
  waitUntil: number;
  sitUntil: number;
  stuckFor: number; // 被实体挡住的累计时长（卡住就换目的地）
}

const NPC_NAMES = ["海风的诗", "星屑收集者", "花田看守", "潮汐信使", "拾光的人"];

/** 选一个旱地落脚点：地标±散布多次采样，直到地形高于水面余量——
 *  岸环洼地(湖)在 r≈45+ 一带，南沙岸/东北滩这类地标散出去就是水里 */
function pickDrySpot(): THREE.Vector3 {
  for (let tries = 0; tries < 10; tries++) {
    const spot = LANDMARKS[Math.floor(Math.random() * LANDMARKS.length)];
    const x = spot.x + (Math.random() - 0.5) * 10;
    const z = spot.z + (Math.random() - 0.5) * 10;
    if (terrainHeight(x, z) > 0.9) return new THREE.Vector3(x, 0, z);
  }
  // 采不到就回广场（一定干燥）
  return new THREE.Vector3((Math.random() - 0.5) * 8, 0, (Math.random() - 0.5) * 8);
}

export class NpcDriver {
  private npcs: NpcState[] = [];
  private t = 0;
  /** 黄昏音乐会：老住户们围到篝火旁坐下（座位=篝火木凳圈） */
  private concert = false;

  setConcert(on: boolean) {
    this.concert = on;
    if (on) {
      this.npcs.forEach((n, i) => {
        const a = (i / Math.max(1, this.npcs.length)) * Math.PI * 2 + 0.4;
        n.target.set(Math.cos(a) * 3.0, 0, Math.sin(a) * 3.0);
        n.waitUntil = 0;
        n.sitUntil = 0;
        n.stuckFor = 0;
      });
    }
  }

  constructor(private remotes: RemotePlayers) {
    NPC_NAMES.forEach((name, i) => {
      const key = `npc-${i}`;
      const spot = LANDMARKS[(i + 1) % LANDMARKS.length];
      // 出生点也要旱地：向地标中心回拉直到高于水面
      let x = spot.x + (Math.random() - 0.5) * 6;
      let z = spot.z + (Math.random() - 0.5) * 6;
      for (let tries = 0; tries < 8 && terrainHeight(x, z) < 0.9; tries++) {
        x = x * 0.7 + spot.x * 0.3;
        z = z * 0.7 + spot.z * 0.3;
      }
      const track = TRACKS[i % TRACKS.length];
      this.remotes.spawn(key, {
        name,
        hue: (i * 67 + 30) % 360,
        trackId: track.id,
        // 歌已经放了一会儿了
        startedAt: Date.now() - Math.random() * 180000,
        x,
        y: terrainHeight(x, z),
        z,
        ry: Math.random() * Math.PI * 2,
      });
      this.npcs.push({
        key,
        target: new THREE.Vector3(x, 0, z),
        waitUntil: this.t + Math.random() * 4,
        sitUntil: 0,
        stuckFor: 0,
      });
    });
  }

  update(dt: number) {
    this.t += dt;
    for (const n of this.npcs) {
      // 黄昏音乐会：走向篝火座位，到达即坐下（朝向火心）
      if (this.concert) {
        this.remotes.drive(n.key, ({ pos, target }) => {
          const to = n.target;
          const dx = to.x - pos.x;
          const dz = to.z - pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.9) {
            target.sit = true;
            target.mov = 0;
            target.ry = Math.atan2(-pos.x, -pos.z); // 面向篝火(0,0)
            return;
          }
          target.sit = false;
          const speed = 2.4;
          pos.x += (dx / d) * speed * dt;
          pos.z += (dz / d) * speed * dt;
          pos.y = terrainHeight(pos.x, pos.z);
          target.x = pos.x;
          target.y = pos.y;
          target.z = pos.z;
          target.ry = Math.atan2(dx, dz);
          target.mov = 1;
        });
        continue;
      }
      this.remotes.drive(n.key, ({ pos, target }) => {
        // 正在坐
        if (this.t < n.sitUntil) {
          target.sit = true;
          target.mov = 0;
          return;
        }
        target.sit = false;

        if (this.t < n.waitUntil) {
          target.mov = 0;
          return;
        }

        const to = n.target;
        const dx = to.x - pos.x;
        const dz = to.z - pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.6) {
          // 到达：挑下一个目的地或原地小坐
          if (Math.random() < 0.45) {
            n.sitUntil = this.t + 5 + Math.random() * 7;
          } else {
            n.target.copy(pickDrySpot());
          }
          n.waitUntil = this.t + 1 + Math.random() * 3;
          return;
        }

        // 走进水里了（目标点在岸环洼地）→ 立刻换个旱地目标
        if (terrainHeight(pos.x, pos.z) < 0.7) {
          n.target.copy(pickDrySpot());
          return;
        }

        const speed = 1.5;
        pos.x += (dx / d) * speed * dt;
        pos.z += (dz / d) * speed * dt;
        // 老住户也绕开树石灯塔；直线走被挡住太久就换个目的地
        if (resolveColliders(pos, null, 0.34)) {
          n.stuckFor += dt;
          if (n.stuckFor > 1.2) {
            n.target.copy(pickDrySpot());
            n.stuckFor = 0;
          }
        } else {
          n.stuckFor = 0;
        }
        pos.y = terrainHeight(pos.x, pos.z);
        target.x = pos.x;
        target.y = pos.y;
        target.z = pos.z;
        target.ry = Math.atan2(dx, dz);
        target.mov = 1;
      });
    }
  }
}
