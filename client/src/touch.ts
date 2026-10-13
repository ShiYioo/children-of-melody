import { Armchair, createIcons, Footprints, Menu, MessageCircle } from "lucide";
import type { PlayerControls } from "./controls";

/**
 * 触屏操控层（手机/平板）：
 * · 左下虚拟摇杆（推满 = 奔跑）
 * · 右下按钮簇：跳/滑翔（按住）、坐、聊天；动作、乐器、家具收进「更多」
 * · 只在触屏设备上显示；相机环顾直接用画面拖动（Pointer 事件天然支持触摸）
 */

export interface TouchActions {
  openChat: () => void;
  openWheel: () => void;
  toggleFurniture: (kind: number) => void;
  takeInstrument: (idx: number) => void;
}

export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  // ⚠️ 这里原来有一句 `"ontouchstart" in window`，**必须去掉**。
  // 它检测的是「浏览器有没有这个属性」，不是「设备有没有触屏」——
  // 桌面 Chrome 多数版本都定义了它，于是**桌面端被误判成手机**：
  //   1) 触屏虚拟按键跑到电脑端页面上（用户实测报过）
  //   2) 更严重：scene.ts 拿这个结果当 mobile，桌面端被关掉 MSAA 抗锯齿、
  //      像素比压到 1.5、阴影降半分辨率 —— 一直在用手机画质渲染 ✗
  // 现在按「**主输入是不是触屏**」判断：
  //   手机/平板 → pointer:coarse ✓
  //   带触屏的笔记本 → 主指针是鼠标/触控板，coarse=false、也不窄 ⇒ 不切触屏 UI ✓
  //   窄窗口但没触屏（比如桌面端拉窄）⇒ 也不切 ✓
  const coarse = matchMedia("(pointer: coarse)").matches;
  const narrow = matchMedia("(max-width: 720px)").matches;
  const hasTouch = (navigator.maxTouchPoints ?? 0) > 0;
  return coarse || (narrow && hasTouch);
}

function btn(icon: string, label: string, size: number, onTap?: () => void, onHold?: (down: boolean) => void): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "touch-btn";
  el.innerHTML = `<i data-lucide="${icon}"></i>`;
  el.title = label;
  el.setAttribute("aria-label", label);
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  let captured = false;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 抓住指针：按住 64px 的「跳跃/滑翔」按钮时手指轻微滑动是常态，
    // 不捕获的话滑出边界就触发 pointerleave → 滑翔立刻中断。
    // 这是移动端最难受的一个手感 bug：想滑翔，手指一飘就掉下来。
    try {
      el.setPointerCapture(e.pointerId);
      captured = true;
    } catch {
      captured = false; // 合成事件 / 异常浏览器没有这个 pointerId
    }
    el.style.background = "rgba(255, 241, 199, .46)";
    if (onHold) onHold(true);
    else if (onTap) onTap();
  });
  const release = () => {
    captured = false;
    el.style.background = "";
    if (onHold) onHold(false);
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  // 只有**捕获失败**时才把 pointerleave 当松手；捕获成功时它不该再触发（部分浏览器仍会补一次）
  el.addEventListener("pointerleave", () => {
    if (!captured) release();
  });
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
  /**
   * 摇杆死区（占半径比例）。
   * 0.14 × 42 ≈ 5.9px —— 手指搭在摇杆上微抖不该让角色转向。
   * 原来是纯线性映射、外层只在 0.08（≈3.4px）处拦一下，手放上去角色就会缓慢平移。
   */
  const DEAD = 0.14;
  const setJoy = (dx: number, dy: number) => {
    const d = Math.hypot(dx, dy);
    const k = d > R ? R / d : 1;
    joyKnob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    if (typing()) {
      controls.touchMove.x = 0;
      controls.touchMove.z = 0;
      return;
    }
    // 死区重映射 + expo：小行程更细腻（贴着边走），推满才到 1。
    // 注意必须**先算方向单位向量、再乘整形后的长度** ——
    // 如果对 x / z 各自整形，斜推时方向会被掰偏（两个分量缩放的倍率不同）。
    const len = Math.min(1, d / R);
    const u = len <= DEAD ? 0 : (len - DEAD) / (1 - DEAD);
    const shaped = Math.pow(u, 1.25);
    const nx = d > 1e-6 ? dx / d : 0;
    const nz = d > 1e-6 ? dy / d : 0;
    controls.touchMove.x = nx * shaped;
    controls.touchMove.z = nz * shaped;
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
  smallBtns.appendChild(mkSmall("menu", "更多", () => popupMenu(moreMenu)));
  row.appendChild(smallBtns);
  row.appendChild(btn("armchair", "坐下", 50, () => controls.virtualKey("e", true)));
  cluster.appendChild(row);
  cluster.appendChild(btn("footprints", "跳跃或飞行", 64, undefined, (down) => controls.virtualKey(" ", down)));

  // ---- 弹出式小菜单（低频动作） ----
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
  const moreMenu = makeMenu([
    { label: "动作", onTap: actions.openWheel },
    { label: "竖琴", onTap: () => actions.takeInstrument(0) },
    { label: "长笛", onTap: () => actions.takeInstrument(1) },
    { label: "风铃", onTap: () => actions.takeInstrument(2) },
    { label: "收起乐器", onTap: () => actions.takeInstrument(-1) },
    { label: "放置 / 收起椅子", onTap: () => actions.toggleFurniture(0) },
    { label: "放置 / 收起秋千", onTap: () => actions.toggleFurniture(1) },
  ]);
  function popupMenu(m: HTMLDivElement) {
    const open = m.style.display === "flex";
    m.style.display = open ? "none" : "flex";
  }

  createIcons({ icons: { Armchair, Footprints, Menu, MessageCircle } });
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
