import { createIcons, ArrowRight, Music2, Pause, Play, Upload, UserRound, Wifi, WifiOff, X } from "lucide";
import { TRACKS, trackMeta, CUSTOM_BASE } from "./audio/tracks";
import type { RemoteInfo } from "./remote";
import type { AvatarModel } from "./avatar";

/**
 * HUD 逻辑：入场、正在听、身边的人、换歌面板、提示气泡。
 * DOM 与样式都在 index.html 里，这里只做绑定与刷新。
 */
export function createUI(handlers: {
  onEnter: (name: string) => void;
  onAvatarChange: (model: AvatarModel) => void;
  onPickTrack: (id: number, name?: string) => void;
  onPickUrl: (url: string, name: string) => void;
  onTogglePlay: () => void;
}) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const refreshIcons = () => {
    document.querySelectorAll("svg[data-lucide]").forEach((icon) => icon.removeAttribute("data-lucide"));
    createIcons({ icons: { ArrowRight, Music2, Pause, Play, Upload, UserRound, Wifi, WifiOff, X } });
    document.querySelectorAll("svg[data-lucide]").forEach((icon) => icon.removeAttribute("data-lucide"));
  };

  const enter = $("enter");
  const enterName = $("enterName") as HTMLInputElement;
  const enterBtn = $("enterBtn");
  const avatarGrid = $("avatarGrid");
  const connectionStatus = $("connectionStatus");
  const musicButton = $("musicButton");
  const npPlay = $("npPlay");
  const nearby = $("nearby");
  const toasts = $("toasts");
  const showToast = (text: string, ms = 2600) => {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 650);
    }, ms);
  };
  const trackModal = $("trackModal");
  const trackClose = $("trackClose");
  const trackGrid = $("trackGrid");
  const songGrid = $("songGrid");
  const uploadCard = $("uploadCard");
  const songFile = $("songFile") as HTMLInputElement;
  const urlInput = $("urlInput") as HTMLInputElement;
  const urlNameInput = $("urlNameInput") as HTMLInputElement;
  const urlPlayBtn = $("urlPlayBtn");

  // 链接点歌：贴一个音频直链立刻播放（支持 CORS 的直链有完整渐强体验）
  urlPlayBtn?.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (!/^https?:\/\/.+/i.test(url)) {
      showToast("先贴一个 http(s) 音频直链试试", 2600);
      return;
    }
    handlers.onPickUrl(url, urlNameInput.value.trim().slice(0, 40));
    trackModal.classList.remove("open");
  });
  urlInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") urlPlayBtn?.click();
    e.stopPropagation(); // 输入框里的按键不进游戏快捷键
  });
  urlNameInput?.addEventListener("keydown", (e) => e.stopPropagation());

  const avatarNames: Array<{ id: AvatarModel; name: string; desc: string }> = [
    { id: "classic", name: "云朵旅人", desc: "原生音遇小人" },
    { id: "hooded", name: "兜帽旅人", desc: "披风与兜帽" },
    { id: "corgi", name: "柯基", desc: "摇着尾巴散步" },
    { id: "duck", name: "小鸭子", desc: "嘎嘎的暖黄色" },
    { id: "seal", name: "小海豹", desc: "软绵绵的海风" },
    { id: "owl", name: "小猫头鹰", desc: "夜色里的朋友" },
    { id: "platypus", name: "鸭嘴兽", desc: "圆脑袋旅行家" },
    { id: "minion", name: "圆滚精灵", desc: "软乎乎的小伙伴" },
    { id: "elaina", name: "伊莱娜", desc: "灰之魔女来岛上小住" },
  ];
  avatarNames.forEach((choice, index) => {
    const card = document.createElement("button");
    card.className = `avatar-card${index === 0 ? " active" : ""}`;
    card.dataset.avatar = choice.id;
    card.title = choice.desc;
    card.setAttribute("aria-label", `${choice.name}：${choice.desc}`);
    card.innerHTML = `<span class="avatar-swatch avatar-${choice.id}"></span><span><b>${choice.name}</b><small>${choice.desc}</small></span>`;
    card.addEventListener("click", () => {
      avatarGrid.querySelectorAll(".avatar-card").forEach((el) => el.classList.remove("active"));
      card.classList.add("active");
      handlers.onAvatarChange(choice.id);
    });
    avatarGrid.appendChild(card);
  });

  // ---- 换歌面板 ----
  let currentTrackId = -1;
  let currentSongName = "";
  TRACKS.forEach((t) => {
    const card = document.createElement("button");
    card.className = "track-card";
    card.dataset.id = String(t.id);
    card.innerHTML = `<div class="dot" style="background:${t.color};box-shadow:0 0 10px ${t.color}"></div>
      <div class="nm">${t.name}</div><div class="ds">${t.desc}</div>`;
    card.addEventListener("click", () => {
      handlers.onPickTrack(t.id);
      trackModal.classList.remove("open");
    });
    trackGrid.appendChild(card);
  });

  // ---- 岛上的歌（随身曲库：只看得到自己上传的，离岛自动收起） ----
  let songOwner = "";
  const setSongOwner = (id: string) => {
    songOwner = id;
  };
  async function loadSongs() {
    try {
      const res = await fetch(`/songs/list?owner=${encodeURIComponent(songOwner)}`);
      const songs: { id: string; name: string }[] = await res.json();
      songGrid.innerHTML = "";
      if (songs.length === 0) {
        songGrid.innerHTML = `<div class="songs-empty">你这次上岛还没有自己的歌——传一首，或贴个直链</div>`;
        return;
      }
      for (const s of songs.slice(0, 30)) {
        const displayName = decodeURIComponent(s.name).replace(/\.[a-z0-9]+$/i, "");
        const trackId = CUSTOM_BASE + Number(s.id);
        const meta = trackMeta(trackId, displayName);
        const card = document.createElement("button");
        card.className = "track-card";
        card.dataset.song = s.id;
        card.dataset.trackId = String(trackId);
        card.dataset.name = displayName;
        card.innerHTML = `<div class="dot" style="background:${meta.color};box-shadow:0 0 10px ${meta.color}"></div>
          <div class="nm">${escapeHtml(displayName.slice(0, 18))}</div><div class="ds">我的歌 · 离岛即收</div>`;
        card.addEventListener("click", () => {
          handlers.onPickTrack(trackId, displayName);
          trackModal.classList.remove("open");
        });
        songGrid.appendChild(card);
      }
    } catch {
      songGrid.innerHTML = `<div class="songs-empty">曲库暂不可用</div>`;
    }
  }

  // 上传自己的歌（先本地预检，再把服务器压力挡在前面）
  const MAX_MB = 20;
  const MAX_SECONDS = 12 * 60;
  uploadCard.addEventListener("click", () => songFile.click());
  songFile.addEventListener("change", async () => {
    const file = songFile.files?.[0];
    if (!file) return;
    uploadCard.classList.add("uploading");
    uploadCard.textContent = `正在检查「${file.name.slice(0, 16)}」…`;
    try {
      if (file.size > MAX_MB * 1024 * 1024) {
        throw new Error(`太大了，请选 ${MAX_MB}MB 以内的歌曲`);
      }
      // 用 <audio> 元数据读真实时长（防伪造）
      const duration = await new Promise<number>((resolve, reject) => {
        const a = document.createElement("audio");
        const url = URL.createObjectURL(file);
        const timer = setTimeout(() => finish(-1), 8000);
        const finish = (d: number) => {
          clearTimeout(timer);
          URL.revokeObjectURL(url);
          a.src = "";
          d > 0 ? resolve(d) : reject(new Error("读不出这首歌的时长，文件可能损坏了"));
        };
        a.preload = "metadata";
        a.onloadedmetadata = () => finish(Number.isFinite(a.duration) ? a.duration : -1);
        a.onerror = () => finish(-1);
        a.src = url;
      });
      if (duration > MAX_SECONDS) {
        throw new Error(`这首歌有 ${Math.round(duration / 60)} 分钟，超过 ${MAX_SECONDS / 60} 分钟上限啦`);
      }

      uploadCard.textContent = `正在上传「${file.name.slice(0, 16)}」…`;
      const res = await fetch(`/songs/upload?name=${encodeURIComponent(file.name)}&owner=${encodeURIComponent(songOwner)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error((await res.json()).error || "上传失败");
      const { id } = await res.json();
      const displayName = file.name.replace(/\.[a-z0-9]+$/i, "");
      const trackId = CUSTOM_BASE + Number(id);
      showToast(`「${displayName.slice(0, 14)}」已放进你的随身曲库`);
      await loadSongs();
      handlers.onPickTrack(trackId, displayName);
      trackModal.classList.remove("open");
    } catch (e) {
      showToast("上传失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      uploadCard.classList.remove("uploading");
      uploadCard.innerHTML = `<i data-lucide="upload"></i><span>上传音频</span>`;
      refreshIcons();
      songFile.value = "";
    }
  });

  const openPicker = () => {
    trackModal.classList.add("open");
    loadSongs();
  };
  trackModal.addEventListener("click", (e) => {
    if (e.target === trackModal) trackModal.classList.remove("open");
  });
  trackClose.addEventListener("click", () => trackModal.classList.remove("open"));
  musicButton.addEventListener("click", openPicker);
  npPlay.addEventListener("click", () => handlers.onTogglePlay());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") trackModal.classList.remove("open");
    if (e.key.toLowerCase() === "p" && !e.repeat) handlers.onTogglePlay();
  });

  // ---- 入场 ----
  const doEnter = () => {
    const name = enterName.value.trim() || "无名旅人";
    handlers.onEnter(name);
  };
  enterBtn.addEventListener("click", doEnter);
  enterName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doEnter();
  });
  refreshIcons();

  return {
    /** 直接打开换歌面板 */
    openPicker,
    entered() {
      enter.classList.add("hidden");
      document.body.classList.add("playing");
    },
    setStatus(mode: "online" | "solo" | "off") {
      const label = mode === "online" ? "在线" : mode === "solo" ? "独自漫游" : "连接中断";
      connectionStatus.className = `hud${mode === "online" ? "" : ` ${mode}`}`;
      connectionStatus.innerHTML = `<i data-lucide="${mode === "online" ? "wifi" : mode === "solo" ? "user-round" : "wifi-off"}"></i>`;
      connectionStatus.title = label;
      connectionStatus.setAttribute("aria-label", label);
      refreshIcons();
    },
    /** 刷新播放/暂停按钮与状态文案：mode "none" | "playing" | "paused" */
    setPlayState(mode: "none" | "playing" | "paused") {
      const playing = mode === "playing";
      npPlay.classList.toggle("available", mode !== "none");
      npPlay.innerHTML = `<i data-lucide="${playing ? "pause" : "play"}"></i>`;
      npPlay.title = playing ? "暂停 (P)" : "播放 (P)";
      npPlay.setAttribute("aria-label", npPlay.title);
      musicButton.classList.toggle("playing", playing);
      musicButton.classList.toggle("paused", mode === "paused");
      refreshIcons();
    },
    setNowPlaying(trackId: number, songName = "") {
      currentTrackId = trackId;
      currentSongName = songName;
      const meta = trackMeta(trackId, songName);
      if (trackId >= 0 && meta.name) {
        musicButton.style.setProperty("--track-color", meta.color);
        musicButton.title = `${meta.name} · 打开曲库 · P 播放/暂停`;
        musicButton.setAttribute("aria-label", musicButton.title);
        trackGrid.querySelectorAll(".track-card").forEach((c) => {
          c.classList.toggle("active", Number((c as HTMLElement).dataset.id) === trackId);
        });
        songGrid.querySelectorAll(".track-card").forEach((c) => {
          c.classList.toggle("active", Number((c as HTMLElement).dataset.trackId) === trackId);
        });
      } else {
        musicButton.style.removeProperty("--track-color");
        musicButton.title = "打开曲库";
        musicButton.setAttribute("aria-label", musicButton.title);
      }
    },
    get currentTrackId() {
      return currentTrackId;
    },
    get currentSongName() {
      return currentSongName;
    },
    setFlaps(n: number) {
      const wrap = $("flaps");
      if (!wrap) return;
      const pips = wrap.querySelectorAll("i");
      pips.forEach((p, i) => {
        (p as HTMLElement).classList.toggle("on", i < n);
      });
      wrap.classList.toggle("full", n >= 3);
    },
    setNearby(infos: RemoteInfo[]) {
      const audible = infos.filter((i) => i.trackId >= 0 && i.dist < 38).slice(0, 4);
      const nearbyWrap = $("nearbyWrap");
      nearbyWrap.classList.toggle("has-people", audible.length > 0);
      if (audible.length === 0) {
        nearby.innerHTML = "";
        return;
      }
      nearby.innerHTML = "";
      for (const i of audible) {
        const pct = Math.round(i.clarity * 100);
        const item = document.createElement("div");
        item.className = "nb-item";
        const c = i.color.getStyle();
        item.innerHTML = `
          <div class="nb-dot" style="background:${c};box-shadow:0 0 8px ${c}"></div>
          <div class="nb-info">
            <div class="nb-name">${escapeHtml(i.name)}</div>
            <div class="nb-track">${escapeHtml(i.trackName)}</div>
          </div>
          <div class="nb-bar"><i style="width:${pct}%;background:linear-gradient(90deg,${c},#ffd9a0)"></i></div>`;
        nearby.appendChild(item);
      }
    },
    toast(text: string, ms = 2600) {
      showToast(text, ms);
    },
    /** 绑定随身曲库的主人（连接成功后调用，列表/上传都会带上） */
    setSongOwner,
    /** 牵手邀请：显示提示条；返回撤销函数（超时/接受/婉拒时调用） */
    showInvite(name: string, onAccept: () => void, onReject: () => void) {
      hideInvite();
      const bar = document.createElement("div");
      bar.className = "hand-invite";
      bar.innerHTML = `
        <span class="hi-text"><b>${escapeHtml(name)}</b> 想牵你的手</span>
        <button class="hi-yes">接受 (F)</button>
        <button class="hi-no">婉拒 (G)</button>`;
      document.body.appendChild(bar);
      const yes = bar.querySelector(".hi-yes") as HTMLButtonElement;
      const no = bar.querySelector(".hi-no") as HTMLButtonElement;
      const timer = window.setTimeout(() => done(false), 15000);
      function done(accept: boolean) {
        window.clearTimeout(timer);
        bar.remove();
        accept ? onAccept() : onReject();
      }
      yes.addEventListener("click", () => done(true));
      no.addEventListener("click", () => done(false));
      inviteResolve = done;
    },
    hideInvite,
    /** 键盘 F：接受当前邀请 */
    acceptInvite() {
      if (!inviteResolve) return;
      const r = inviteResolve;
      inviteResolve = null;
      document.querySelectorAll(".hand-invite").forEach((el) => el.remove());
      r(true);
    },
    /** 键盘 G：婉拒当前邀请 */
    rejectInvite() {
      if (!inviteResolve) return;
      const r = inviteResolve;
      inviteResolve = null;
      document.querySelectorAll(".hand-invite").forEach((el) => el.remove());
      r(false);
    },
    hasInvite() {
      return !!inviteResolve;
    },
    focusName() {
      enterName.focus();
    },
  };
}

/** 当前邀请的处理器（供 F/G 键触发）；无邀请时为 null */
let inviteResolve: ((accept: boolean) => void) | null = null;

function hideInvite() {
  if (inviteResolve) {
    const r = inviteResolve;
    inviteResolve = null;
    r(false);
  }
  document.querySelectorAll(".hand-invite").forEach((el) => el.remove());
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
