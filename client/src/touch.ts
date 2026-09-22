import { Armchair, createIcons, Footprints, MessageCircle, Music2, Package, Sparkles } from "lucide";
import type { PlayerControls } from "./controls";

/**
 * 触屏操控层（手机/平板）：
 * · 左下虚拟摇杆（推满 = 奔跑）
 * · 右下按钮簇：跳/滑翔（按住）、坐、聊天、表情、乐器、家具
 * · 只在触屏设备上显示；相机环顾直接用画面拖动（Pointer 事件天然支持触摸）
 */

export interface TouchActions {
  openChat: () => void;
  openWheel: () => void;
  toggleFurniture: (kind: number) => void;
  takeInstrument: (idx: number) => void;
}

export function isTouchDevice(): boolean {
  return (typeof window !== "undefined" && matchMedia("(pointer: coarse)").matches) || "ontouchstart" in window;
}

function btn(icon: string, label: string, size: number, onTap?: () => void, onHold?: (down: boolean) => void): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "touch-btn";
  el.innerHTML = `<i data-lucide="${icon}"></i>`;
  el.title = label;
  el.setAttribute("aria-label", label);
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.style.background = "rgba(255, 241, 199, .46)";
    if (onHold) onHold(true);
    else if (onTap) onTap();
  });
  const release = () => {
    el.style.background = "";
    if (onHold) onHold(false);
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("pointerleave", release);
  return el;
}

/** 输入框聚焦时（聊天/选歌打字）忽略虚拟输入；入场名字框不算——进游戏后焦点还留在那 */
function typing(): boolean {
  const t = document.activeElement as HTMLElement | null;
  if (!t?.matches?.("input, textarea, [contenteditable]")) return false;
  if (t.id === "enterName" || t.closest?.("#enter")) return false;
  return true;
}

export function createTouchUI(controls: PlayerControls, actions: TouchActions): { setVisible: (v: boolean) => void } {
  const root = document.createElement("div");
  root.className = "touch-root";
  document.body.appendChild(root);

  // ---- 左下：虚拟摇杆 ----
  const joyBase = document.createElement("div");
  joyBase.className = "touch-joystick";
  const joyKnob = document.createElement("div");
  joyKnob.className = "touch-knob";
  joyBase.appendChild(joyKnob);
  root.appendChild(joyBase);

  let joyId: number | null = null;
  let joyCx = 0;
  let joyCy = 0;
  const R = 42;
  const setJoy = (dx: number, dy: number) => {
    const d = Math.hypot(dx, dy);
    const k = d > R ? R / d : 1;
    joyKnob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    if (typing()) {
      controls.touchMove.x = 0;
      controls.touchMove.z = 0;
    } else {
      controls.touchMove.x = (dx * k) / R;
      controls.touchMove.z = (dy * k) / R;
    }
  };
  joyBase.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    joyId = e.pointerId;
    const r = joyBase.getBoundingClientRect();
    joyCx = r.left + r.width / 2;
    joyCy = r.top + r.height / 2;
    try {
      joyBase.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件/异常浏览器没有这个指针 id，忽略 */
    }
    setJoy(e.clientX - joyCx, e.clientY - joyCy);
  });
  joyBase.addEventListener("pointermove", (e) => {
    if (e.pointerId !== joyId) return;
    setJoy(e.clientX - joyCx, e.clientY - joyCy);
  });
  const joyEnd = (e: PointerEvent) => {
    if (e.pointerId !== joyId) return;
    joyId = null;
    setJoy(0, 0);
  };
  joyBase.addEventListener("pointerup", joyEnd);
  joyBase.addEventListener("pointercancel", joyEnd);

  // ---- 右下：按钮簇 ----
  const cluster = document.createElement("div");
  cluster.className = "touch-cluster";
  root.appendChild(cluster);

  const row = document.createElement("div");
  row.className = "touch-row";
  const smallBtns = document.createElement("div");
  smallBtns.className = "touch-small-row";
  const mkSmall = (icon: string, label: string, onTap: () => void) => btn(icon, label, 44, onTap);
  smallBtns.appendChild(mkSmall("message-circle", "说话", actions.openChat));
  smallBtns.appendChild(mkSmall("sparkles", "动作", actions.openWheel));
  smallBtns.appendChild(mkSmall("music-2", "乐器", () => popupMenu(instrMenu)));
  smallBtns.appendChild(mkSmall("package", "家具", () => popupMenu(furnMenu)));
  row.appendChild(smallBtns);
  row.appendChild(btn("armchair", "坐下", 50, () => controls.virtualKey("e", true)));
  cluster.appendChild(row);
  cluster.appendChild(btn("footprints", "跳跃或飞行", 64, undefined, (down) => controls.virtualKey(" ", down)));

  // ---- 弹出式小菜单（乐器/家具） ----
  function makeMenu(items: { label: string; onTap: () => void }[]): HTMLDivElement {
    const m = document.createElement("div");
    m.className = "touch-menu";
    for (const it of items) {
      const b = document.createElement("div");
      b.textContent = it.label;
      b.className = "touch-menu-item";
      b.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        it.onTap();
        m.style.display = "none";
      });
      m.appendChild(b);
    }
    root.appendChild(m);
    return m;
  }
  const instrMenu = makeMenu([
    { label: "竖琴", onTap: () => actions.takeInstrument(0) },
    { label: "长笛", onTap: () => actions.takeInstrument(1) },
    { label: "风铃", onTap: () => actions.takeInstrument(2) },
    { label: "收起乐器", onTap: () => actions.takeInstrument(-1) },
  ]);
  const furnMenu = makeMenu([
    { label: "放置 / 收起椅子", onTap: () => actions.toggleFurniture(0) },
    { label: "放置 / 收起秋千", onTap: () => actions.toggleFurniture(1) },
  ]);
  function popupMenu(m: HTMLDivElement) {
    const open = m.style.display === "flex";
    instrMenu.style.display = "none";
    furnMenu.style.display = "none";
    m.style.display = open ? "none" : "flex";
  }

  createIcons({ icons: { Armchair, Footprints, MessageCircle, Music2, Package, Sparkles } });
  root.querySelectorAll("svg[data-lucide]").forEach((icon) => icon.removeAttribute("data-lucide"));

  return {
    setVisible(v: boolean) {
      root.style.display = v ? "block" : "none";
      if (!v) {
        controls.touchMove.x = 0;
        controls.touchMove.z = 0;
      }
    },
  };
}
