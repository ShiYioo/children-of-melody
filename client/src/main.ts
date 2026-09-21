import * as THREE from "three";
import { Armchair, Bell, createIcons, Menu, MessageCircle, MoveHorizontal, Music2, Sparkles, Wind } from "lucide";
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
import { createMusicFX } from "./world/musicfx";
import { createFurniture } from "./world/furniture";
import { createToonKit } from "./world/toon";
import { insideAnyCollider } from "./colliders";
import { Instruments, INSTRUMENTS } from "./audio/instruments";
import { makeInstrumentMesh } from "./world/instruments";
import { createTouchUI, isTouchDevice } from "./touch";

/**
 * 音遇 · 客户端主流程
 * 世界 → 入场 → 联机(或独自漫游) → 听歌 → 走近谁，就听见谁
 */

const app = document.getElementById("app")!;
const world = createWorld(app);
const controls = new PlayerControls(world.camera, app);
const music = new MusicEngine();
music.onNotice = (msg) => ui && ui.toast(msg, 3600);
// 音乐动效：分频段包络驱动的地面涟漪 + 音符粒子（挂在场景，主循环里驱动）
const musicfx = createMusicFX();
world.addToScene(musicfx.group);

// ---- 背包家具：椅子 & 双人荡秋千（每人每件放一个，1/2 键放收，靠近 E 坐） ----
const furnKit = createToonKit();
const furniture = createFurniture(furnKit, world.addToScene, (o) => world.scene.remove(o));
/** 自己正坐着的座位 */
let seatedOn: { key: string; seat: number } | null = null;
/** 秋千摆动物理（自己的座位） */
const swingSim = { angle: 0, vel: 0 };
const SWING_ROPE = 1.64; // 绳长（横杆 2.15 − 座面 0.51）
let seatHintAt = -99;

function ownFurnKey(kind: number) {
  return `${net ? net.sessionId : "solo"}:${kind}`;
}

// ---- 手持乐器：3 竖琴 / 4 长笛 / 5 风铃，Q W E R T Y U 弹奏 ----
const instruments = new Instruments();
let playingIdx = -1; // -1 没拿乐器
let baseOctave = 0; // Z/X 变调（-2..2 个八度）
let selfInstrumentMesh: THREE.Group | null = null;
/** 远端身上短暂显示的乐器（收到音符后挂 3 秒） */
const remoteInstruments = new Map<THREE.Group, { mesh: THREE.Group; until: number }>();
const NOTE_KEYS = "qwertyu"; // C 大调 do~si
const noteColor = new THREE.Color();
const remoteNoteColor = new THREE.Color("#ffe9b8");

function attachInstrument(avatarGroup: THREE.Group, kindIdx: number) {
  const until = performance.now() + 3000;
  const hit = remoteInstruments.get(avatarGroup);
  if (hit) {
    hit.until = until;
    return;
  }
  const mesh = makeInstrumentMesh(INSTRUMENTS[kindIdx].kind, furnKit);
  mesh.position.set(0, 0.95, 0.34);
  avatarGroup.add(mesh);
  remoteInstruments.set(avatarGroup, { mesh, until });
}

function stowInstrument() {
  playingIdx = -1;
  if (selfInstrumentMesh) {
    selfAvatar?.group.remove(selfInstrumentMesh);
    selfInstrumentMesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    selfInstrumentMesh = null;
  }
  instrumentHint.style.display = "none";
  controls.setEnabled(true);
  syncDesktopActions();
}

// ---- 琴键提示条：拿琴时常驻屏幕下方，按下哪个键亮哪个 ----
const SOLFEGE = ["do", "re", "mi", "fa", "sol", "la", "si"];
const instrumentHint = document.createElement("div");
instrumentHint.className = "instrument-keys";
const keyCaps: HTMLDivElement[] = [];
for (let i = 0; i < 7; i++) {
  const cap = document.createElement("div");
  cap.className = "instrument-key";
  cap.innerHTML = `<strong>${NOTE_KEYS[i].toUpperCase()}</strong><small>${SOLFEGE[i]}</small>`;
  // 触屏/鼠标直接点键帽弹奏（手机没有 QWERTYU 行）
  cap.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (playingIdx >= 0) strikeNote(i, false);
  });
  instrumentHint.appendChild(cap);
  keyCaps.push(cap);
}
const octLabel = document.createElement("div");
octLabel.className = "octave-label";
instrumentHint.appendChild(octLabel);
document.body.appendChild(instrumentHint);

function flashKey(i: number, shift: boolean) {
  const cap = keyCaps[i];
  if (!cap) return;
  const hot = shift ? "#ffb46e" : "#ffd98e";
  cap.style.background = `rgba(255,214,130,.55)`;
  cap.style.boxShadow = `0 0 14px ${hot}`;
  setTimeout(() => {
    cap.style.background = "";
    cap.style.boxShadow = "none";
  }, 140);
}

function refreshOctLabel() {
  const parts: string[] = [];
  parts.push(INSTRUMENTS[playingIdx]?.label ?? "");
  const oct = baseOctave;
  parts.push(oct === 0 ? "本八度" : `${oct > 0 ? "+" : ""}${oct} 八度`);
  parts.push("Shift 高八度 · Z/X 变调 · Esc 收起");
  octLabel.textContent = parts.join(" · ");
}

function takeOutInstrument(idx: number) {
  if (idx < 0) {
    if (playingIdx >= 0) stowInstrument(); // 触屏菜单的「收起乐器」
    return;
  }
  if (playingIdx === idx) {
    stowInstrument();
    return;
  }
  if (playingIdx >= 0) stowInstrument();
  if (controls.state.sit) {
    ui.toast("站起来再弹琴吧");
    return;
  }
  playingIdx = idx;
  controls.setEnabled(false); // 弹琴时不动，镜头还能转
  selfInstrumentMesh = makeInstrumentMesh(INSTRUMENTS[idx].kind, furnKit);
  selfInstrumentMesh.position.set(0, 0.95, 0.34);
  selfAvatar?.group.add(selfInstrumentMesh);
  refreshOctLabel();
  instrumentHint.style.display = "flex";
  syncDesktopActions();
}

function strikeNote(keyIdx: number, shift: boolean) {
  const midi = 60 + keyIdx + (baseOctave + (shift ? 1 : 0)) * 12;
  instruments.play(INSTRUMENTS[playingIdx].kind, midi, 1);
  flashKey(keyIdx, shift);
  noteColor.setHSL(selfHue / 360, 0.55, 0.72);
  musicfx.noteBurst(controls.state.pos, noteColor, 0.9);
  net?.sendNote(playingIdx, midi, 0.9);
}
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
const ringColor = new THREE.Color();
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
  instruments.init(music);

  // 先放好自己
  spawnSelf();

  // 连接服务器；失败则进入独自漫游（NPC 陪伴）
  net = await connectToIsland(name);
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
  document.getElementById("enterName")?.blur(); // 焦点别留在入场框（会挡住游戏按键/摇杆）
  // 触屏设备（手机/平板）：显示虚拟摇杆与按钮簇
  touchUI.setVisible(isTouchDevice());
  ui.toast("欢迎来到音遇——选一首歌，或安静地走走", 4200);
}

/** 连接（与重连共用同一套事件处理）；name 为进入时的名字 */
async function connectToIsland(name: string): Promise<NetHandle | null> {
  return connectIsland(
    name,
    remotes,
    selectedAvatar,
    {
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
    (from, _fromName, text) => {
      if (from === net?.sessionId) {
        selfAvatar?.say(text);
        return;
      }
      const av = remotes.avatarOf(from);
      if (!av) return;
      const dist = av.group.position.distanceTo(selfAvatar?.group.position ?? av.group.position);
      if (dist <= 20) av.say(text);
    },
    // 别人做表情：30 米内可见
    (from, emoteName) => {
      const av = remotes.avatarOf(from);
      if (!av || !selfAvatar) return;
      if (av.group.position.distanceTo(selfAvatar.group.position) <= 30) av.playEmote(emoteName);
    },
    // 别人弹琴：28 米内听到（按距离衰减）+ 光效 + 乐器显形 3 秒
    (from, kindIdx, midi, vel) => {
      const av = remotes.avatarOf(from);
      if (!av || !selfAvatar) return;
      const d = av.group.position.distanceTo(selfAvatar.group.position);
      if (d > 28) return;
      instruments.play(INSTRUMENTS[kindIdx]?.kind ?? "harp", midi, Math.pow(1 - d / 28, 1.5) * vel);
      musicfx.noteBurst(av.group.position, remoteNoteColor, vel);
      attachInstrument(av.group, kindIdx);
    },
    // 家具增删（服务器权威：每人一个）
    (key, data) => {
      if (data) furniture.upsert(key, data);
      else {
        if (seatedOn?.key === key) seatedOn = null;
        furniture.remove(key);
      }
    },
    // 非主动掉线 → 自动重连
    startReconnect,
    // ping 探针回报
    updatePingBadge
  );
}

// ---------------- 断线自动重连 ----------------
let reconnecting = false;
function startReconnect() {
  if (reconnecting || !entered) return;
  reconnecting = true;
  net = null;
  pingBadge.style.display = "none";
  // 旧会话的家具在服务器端已被清掉，本地也清（重连后从新状态重建别人的）
  seatedOn = null;
  for (const k of [...furniture.entries.keys()]) furniture.remove(k);
  ui.toast("连接闪断了，正在重连…", 2400);
  void (async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 2600));
      const h = await connectToIsland(playerName);
      if (h) {
        net = h;
        reconnecting = false;
        ui.setStatus("online");
        ui.setSongOwner(net.sessionId);
        pingBadge.style.display = "block";
        // 新会话：把自己正在放的歌重新上报（按已播进度续上）
        if (music.ownTrackId >= 0 && !music.isOwnPaused) {
          const resumeMs = Math.max(0, Date.now() - (music as unknown as { ownStartWall: number }).ownStartWall);
          net.sendTrack(music.ownTrackId, ui.currentSongName, resumeMs, music.ownUrl);
        }
        ui.toast("重新连上了", 2200);
        return;
      }
    }
    reconnecting = false;
    ui.toast("一直连不上服务器，先独自漫游吧（刷新页面可再试）", 5000);
    ui.setStatus("solo");
    npcs = new NpcDriver(remotes);
  })();
}

// ---------------- 延迟徽章（右下角） ----------------
const pingBadge = document.createElement("div");
pingBadge.className = "ping-badge";
document.body.appendChild(pingBadge);

function updatePingBadge(ms: number) {
  pingBadge.textContent = `${ms} ms`;
  pingBadge.style.color = ms < 80 ? "#9ff0b2" : ms < 200 ? "#ffd98e" : "#ff9d8a";
  pingBadge.style.display = "block";
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
  controls.onGlide = (open) => {
    if (open) music.sfxGlideOpen();
  };
  controls.onSit = (sitting) => {
    if (sitting && !seatedOn && !controls.state.airborne) {
      // 光遇式互动：靠近椅子/秋千按 E 是「坐上去」，而不是原地躺下
      const near = furniture.nearestSeat(controls.state.pos, 1.7);
      if (near) {
        seatedOn = { key: near.key, seat: near.seat };
        swingSim.angle = furniture.pivotAngle(near.key, near.seat);
        swingSim.vel = 0;
        music.sfxSit();
        return;
      }
    }
    if (!sitting && seatedOn) {
      seatedOn = null; // E 起身（走动/跳跃起身由 tick 里的兜底清理）
    }
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
    furniture,
    get touchUI() {
      return touchUI;
    },
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
chatInput.className = "chat-input";
chatInput.style.display = "none"; // 内联状态即真值：Enter 判断读的就是它，不能只靠 CSS 隐藏
document.body.appendChild(chatInput);

function openChat() {
  closeDesktopActions();
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

// ---------------- 动作轮盘：Tab 打开，点选或按 1-6 ----------------
const EMOTES: { key: string; label: string; icon: string }[] = [
  { key: "wave", label: "招手", icon: "👋" },
  { key: "bow", label: "鞠躬", icon: "🙇" },
  { key: "nod", label: "点头", icon: "🙂" },
  { key: "stretch", label: "伸懒腰", icon: "🫸" },
  { key: "cheer", label: "欢呼", icon: "🙌" },
  { key: "heart", label: "比心", icon: "💗" },
];
let wheelOpen = false;
const emoteWheel = document.createElement("div");
emoteWheel.className = "emote-wheel";
emoteWheel.addEventListener("keydown", (e) => e.stopPropagation());
const emoteBtns: HTMLButtonElement[] = [];
EMOTES.forEach((em, i) => {
  const btn = document.createElement("button");
  btn.className = "emote-btn";
  btn.innerHTML = `<span>${em.icon}</span>${em.label} ${i + 1}`;
  btn.onclick = () => {
    doEmote(em.key);
    closeWheel();
  };
  emoteWheel.appendChild(btn);
  emoteBtns.push(btn);
});
document.body.appendChild(emoteWheel);

function doEmote(name: string) {
  selfAvatar?.playEmote(name);
  net?.sendEmote(name);
}
function openWheel() {
  closeDesktopActions();
  wheelOpen = true;
  emoteWheel.style.display = "grid";
  document.exitPointerLock?.();
  (emoteBtns[0] ?? emoteWheel).focus?.();
}
function closeWheel() {
  wheelOpen = false;
  emoteWheel.style.display = "none";
}
emoteWheel.tabIndex = -1;

// ---------------- 牵手按键：G 邀请/松手 · F 接受 · Enter 聊天 · Tab 动作 ----------------
// ---------------- 触屏操控（手机/平板）：摇杆 + 按钮簇 ----------------
const touchUI = createTouchUI(controls, {
  openChat,
  openWheel,
  toggleFurniture,
  takeInstrument: (idx) => takeOutInstrument(idx),
});

/** 背包家具：放着就收回，没放就放在面前（键盘 1/2 与触屏菜单共用） */
function toggleFurniture(kind: number) {
  const key = ownFurnKey(kind);
  if (furniture.has(key)) {
    if (seatedOn?.key === key) {
      seatedOn = null;
      controls.state.sit = false;
    }
    furniture.remove(key);
    net?.sendFurnRemove(kind);
    ui.toast(kind === 0 ? "椅子收回了" : "秋千收回了");
  } else {
    const s = controls.state;
    const yaw = s.yaw;
    const x = s.pos.x + Math.sin(yaw) * 2.1;
    const z = s.pos.z + Math.cos(yaw) * 2.1;
    const y = terrainHeight(x, z);
    if (insideAnyCollider(x, z, y + 0.3, 0.25)) {
      ui.toast("这里太挤了，放不下");
    } else {
      furniture.upsert(key, { owner: net ? net.sessionId : "solo", kind, x, y, z, ry: yaw });
      net?.sendFurnPlace(kind, x, y, z, yaw);
      ui.toast(kind === 0 ? "放下了椅子——走近点「坐」坐下" : "放下了双人秋千——走近点「坐」荡起来");
    }
  }
  syncDesktopActions();
}

// ---------------- 桌面操作入口：收纳 Enter / Tab / 1-5，可点击也可看键位 ----------------
const desktopActions = document.createElement("div");
desktopActions.className = "desktop-actions";
desktopActions.innerHTML = `
  <div class="action-menu panel" role="menu" aria-label="旅人操作">
    <section class="action-section">
      <div class="action-section-title">互动</div>
      <div class="action-grid">
        <button class="action-item" data-action="chat"><i data-lucide="message-circle"></i><span class="label">说话</span><kbd>Enter</kbd></button>
        <button class="action-item" data-action="emote"><i data-lucide="sparkles"></i><span class="label">动作</span><kbd>Tab</kbd></button>
      </div>
    </section>
    <section class="action-section">
      <div class="action-section-title">家具</div>
      <div class="action-grid">
        <button class="action-item" data-furniture="0"><i data-lucide="armchair"></i><span class="label">椅子</span><kbd>1</kbd></button>
        <button class="action-item" data-furniture="1"><i data-lucide="move-horizontal"></i><span class="label">秋千</span><kbd>2</kbd></button>
      </div>
    </section>
    <section class="action-section">
      <div class="action-section-title">乐器</div>
      <div class="action-grid instruments">
        <button class="action-item" data-instrument="0"><i data-lucide="music-2"></i><span class="label">竖琴</span><kbd>3</kbd></button>
        <button class="action-item" data-instrument="1"><i data-lucide="wind"></i><span class="label">长笛</span><kbd>4</kbd></button>
        <button class="action-item" data-instrument="2"><i data-lucide="bell"></i><span class="label">风铃</span><kbd>5</kbd></button>
      </div>
    </section>
  </div>
  <button class="action-trigger" title="旅人操作" aria-label="展开旅人操作" aria-expanded="false"><i data-lucide="menu"></i></button>`;
document.body.appendChild(desktopActions);
createIcons({ icons: { Armchair, Bell, Menu, MessageCircle, MoveHorizontal, Music2, Sparkles, Wind } });
desktopActions.querySelectorAll("svg[data-lucide]").forEach((icon) => icon.removeAttribute("data-lucide"));

const actionTrigger = desktopActions.querySelector(".action-trigger") as HTMLButtonElement;
actionTrigger.addEventListener("click", () => {
  const open = desktopActions.classList.toggle("open");
  actionTrigger.setAttribute("aria-expanded", String(open));
  if (open) document.exitPointerLock?.();
});
desktopActions.querySelector<HTMLElement>("[data-action=chat]")?.addEventListener("click", openChat);
desktopActions.querySelector<HTMLElement>("[data-action=emote]")?.addEventListener("click", openWheel);
desktopActions.querySelectorAll<HTMLElement>("[data-furniture]").forEach((button) => {
  button.addEventListener("click", () => toggleFurniture(Number(button.dataset.furniture)));
});
desktopActions.querySelectorAll<HTMLElement>("[data-instrument]").forEach((button) => {
  button.addEventListener("click", () => {
    takeOutInstrument(Number(button.dataset.instrument));
    closeDesktopActions();
  });
});
window.addEventListener("pointerdown", (e) => {
  if (!desktopActions.contains(e.target as Node)) closeDesktopActions();
});

function closeDesktopActions() {
  desktopActions?.classList.remove("open");
  actionTrigger?.setAttribute("aria-expanded", "false");
}

function syncDesktopActions() {
  if (!desktopActions) return;
  desktopActions.querySelectorAll<HTMLElement>("[data-instrument]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.instrument) === playingIdx);
  });
  desktopActions.querySelectorAll<HTMLElement>("[data-furniture]").forEach((button) => {
    button.classList.toggle("active", furniture.has(ownFurnKey(Number(button.dataset.furniture))));
  });
}

window.addEventListener("keydown", (e) => {
  if (!entered || e.repeat) return;
  if ((e.target as HTMLElement | null)?.matches?.("input, textarea, [contenteditable]")) return;
  const k = e.key.toLowerCase();
  if (k === "escape") closeDesktopActions();
  if (k === "tab") {
    e.preventDefault();
    if (wheelOpen) closeWheel();
    else openWheel();
    return;
  }
  if (wheelOpen) {
    // 轮盘开着：1-6 选动作，Esc 关
    e.preventDefault();
    if (/^[1-6]$/.test(k)) {
      doEmote(EMOTES[Number(k) - 1].key);
      closeWheel();
    } else if (k === "escape") closeWheel();
    return;
  }
  // 乐器弹奏键（拿出乐器后，Q W E R T Y U 是琴键）
  if (playingIdx >= 0) {
    const ni = NOTE_KEYS.indexOf(k);
    if (ni >= 0 && !e.repeat) {
      strikeNote(ni, e.shiftKey);
      return;
    }
    if (k === "z" && !e.repeat) {
      baseOctave = Math.max(-2, baseOctave - 1);
      refreshOctLabel();
      return;
    }
    if (k === "x" && !e.repeat) {
      baseOctave = Math.min(2, baseOctave + 1);
      refreshOctLabel();
      return;
    }
    if (k === "escape") {
      stowInstrument();
      return;
    }
  }
  if (k === "3" || k === "4" || k === "5") {
    takeOutInstrument(Number(k) - 3);
    return;
  }
  if (k === "enter") {
    if (chatInput.style.display === "none") openChat();
    return;
  }
  if (k === "1" || k === "2") {
    toggleFurniture(k === "1" ? 0 : 1);
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

  // ---- 家具乘坐 ----
  if (seatedOn && !controls.state.sit) seatedOn = null; // 走动/跳跃起身的兜底清理
  if (seatedOn) {
    const entry = furniture.entries.get(seatedOn.key);
    if (!entry) {
      seatedOn = null; // 家具被主人收走了
    } else {
      const s = controls.state;
      if (entry.kind === 1) {
        // 秋千：重力摆 + W/S 蹬踏（自己的物理自己做，别人看着你的位置反推摆角）
        const pump = (controls.isKeyDown("w") ? 1 : 0) - (controls.isKeyDown("s") ? 1 : 0);
        swingSim.vel += (-9.8 / SWING_ROPE) * Math.sin(swingSim.angle) * dt;
        swingSim.vel -= swingSim.vel * 0.055 * dt;
        if (pump !== 0) swingSim.vel += pump * 1.9 * Math.cos(swingSim.angle) * dt * Math.max(0.35, Math.abs(Math.cos(swingSim.angle)));
        swingSim.vel = Math.max(-3.2, Math.min(3.2, swingSim.vel));
        swingSim.angle = Math.max(-1.05, Math.min(1.05, swingSim.angle + swingSim.vel * dt));
        furniture.setPivotAngle(seatedOn.key, seatedOn.seat, swingSim.angle);
      }
      if (furniture.seatAnchor(seatedOn.key, seatedOn.seat, tmpDir)) {
        s.pos.copy(tmpDir);
        s.mov = 0;
        // 面向家具前方
        s.yaw = entry.group.rotation.y;
      }
    }
  }
  // 家具摆动：跟随所有坐着的人（自己 + 远端）；顺手标记谁坐在家具上（远端坐姿用）
  const sittersAll = [{ key: "self", pos: controls.state.pos, sit: controls.state.sit }, ...remotes.sitters()];
  furniture.update(sittersAll);
  const seatedRemotes = new Set<string>();
  for (const p of sittersAll) {
    if (!p.sit) continue;
    if (p.key === "self") continue;
    if (furniture.nearestSeat(p.pos, 0.75)) seatedRemotes.add(p.key);
  }

  if (selfAvatar) {
    const s = controls.state;
    selfAvatar.group.position.copy(s.pos);
    selfAvatar.group.rotation.y = s.yaw;
    const speed = controls.horizSpeed;
    const air = s.mov === 3 || s.mov === 4 ? 2 : s.airborne ? 1 : 0;
    selfAvatar.animate(dt, t, speed, s.sit, air, s.yawVel, { vy: controls.verticalVel, vx: controls.horizVel.x, vz: controls.horizVel.z, seated: !!seatedOn });
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
  // 音乐特征（分频段包络+节拍）→ 光环节拍能量 + 头顶动效（涟漪/音符）
  const beatMap = new Map<string, number>();
  musicfx.beginFrame();
  for (const i of infos) {
    if (i.dist >= AUDIBLE_R || i.trackId < 0) continue;
    const f = music.features(i.key);
    beatMap.set(i.key, Math.min(1, f.beat * 0.7 + f.level * 0.5));
    const pos = remotes.posOf(i.key);
    if (pos) musicfx.drive(i.key, pos, i.color, f, dt, i.clarity);
  }
  remotes.animate(dt, t, clarity, beatMap, seatedRemotes);

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
    controls.verticalVel,
    controls.state.mov === 3 || controls.state.mov === 4
  );
  // 滑翔风线与瞬态光效
  world.wind.update(dt, t, controls.state.pos, controls.horizVel);
  world.bursts.update(dt);

  // 昼夜循环：10 分钟一轮，按服务器时钟对齐（所有玩家看到同一片天）
  const serverNow = Date.now() + (net?.clockOffset ?? 0);
  world.setDayPhase((serverNow % 600000) / 600000);

  // 远端乐器显形过期回收
  const nowMs = performance.now();
  for (const [g, hit] of remoteInstruments) {
    if (hit.until < nowMs) {
      g.remove(hit.mesh);
      hit.mesh.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
      });
      remoteInstruments.delete(g);
    }
  }

  // 自己的光环 + 音乐动效（听歌且未暂停时）
  if (selfAvatar) {
    const meta = trackMeta(music.ownTrackId, ui.currentSongName, music.ownUrl);
    const active = music.ownTrackId >= 0 && !music.isOwnPaused;
    if (active) {
      const f = music.features("self");
      ringColor.set(meta.color);
      selfAvatar.setRing(ringColor, 0.3 + f.level * 0.45 + f.beat * 0.35);
      musicfx.drive("self", controls.state.pos, ringColor, f, dt, 1);
    } else {
      selfAvatar.setRing(null, 0);
    }
  }
  // musicfx.update 必须在「所有」drive 之后：它会把本帧没被驱动的发射器清掉，
  // 自己的 drive 在上面才调用——放在 world.bursts.update 那里会把 self 每帧删建，
  // 音符累积器永远归零（自己永远不吐音符）+ 踩点检测每帧误判
  musicfx.update(dt);

  // UI 低频刷新 + 靠近提示 + 翼能
  uiTimer += dt;
  if (uiTimer > 0.25) {
    uiTimer = 0;
    ui.setNearby(infos);
    ui.setFlaps(controls.state.flaps);
    // 家具靠近提示（节流 6 秒）
    if (!controls.state.sit && t - seatHintAt > 6) {
      const near = furniture.nearestSeat(controls.state.pos, 1.7);
      if (near) {
        seatHintAt = t;
        const e = furniture.entries.get(near.key);
        ui.toast(e?.kind === 1 ? "按 E 坐上秋千（W/S 蹬起来）" : "按 E 坐下歇会儿");
      }
    }
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
