import * as THREE from "three";
import { createWorld } from "./world/scene";
import { HandLinks } from "./world/handlink";
import { PlayerControls } from "./controls";
import { createAvatar, type Avatar, type AvatarModel } from "./avatar";
import { MusicEngine, AUDIBLE_R } from "./audio/engine";
import { trackById, trackMeta, URL_TRACK, urlHost } from "./audio/tracks";
import { RemotePlayers } from "./remote";
import { connectIsland, type NetHandle } from "./net";
import { NpcDriver } from "./npcs";
import { createUI } from "./ui";
import { terrainHeight } from "./heightfield";

/**
 * 音遇 · 客户端主流程
 * 世界 → 入场 → 联机(或独自漫游) → 听歌 → 走近谁，就听见谁
 */

const app = document.getElementById("app")!;
const world = createWorld(app);
const controls = new PlayerControls(world.camera, app);
const music = new MusicEngine();
music.onNotice = (msg) => ui && ui.toast(msg, 3600);
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
let selectedAvatar: AvatarModel = "classic";
let entered = false;

// ---- 牵手（光遇式：走近邀请 → 对方同意 → 牵着走/飞） ----
const handLinks = new HandLinks();
world.addToScene(handLinks.mesh);
/** 自己当前的牵手状态（服务器权威，经 onHandChange 更新） */
const hand = { withId: "", lead: false };
/** 手腕世界坐标缓存（光带端点） */
const wristA = new THREE.Vector3();
const wristB = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const followTarget = new THREE.Vector3();

/** 两人手腕位置：脚底 + 朝对方方向 0.42m + 高 0.98m */
function wristOf(pos: THREE.Vector3, dirToOther: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(pos).addScaledVector(dirToOther, 0.42);
  out.y += 0.98;
  return out;
}

const ui = createUI({
  onEnter: handleEnter,
  onAvatarChange: (model) => {
    selectedAvatar = model;
  },
  onPickTrack: (id, name) => {
    music.setOwnTrack(id, name ?? "");
    net?.sendTrack(id, name);
    ui.setNowPlaying(id, name ?? "");
    ui.setPlayState("playing");
    music.sfxChime();
  },
  onPickUrl: (url, name) => {
    music.setOwnTrack(URL_TRACK, name, url);
    net?.sendTrack(URL_TRACK, name, undefined, url);
    ui.setNowPlaying(URL_TRACK, name || urlHost(url));
    ui.setPlayState("playing");
    music.sfxChime();
  },
  onTogglePlay: () => {
    if (music.ownTrackId < 0) {
      ui.openPicker();
      return;
    }
    if (music.isOwnPaused) {
      const resumeMs = music.resumeOwn(ui.currentSongName);
      net?.sendTrack(music.ownTrackId, ui.currentSongName, resumeMs, music.ownUrl);
      ui.setPlayState("playing");
    } else {
      music.pauseOwn();
      net?.sendTrack(-1);
      ui.setPlayState("paused");
    }
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
  net = await connectIsland(name, remotes, selectedAvatar, {
    onInvite: (from, fromName) => {
      if (hand.withId) {
        // 已牵着别人：直接婉拒
        net?.sendHandReject(from);
        return;
      }
      music.sfxChime();
      ui.showInvite(
        fromName,
        () => net?.sendHandAccept(from),
        () => net?.sendHandReject(from)
      );
    },
    onResult: (kind, who) => {
      if (kind === "busy") ui.toast("对方已经牵着别人了");
      else if (kind === "far") ui.toast("走近一点再伸手吧");
      else if (kind === "reject") ui.toast(`${who ?? "对方"} 婉拒了牵手`);
    },
    onHandChange: (withId, lead) => {
      if (withId && !hand.withId) {
        const other = remotes.statsOf(withId);
        ui.toast(`和 ${other?.name ?? "旅人"} 手牵着手`);
        music.sfxChime();
      } else if (!withId && hand.withId) {
        ui.toast("松开了手");
        selfAvatar?.setHand(null);
      }
      hand.withId = withId;
      hand.lead = lead;
      controls.setLed(!!withId && !lead);
    },
  },
  // 聊天气泡：自己的回声和别人的话都从这进；别人的话只有走近才看得见（光遇式就近可闻）
  (from, fromName, text) => {
    if (from === net?.sessionId) {
      selfAvatar?.say(text);
      return;
    }
    const av = remotes.avatarOf(from);
    if (!av) return;
    const dist = av.group.position.distanceTo(selfAvatar?.group.position ?? av.group.position);
    if (dist <= 20) av.say(text);
  });
  if (net) {
    ui.setStatus("online");
    ui.setSongOwner(net.sessionId);
  } else {
    ui.setStatus("solo");
    // 独自漫游时没有会话 id，用本地随机 id（HTTP 直传仍可用，重启时清理）
    ui.setSongOwner("solo-" + Math.random().toString(36).slice(2, 10));
    npcs = new NpcDriver(remotes);
    ui.toast("岛上今天只有你——不过还有几位老住户在散步", 3600);
  }

  // 静默进岛：默认不放音乐，想听自己点「换歌」；
  // 也可以什么都不选，只听身边人的世界
  ui.setNowPlaying(-1);
  ui.setPlayState("none");

  controls.setEnabled(true);
  ui.entered();
  ui.toast("欢迎来到音遇——选一首歌，或安静地走走", 4200);
}

function spawnSelf() {
  const a = Math.random() * Math.PI * 2;
  const x = Math.cos(a) * 8;
  const z = Math.sin(a) * 8;
  selfAvatar = createAvatar({ name: playerName, hue: selfHue, self: true, model: selectedAvatar });
  world.addToScene(selfAvatar.group);
  // 光遇式的动作反馈：动作 → 音效 + 瞬态光效
  const ringColor = () => new THREE.Color(trackMeta(music.ownTrackId, ui.currentSongName, music.ownUrl).color);
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
    get selfAvatar() {
      return selfAvatar;
    },
    /** 测试钩子：手动泵帧（隐藏页 rAF 冻结时驱动同一份主循环逻辑） */
    step(frames = 1) {
      for (let i = 0; i < frames; i++) tick(1 / 60);
    },
  };
}

// ---------------- 聊天气泡：回车打开输入，再回车发送，Esc 取消 ----------------
const chatInput = document.createElement("input");
chatInput.maxLength = 80;
chatInput.placeholder = "说点什么…（Enter 发送，Esc 取消）";
chatInput.autocomplete = "off";
chatInput.style.cssText = [
  "position:fixed", "left:50%", "bottom:13%", "transform:translateX(-50%)",
  "width:min(430px,74vw)", "padding:11px 18px", "border-radius:999px",
  "border:1.5px solid rgba(255,244,214,.55)", "background:rgba(26,18,42,.88)",
  "color:#fff6e6", "font-size:16px", "letter-spacing:.5px", "outline:none",
  "box-shadow:0 6px 24px rgba(10,6,20,.45)", "display:none", "z-index:40",
].join(";");
document.body.appendChild(chatInput);

function openChat() {
  chatInput.style.display = "block";
  chatInput.value = "";
  document.exitPointerLock?.();
  chatInput.focus();
}
function closeChat() {
  chatInput.style.display = "none";
  chatInput.blur();
}
function submitChat() {
  const text = chatInput.value.trim();
  closeChat();
  if (!text) return;
  if (net) net.sendChat(text);
  else selfAvatar?.say(text); // 独自漫游时也让自己说出来
}
chatInput.addEventListener("keydown", (e) => {
  e.stopPropagation(); // 别让 W/E/空格漏给游戏按键
  if (e.key === "Enter") submitChat();
  else if (e.key === "Escape") closeChat();
});

// ---------------- 牵手按键：G 邀请/松手 · F 接受 · Enter 聊天 ----------------
window.addEventListener("keydown", (e) => {
  if (!entered || e.repeat) return;
  if ((e.target as HTMLElement | null)?.matches?.("input, textarea, [contenteditable]")) return;
  const k = e.key.toLowerCase();
  if (k === "enter") {
    if (chatInput.style.display === "none") openChat();
    return;
  }
  if (k === "f") {
    ui.acceptInvite();
  } else if (k === "g") {
    if (ui.hasInvite()) {
      ui.rejectInvite();
    } else if (hand.withId) {
      net?.sendHandRelease();
    } else if (!net) {
      ui.toast("独自漫游的岛上，只有你和老住户…");
    } else {
      // 邀请 5 米内最近的真人玩家（npc- 前缀是离线演示住户，不参与牵手）
      const near = remotes
        .infos(controls.state.pos)
        .filter((i) => i.dist < 5 && !i.key.startsWith("npc-"))
        .sort((a, b) => a.dist - b.dist)[0];
      if (!near) ui.toast("附近没有可以牵手的人");
      else {
        net.sendHandInvite(near.key);
        ui.toast(`向 ${near.name} 伸出手，等待回应…`, 4000);
      }
    }
  }
});

// ---------------- 主循环 ----------------
const clock = new THREE.Clock();
let uiTimer = 0;
const nearBefore = new Map<string, boolean>();
/** 模拟时钟（测试钩子 crescendo.step 在 rAF 冻结时也走同一份逻辑） */
let simT = 0;

function loop() {
  requestAnimationFrame(loop);
  tick(Math.min(clock.getDelta(), 0.05));
}

function tick(dt: number) {
  simT += dt;
  const t = simT;

  if (!entered) {
    // 入场前的环岛镜头
    controls.cinematicOrbit(t);
    world.render(dt, t);
    return;
  }

  // ---- 牵手·被牵跟随：位置物理换成「被队长牵着」 ----
  if (entered && hand.withId && !hand.lead) {
    const lead = remotes.statsOf(hand.withId);
    const leadPos = remotes.posOf(hand.withId);
    if (!lead || !leadPos) {
      net?.sendHandRelease(); // 队长掉线/离开
    } else {
      const s = controls.state;
      const flying = lead.mov >= 3 || leadPos.y - terrainHeight(leadPos.x, leadPos.z) > 0.8;
      // 待在队长右手边 0.78m（恰好是牵手距离）
      const sideX = Math.cos(lead.yaw);
      const sideZ = -Math.sin(lead.yaw);
      followTarget.set(leadPos.x + sideX * 0.78, leadPos.y, leadPos.z + sideZ * 0.78);
      if (!flying) followTarget.y = Math.max(terrainHeight(followTarget.x, followTarget.z), followTarget.y);
      const k = Math.min(1, dt * 6);
      const px = s.pos.x, py = s.pos.y, pz = s.pos.z;
      s.pos.lerp(followTarget, k);
      let dy = lead.yaw - s.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      s.yaw += dy * k;
      s.airborne = flying;
      s.mov = flying ? lead.mov : lead.mov >= 3 ? 0 : lead.mov;
      s.sit = false;
      // 喂给动画/披风的运动量（本帧位移差分，限幅防网络尖峰）
      const clampV = (x: number) => Math.max(-9, Math.min(9, x));
      controls.setCarriedMotion(clampV(Math.hypot(s.pos.x - px, s.pos.z - pz) / Math.max(dt, 1e-3)), clampV((s.pos.y - py) / Math.max(dt, 1e-3)));
    }
  }

  controls.update(dt);
  if (selfAvatar) {
    const s = controls.state;
    selfAvatar.group.position.copy(s.pos);
    selfAvatar.group.rotation.y = s.yaw;
    const speed = controls.horizSpeed;
    const air = s.mov === 3 || s.mov === 4 ? 2 : s.airborne ? 1 : 0;
    selfAvatar.animate(dt, t, speed, s.sit, air, s.yawVel, { vy: controls.verticalVel, vx: controls.horizVel.x, vz: controls.horizVel.z });
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
      songUrl: remotes.songUrlOf(i.key),
    }))
  );
  // 光环节拍能量（文件源用实时频谱，生成式用相位）
  const beatMap = new Map<string, number>();
  for (const i of infos) if (i.dist < AUDIBLE_R) beatMap.set(i.key, music.beatEnv(i.key));
  remotes.animate(dt, t, clarity, beatMap);

  // ---- 牵手视觉：手臂朝向 + 光带（自己参与的与他人之间的都要画） ----
  {
    const pairs: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
    const touched = new Set<string>();
    const selfPos = controls.state.pos;
    if (hand.withId && selfAvatar) {
      const otherPos = remotes.posOf(hand.withId);
      if (otherPos) {
        tmpDir.copy(otherPos).sub(selfPos);
        tmpDir.y = 0;
        const d = tmpDir.length();
        if (d > 1e-3) {
          tmpDir.divideScalar(d);
          selfAvatar.setHand(tmpDir);
          remotes.setHandOf(hand.withId, tmpDir.clone().negate());
          touched.add(hand.withId);
          pairs.push({
            a: wristOf(selfPos, tmpDir, new THREE.Vector3()),
            b: wristOf(otherPos, tmpDir.clone().negate(), new THREE.Vector3()),
          });
        }
      }
    }
    // 他人之间的牵手（旁观时也看得见光带）
    remotes.forEachRemote((key, pos, _yaw, withId) => {
      if (!withId || withId === net?.sessionId) return;
      if (key > withId) return; // 每对只画一次
      const other = remotes.posOf(withId);
      if (!other) return;
      tmpDir.copy(other).sub(pos);
      tmpDir.y = 0;
      const dd = tmpDir.length();
      if (dd < 1e-3) return;
      tmpDir.divideScalar(dd);
      remotes.setHandOf(key, tmpDir);
      remotes.setHandOf(withId, tmpDir.clone().negate());
      touched.add(key);
      touched.add(withId);
      pairs.push({
        a: wristOf(pos, tmpDir, new THREE.Vector3()),
        b: wristOf(other, tmpDir.clone().negate(), new THREE.Vector3()),
      });
    });
    // 没在牵手的远程小人清掉残留姿势
    remotes.forEachRemote((key, _pos, _yaw, withId) => {
      if (!touched.has(key)) remotes.setHandOf(key, null);
    });
    handLinks.update(pairs, t);
  }

  music.ambient(
    t,
    Math.hypot(controls.state.pos.x, controls.state.pos.z),
    world.campfire.position.distanceTo(controls.state.pos),
    controls.state.airborne ? controls.horizSpeed : 0,
    controls.state.airborne,
    controls.verticalVel
  );
  // 滑翔风线与瞬态光效
  world.wind.update(dt, t, controls.state.pos, controls.horizVel);
  world.bursts.update(dt);

  // 自己的光环（听歌且未暂停时亮着）
  if (selfAvatar) {
    const beat = music.beatEnv("self");
    const meta = trackMeta(music.ownTrackId, ui.currentSongName, music.ownUrl);
    const active = music.ownTrackId >= 0 && !music.isOwnPaused;
    selfAvatar.setRing(active ? new THREE.Color(meta.color) : null, active ? 0.5 + 0.4 * beat : 0);
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
