import { TRACKS, type TrackDef } from "./audio/tracks";
import type { RemoteInfo } from "./remote";

/**
 * HUD 逻辑：入场、正在听、身边的人、换歌面板、提示气泡。
 * DOM 与样式都在 index.html 里，这里只做绑定与刷新。
 */
export function createUI(handlers: {
  onEnter: (name: string) => void;
  onPickTrack: (id: number) => void;
}) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  const enter = $("enter");
  const enterName = $("enterName") as HTMLInputElement;
  const enterBtn = $("enterBtn");
  const statusDot = $("statusDot");
  const statusText = $("statusText");
  const npDot = $("npDot");
  const npName = $("npName");
  const npSub = $("npSub");
  const npBtn = $("npBtn");
  const nearby = $("nearby");
  const toasts = $("toasts");
  const trackModal = $("trackModal");
  const trackGrid = $("trackGrid");

  // ---- 换歌面板 ----
  let currentTrack: TrackDef | null = null;
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

  const openPicker = () => trackModal.classList.add("open");
  trackModal.addEventListener("click", (e) => {
    if (e.target === trackModal) trackModal.classList.remove("open");
  });
  npBtn.addEventListener("click", openPicker);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") trackModal.classList.remove("open");
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

  return {
    entered() {
      enter.classList.add("hidden");
      document.body.classList.add("playing");
    },
    setStatus(mode: "online" | "solo" | "off") {
      statusDot.className = mode === "online" ? "" : mode === "solo" ? "solo" : "off";
      statusText.textContent = mode === "online" ? "渐强之岛 · 在线" : mode === "solo" ? "独自漫游中" : "连接中断";
    },
    setNowPlaying(def: TrackDef | null) {
      currentTrack = def;
      if (def) {
        npDot.style.background = def.color;
        npDot.style.boxShadow = `0 0 12px ${def.color}`;
        npName.textContent = def.name;
        npSub.textContent = "走近谁，就听见谁的世界";
        trackGrid.querySelectorAll(".track-card").forEach((c) => {
          c.classList.toggle("active", Number((c as HTMLElement).dataset.id) === def.id);
        });
      } else {
        npDot.style.background = "var(--ink-dim)";
        npDot.style.boxShadow = "none";
        npName.textContent = "还没选歌";
      }
    },
    get currentTrack() {
      return currentTrack;
    },
    setNearby(infos: RemoteInfo[]) {
      const audible = infos.filter((i) => i.trackId >= 0 && i.dist < 38).slice(0, 4);
      if (audible.length === 0) {
        nearby.innerHTML = `<div class="nb-empty">还空着呢，四处走走吧</div>`;
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
      const el = document.createElement("div");
      el.className = "toast";
      el.textContent = text;
      toasts.appendChild(el);
      setTimeout(() => {
        el.classList.add("out");
        setTimeout(() => el.remove(), 650);
      }, ms);
    },
    focusName() {
      enterName.focus();
    },
  };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
