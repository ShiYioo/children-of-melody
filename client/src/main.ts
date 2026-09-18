import * as THREE from "three";
import { createWorld } from "./world/scene";
import { PlayerControls } from "./controls";
import { createAvatar, type Avatar } from "./avatar";
import { MusicEngine, AUDIBLE_R } from "./audio/engine";
import { trackById, trackMeta } from "./audio/tracks";
import { RemotePlayers } from "./remote";
import { connectIsland, type NetHandle } from "./net";
import { NpcDriver } from "./npcs";
import { createUI } from "./ui";

/**
 * 渐强之岛 · 客户端主流程
 * 世界 → 入场 → 联机(或独自漫游) → 听歌 → 走近谁，就听见谁
 */

const app = document.getElementById("app")!;
const world = createWorld(app);
const controls = new PlayerControls(world.camera, app);
const music = new MusicEngine();
const remotes = new RemotePlayers();
remotes.bindScene(
  (o) => world.addToScene(o),
  (o) => world.scene.remove(o)
);
remotes.bindFX({
  burst: (pos, color, kind) => world.bursts.burst(pos, color, kind),
  sfxFlap: () => music.sfxFlap(),
  sfxLand: () => music.sfxLand(),
});

let selfAvatar: Avatar | null = null;
let net: NetHandle | null = null;
let npcs: NpcDriver | null = null;
let playerName = "旅人";
let selfHue = Math.floor(Math.random() * 360);
let entered = false;

const ui = createUI({
  onEnter: handleEnter,
  onPickTrack: (id, name) => {
    music.setOwnTrack(id, name ?? "");
    net?.sendTrack(id, name);
    ui.setNowPlaying(id, name ?? "");
    music.sfxChime();
  },
});
ui.focusName();

async function handleEnter(name: string) {
  if (entered) return;
  entered = true;
  playerName = name;

  // 音频必须在用户手势里解锁
  await music.unlock();

  // 先放好自己
  spawnSelf();

  // 连接服务器；失败则进入独自漫游（NPC 陪伴）
  net = await connectIsland(name, remotes);
  if (net) {
    ui.setStatus("online");
  } else {
    ui.setStatus("solo");
    npcs = new NpcDriver(remotes);
    ui.toast("岛上今天只有你——不过还有几位老住户在散步", 3600);
  }

  // 默认给一首歌（随机），立刻就有音乐气泡
  const first = Math.floor(Math.random() * 6);
  music.setOwnTrack(first);
  net?.sendTrack(first);
  ui.setNowPlaying(first);

  controls.setEnabled(true);
  ui.entered();
  ui.toast("走近别人，就能听见他们的歌渐渐变清晰", 4200);
}

function spawnSelf() {
  const a = Math.random() * Math.PI * 2;
  const x = Math.cos(a) * 8;
  const z = Math.sin(a) * 8;
  selfAvatar = createAvatar({ name: playerName, hue: selfHue, self: true });
  world.addToScene(selfAvatar.group);
  // 光遇式的动作反馈：动作 → 音效 + 瞬态光效
  const ringColor = () => new THREE.Color(trackMeta(music.ownTrackId, ui.currentSongName).color);
  controls.onLand = () => {
    selfAvatar?.land();
    music.sfxLand();
    world.bursts.burst(controls.state.pos, ringColor(), "land");
  };
  controls.onFlap = () => {
    selfAvatar?.flap();
    music.sfxFlap();
    world.bursts.burst(controls.state.pos, ringColor(), "flap");
  };
  controls.onJump = () => {
    music.sfxJump();
  };
  controls.onSit = (sitting) => {
    if (sitting) music.sfxSit();
  };
  controls.spawnAt(x, z);
}

// 开发调试钩子（生产构建不打包）
if (import.meta.env.DEV) {
  (window as any).crescendo = {
    controls,
    music,
    remotes,
    world,
    get net() {
      return net;
    },
    get npcs() {
      return npcs;
    },
  };
}

// ---------------- 主循环 ----------------
const clock = new THREE.Clock();
let uiTimer = 0;
const nearBefore = new Map<string, boolean>();

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (!entered) {
    // 入场前的环岛镜头
    controls.cinematicOrbit(t);
    world.render(dt, t);
    return;
  }

  controls.update(dt);
  if (selfAvatar) {
    const s = controls.state;
    selfAvatar.group.position.copy(s.pos);
    selfAvatar.group.rotation.y = s.yaw;
    const speed = controls.horizSpeed;
    const air = s.mov === 3 || s.mov === 4 ? 2 : s.airborne ? 1 : 0;
    selfAvatar.animate(dt, t, speed, s.sit, air, s.yawVel);
    net?.sendPos({ x: s.pos.x, y: s.pos.y, z: s.pos.z, ry: s.yaw, mov: s.mov, sit: s.sit });
  }

  // NPC 漫游
  npcs?.update(dt);

  // 距离混音：只让最近的几首清晰起来
  remotes.setSelfPos(controls.state.pos);
  const infos = remotes.infos(controls.state.pos);
  const clockOffset = net?.clockOffset ?? 0;

  music.tick();
  const clarity = music.mix(
    infos.map((i) => ({
      key: i.key,
      trackId: i.trackId,
      startedAt: remotes.startedAtOf(i.key),
      dist: i.dist,
      clockOffset,
      songName: remotes.songNameOf(i.key),
    }))
  );
  // 光环节拍能量（文件源用实时频谱，生成式用相位）
  const beatMap = new Map<string, number>();
  for (const i of infos) if (i.dist < AUDIBLE_R) beatMap.set(i.key, music.beatEnv(i.key));
  remotes.animate(dt, t, clarity, beatMap);
  music.ambient(
    t,
    Math.hypot(controls.state.pos.x, controls.state.pos.z),
    world.campfire.position.distanceTo(controls.state.pos),
    controls.state.airborne ? controls.horizSpeed : 0
  );
  // 滑翔风线与瞬态光效
  world.wind.update(dt, t, controls.state.pos, controls.horizVel);
  world.bursts.update(dt);

  // 自己的光环（永远亮着）
  if (selfAvatar) {
    const beat = music.beatEnv("self");
    const meta = trackMeta(music.ownTrackId, ui.currentSongName);
    selfAvatar.setRing(music.ownTrackId >= 0 ? new THREE.Color(meta.color) : null, music.ownTrackId >= 0 ? 0.5 + 0.4 * beat : 0);
  }

  // UI 低频刷新 + 靠近提示 + 翼能
  uiTimer += dt;
  if (uiTimer > 0.25) {
    uiTimer = 0;
    ui.setNearby(infos);
    ui.setFlaps(controls.state.flaps);
    for (const i of infos) {
      const near = i.dist < AUDIBLE_R;
      const before = nearBefore.get(i.key) ?? false;
      if (near && !before && i.trackId >= 0) {
        ui.toast(`${i.name} 的歌，渐渐清晰了…`);
      } else if (!near && before) {
        // 淡出了就不打扰
      }
      nearBefore.set(i.key, near);
    }
  }

  world.render(dt, t);
}
loop();
