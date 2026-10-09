import * as THREE from "three";
import { CSS3DRenderer, CSS3DObject } from "three/examples/jsm/renderers/CSS3DRenderer.js";

/**
 * 随身大屏：人物面前展开的 16:9 电子屏，24m 内的人共同观看。
 *
 * 全部媒体走 CSS3D 叠加层（iframe / <video> 元素），不进 WebGL 纹理——
 * 跨域媒体没有 CORS 头时 VideoTexture 会黑屏，CSS3D 是唯一稳定路线。
 * 代价：屏幕永远画在 3D 场景上层（不参与遮挡），换来了"任意网页能看"。
 *
 * 主人权威：主人端 iframe/video 可直接操作（点播放器自带控件），
 * 每 5s 心跳把进度广播给观众；观众端只读镜像，音量按距离衰减。
 */

export interface ResolvedMedia {
  kind: "video" | "web";
  url: string;
}

/** 识别媒体源：YouTube / B站自动转播放器嵌入页；mp4/webm 直链；其余按普通网页尝试 */
export function resolveMediaUrl(raw: string): ResolvedMedia | null {
  const url = raw.trim();
  if (!/^https:\/\/.+/i.test(url) || url.length > 500 || /[<>"'\\]/.test(url)) return null;
  let m: RegExpMatchArray | null;
  if ((m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{6,20})/i))) {
    return { kind: "web", url: `https://www.youtube.com/embed/${m[1]}?enablejsapi=1&playsinline=1&autoplay=1` };
  }
  if ((m = url.match(/bilibili\.com\/video\/(BV[\w]+)/i))) {
    return { kind: "web", url: `https://player.bilibili.com/player.html?bvid=${m[1]}&autoplay=0&danmaku=0` };
  }
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return { kind: "video", url };
  return { kind: "web", url };
}

const W = 2.4;
const H = 1.35;

interface ScreenState {
  group: THREE.Group;
  cssObj: CSS3DObject | null;
  host: HTMLDivElement | null;
  media: "none" | "video" | "web";
  video: HTMLVideoElement | null;
  iframe: HTMLIFrameElement | null;
  open: number; // 展开动画 0→1
  on: boolean;
}

export function createScreenSystem(
  host: HTMLElement,
  addToScene: (o: THREE.Object3D) => void,
  removeFromScene: (o: THREE.Object3D) => void
) {
  const cssRenderer = new CSS3DRenderer();
  cssRenderer.domElement.style.position = "absolute";
  cssRenderer.domElement.style.inset = "0";
  cssRenderer.domElement.style.pointerEvents = "none";
  cssRenderer.domElement.style.zIndex = "5";
  cssRenderer.domElement.style.overflow = "hidden";
  host.appendChild(cssRenderer.domElement);

  const screens = new Map<string, ScreenState>();

  const frameMat = () => new THREE.MeshStandardMaterial({ color: new THREE.Color("#232c38"), roughness: 0.55, metalness: 0.35 });

  function ensure(id: string): ScreenState {
    let s = screens.get(id);
    if (s) return s;
    const group = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(W + 0.14, H + 0.14, 0.07), frameMat());
    frame.position.y = H / 2 + 0.62;
    frame.castShadow = true;
    group.add(frame);
    // 屏底（CSS 层未加载时的"黑屏"）
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshBasicMaterial({ color: new THREE.Color("#0b111a") })
    );
    back.position.set(0, H / 2 + 0.62, 0.045);
    group.add(back);
    // 支架腿
    const legGeo = new THREE.BoxGeometry(0.07, 0.66, 0.07);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, frameMat());
      leg.position.set(sx * (W / 2 - 0.16), 0.33, 0);
      leg.castShadow = true;
      group.add(leg);
    }
    group.visible = false;
    addToScene(group);
    s = { group, cssObj: null, host: null, media: "none", video: null, iframe: null, open: 0, on: false };
    screens.set(id, s);
    return s;
  }

  function clearMedia(s: ScreenState) {
    if (s.video) {
      s.video.pause();
      s.video.removeAttribute("src");
      s.video.load();
      s.video = null;
    }
    if (s.iframe) {
      s.iframe.src = "about:blank";
      s.iframe = null;
    }
    // 从 CSS3D 渲染层摘掉 DOM（renderer 不会自动清理已移除对象的节点）
    s.host?.remove();
    if (s.cssObj) s.group.remove(s.cssObj);
    s.host = null;
    s.cssObj = null;
    s.media = "none";
  }

  function makeHost(s: ScreenState, interactive: boolean): HTMLDivElement {
    const host = document.createElement("div");
    host.style.width = `${W * 100}px`;
    host.style.height = `${H * 100}px`;
    host.style.backgroundColor = "#0b111a";
    host.style.overflow = "hidden";
    host.style.pointerEvents = interactive ? "auto" : "none";
    const el: HTMLElement = s.media === "video"
      ? (() => {
          const v = document.createElement("video") as HTMLVideoElement;
          v.src = "";
          v.controls = interactive;
          v.playsInline = true;
          v.style.width = "100%";
          v.style.height = "100%";
          v.style.objectFit = "contain";
          return v;
        })()
      : (() => {
          const f = document.createElement("iframe") as HTMLIFrameElement;
          f.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
          f.referrerPolicy = "no-referrer";
          f.style.width = "100%";
          f.style.height = "100%";
          f.style.border = "0";
          return f;
        })();
    s.video = s.media === "video" ? (el as HTMLVideoElement) : null;
    s.iframe = s.media === "web" ? (el as HTMLIFrameElement) : null;
    host.appendChild(el);
    return host;
  }

  return {
    /** 开/关某块屏（主人或远端镜像） */
    setOpen(id: string, on: boolean) {
      const s = ensure(id);
      s.on = on;
      if (!on) clearMedia(s);
    },

    /** 设置媒体源（url 为已解析的嵌入地址） */
    setMedia(id: string, url: string, kind: "video" | "web", interactive: boolean) {
      const s = ensure(id);
      clearMedia(s);
      if (!url) return;
      s.media = kind;
      s.host = makeHost(s, interactive);
      s.cssObj = new CSS3DObject(s.host);
      s.cssObj.position.set(0, H / 2 + 0.62, 0.05);
      s.group.add(s.cssObj);
      if (kind === "web") s.iframe!.src = url;
    },

    /** 取出媒体元素并加载地址（必须在 setMedia 之后） */
    load(id: string, url: string) {
      const s = screens.get(id);
      if (!s) return;
      if (s.video) s.video.src = url;
      else if (s.iframe) s.iframe.src = url;
    },

    /** 播放/暂停 + 对齐进度（观众端镜像主人心跳） */
    setPlay(id: string, play: boolean, t: number) {
      const s = screens.get(id);
      if (!s) return;
      if (s.video) {
        if (t >= 0 && Number.isFinite(s.video.duration)) {
          try { s.video.currentTime = t; } catch { /* 元数据未就绪 */ }
        }
        if (play) void s.video.play().catch(() => { /* 自动播放策略拒绝：用户点一下屏幕即可 */ });
        else s.video.pause();
      } else if (s.iframe && s.iframe.src.includes("youtube.com/embed")) {
        // YouTube 嵌入 API：postMessage 控制（B站 embed 无公开等价接口，跳过）
        s.iframe.contentWindow?.postMessage(
          JSON.stringify({ event: "command", func: play ? "playVideo" : "pauseVideo", args: [] }),
          "*"
        );
      }
    },

    /** 观众端音量（0-1，按与主人的距离算好传入；iframe 媒体无法控量则忽略） */
    setVolume(id: string, v: number) {
      const s = screens.get(id);
      if (s?.video) s.video.volume = Math.max(0, Math.min(1, v));
    },

    /** 主人心跳用：自己屏幕上视频的当前进度（秒） */
    getTime(id: string): number {
      return screens.get(id)?.video?.currentTime ?? 0;
    },

    /** 每帧：屏幕跟随主人（位置/朝向）+ 展开动画 */
    update(
      dt: number,
      self: { pos: THREE.Vector3; yaw: number },
      remoteOf: (id: string) => { pos: THREE.Vector3; yaw: number } | null,
      volumeOf: (id: string) => number
    ) {
      for (const [id, s] of screens) {
        const owner = id === "self" ? self : remoteOf(id);
        if (!s.on || !owner) {
          s.group.visible = false;
          continue;
        }
        s.group.visible = true;
        s.open += (1 - s.open) * Math.min(1, dt * 5);
        const e = 1 - Math.pow(1 - s.open, 2); // easeOut
        s.group.scale.setScalar(0.05 + 0.95 * e);
        const fx = Math.sin(owner.yaw);
        const fz = Math.cos(owner.yaw);
        s.group.position.set(owner.pos.x + fx * 2.2, Math.max(owner.pos.y, 0) + 0.05, owner.pos.z + fz * 2.2);
        s.group.lookAt(owner.pos.x, s.group.position.y + 0.8, owner.pos.z);
        if (s.video) s.video.volume = Math.max(0, Math.min(1, volumeOf(id)));
      }
    },

    /** CSS3D 层渲染：CSS3DObject 已挂在主场景，传入主场景与相机即可 */
    renderOn(scene: THREE.Scene, camera: THREE.Camera) {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (cssRenderer.domElement.clientWidth !== w || cssRenderer.domElement.clientHeight !== h) {
        cssRenderer.setSize(w, h);
      }
      cssRenderer.render(scene, camera);
    },

    /** 页面卸载/重连清理 */
    dispose() {
      for (const [, s] of screens) {
        clearMedia(s);
        removeFromScene(s.group);
      }
      screens.clear();
      cssRenderer.domElement.remove();
    },
  };
}
