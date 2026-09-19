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

export class NpcDriver {
  private npcs: NpcState[] = [];
  private t = 0;

  constructor(private remotes: RemotePlayers) {
    NPC_NAMES.forEach((name, i) => {
      const key = `npc-${i}`;
      const spot = LANDMARKS[(i + 1) % LANDMARKS.length];
      const x = spot.x + (Math.random() - 0.5) * 6;
      const z = spot.z + (Math.random() - 0.5) * 6;
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
            const spot = LANDMARKS[Math.floor(Math.random() * LANDMARKS.length)];
            n.target.set(
              spot.x + (Math.random() - 0.5) * 10,
              0,
              spot.z + (Math.random() - 0.5) * 10
            );
          }
          n.waitUntil = this.t + 1 + Math.random() * 3;
          return;
        }

        const speed = 1.5;
        pos.x += (dx / d) * speed * dt;
        pos.z += (dz / d) * speed * dt;
        // 老住户也绕开树石灯塔；直线走被挡住太久就换个目的地
        if (resolveColliders(pos, null, 0.34)) {
          n.stuckFor += dt;
          if (n.stuckFor > 1.2) {
            const spot = LANDMARKS[Math.floor(Math.random() * LANDMARKS.length)];
            n.target.set(
              spot.x + (Math.random() - 0.5) * 10,
              0,
              spot.z + (Math.random() - 0.5) * 10
            );
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
