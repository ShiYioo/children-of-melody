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

function btn(label: string, size: number, onTap?: () => void, onHold?: (down: boolean) => void): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.cssText = [
    "width:" + size + "px", "height:" + size + "px", "border-radius:50%",
    "display:flex", "align-items:center", "justify-content:center",
    "font-size:" + Math.round(size * 0.36) + "px", "color:#fff2df",
    "background:rgba(26,18,42,.55)", "border:1.5px solid rgba(255,236,200,.4)",
    "backdrop-filter:blur(6px)", "-webkit-backdrop-filter:blur(6px)",
    "user-select:none", "touch-action:none",
  ].join(";");
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.style.background = "rgba(255,214,130,.5)";
    if (onHold) onHold(true);
    else if (onTap) onTap();
  });
  const release = () => {
    el.style.background = "rgba(26,18,42,.55)";
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
  root.style.cssText = "position:fixed;inset:0;z-index:32;pointer-events:none;display:none;";
  document.body.appendChild(root);

  // ---- 左下：虚拟摇杆 ----
  const joyBase = document.createElement("div");
  joyBase.style.cssText = [
    "position:absolute", "left:26px", "bottom:96px", "width:124px", "height:124px",
    "border-radius:50%", "background:rgba(26,18,42,.4)",
    "border:1.5px solid rgba(255,236,200,.35)", "pointer-events:auto", "touch-action:none",
    "backdrop-filter:blur(4px)", "-webkit-backdrop-filter:blur(4px)",
  ].join(";");
  const joyKnob = document.createElement("div");
  joyKnob.style.cssText = [
    "position:absolute", "left:50%", "top:50%", "width:52px", "height:52px",
    "border-radius:50%", "transform:translate(-50%,-50%)",
    "background:rgba(255,236,200,.5)", "border:1.5px solid rgba(255,244,222,.7)",
  ].join(";");
  joyBase.appendChild(joyKnob);
  root.appendChild(joyBase);

  let joyId: number | null = null;
  let joyCx = 0;
  let joyCy = 0;
  const R = 46;
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
  cluster.style.cssText = "position:absolute;right:20px;bottom:88px;display:flex;flex-direction:column;align-items:flex-end;gap:12px;pointer-events:auto;";
  root.appendChild(cluster);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:12px;";
  const smallBtns = document.createElement("div");
  smallBtns.style.cssText = "display:flex;gap:10px;";
  const mkSmall = (label: string, onTap: () => void) => btn(label, 46, onTap);
  smallBtns.appendChild(mkSmall("💬", actions.openChat));
  smallBtns.appendChild(mkSmall("👋", actions.openWheel));
  smallBtns.appendChild(mkSmall("🎵", () => popupMenu(instrMenu)));
  smallBtns.appendChild(mkSmall("🪑", () => popupMenu(furnMenu)));
  row.appendChild(smallBtns);
  row.appendChild(btn("坐", 54, () => controls.virtualKey("e", true)));
  cluster.appendChild(row);
  cluster.appendChild(btn("跳", 74, undefined, (down) => controls.virtualKey(" ", down)));

  // ---- 弹出式小菜单（乐器/家具） ----
  function makeMenu(items: { label: string; onTap: () => void }[]): HTMLDivElement {
    const m = document.createElement("div");
    m.style.cssText = [
      "position:absolute", "right:20px", "bottom:180px", "display:none",
      "flex-direction:column", "gap:8px", "padding:12px", "border-radius:16px",
      "background:rgba(26,18,42,.9)", "border:1.5px solid rgba(255,236,200,.35)",
      "pointer-events:auto",
    ].join(";");
    for (const it of items) {
      const b = document.createElement("div");
      b.textContent = it.label;
      b.style.cssText = [
        "padding:10px 18px", "border-radius:10px", "font-size:14px", "color:#fff2df",
        "background:rgba(255,244,222,.07)", "min-width:118px", "text-align:center",
      ].join(";");
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
    { label: "🎹 竖琴", onTap: () => actions.takeInstrument(0) },
    { label: " flute 长笛", onTap: () => actions.takeInstrument(1) },
    { label: "🔔 风铃", onTap: () => actions.takeInstrument(2) },
    { label: "收起乐器", onTap: () => actions.takeInstrument(-1) },
  ]);
  const furnMenu = makeMenu([
    { label: "🪑 放/收 椅子", onTap: () => actions.toggleFurniture(0) },
    { label: "🎠 放/收 秋千", onTap: () => actions.toggleFurniture(1) },
  ]);
  function popupMenu(m: HTMLDivElement) {
    const open = m.style.display === "flex";
    instrMenu.style.display = "none";
    furnMenu.style.display = "none";
    m.style.display = open ? "none" : "flex";
  }

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
