import * as THREE from "three";

/**
 * 随身大屏：人物面前展开的 16:9 电子屏，24m 内的人共同观看。
 *
 * 渲染方案：媒体（<video>/<iframe>）放进 fixed 定位的 DOM 层，每帧把屏幕
 * 四角的世界坐标投影到视口像素、解一组单应矩阵写成 CSS matrix3d——
 * 确定性透视贴合，不依赖 three 的 CSS3DRenderer 内部行为。
 * 已知边界：DOM 层永远画在 3D 场景上方（不参与遮挡）；跨域 iframe 无法编程控量。
 *
 * 主人权威：主人端媒体可直接操作（播放器自带控件/网页交互），
 * 每 5s 心跳广播进度；观众端只读镜像，音量按距离衰减（限直链视频）。
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

const W = 3.8;
const H = 2.14;
/** 屏面中心相对 group 原点的高度（支架腿加高适配巨幕） */
const CY = H / 2 + 0.9;
/** 媒体的虚拟视口（16:9）：网页/视频按这个尺寸渲染再整体透视缩小贴屏，
 *  保证桌面网页游戏拿到正常大小的窗口、内容完整不用滚动。
 *  overscan：媒体画布比物理屏面大 15%，四周裁掉——吃掉网页自带的黑边/留白，内容撑满屏面 */
const VW = 1104;
const VH = 621;

interface ScreenState {
  group: THREE.Group;
  host: HTMLDivElement | null;
  media: "none" | "video" | "web";
  video: HTMLVideoElement | null;
  iframe: HTMLIFrameElement | null;
  open: number; // 展开动画 0→1
  on: boolean;
}

/** 解 4 对点的单应矩阵（h33=1，返回 8 个自由元素；奇异时返回 null） */
function solveHomography(src: number[][], dst: number[][]): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  // 高斯消元（部分主元）
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-9) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    // 主元归一 + 全列消元（Gauss-Jordan）：结束后 b 即解
    const d = A[col][col];
    for (let c = col; c < 8; c++) A[col][c] /= d;
    b[col] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return b; // [h11,h12,h13,h21,h22,h23,h31,h32]
}

// 复用临时量
const _v = new THREE.Vector3();
const _normal = new THREE.Vector3();
// 屏面四角（局部坐标），顺序与 host 像素坐标一一对应（左上/右上/右下/左下）。
// 屏幕总是 lookAt 主人（+z 朝向主人/相机一侧），正面观察时局部 +x 在画面右——
// 角点顺序以正面视角为准（背面视角下四点环绕反向，解出的单应会镜像病态）
const _corners = [
  new THREE.Vector3(-W / 2, CY + H / 2, 0.05),
  new THREE.Vector3(W / 2, CY + H / 2, 0.05),
  new THREE.Vector3(W / 2, CY - H / 2, 0.05),
  new THREE.Vector3(-W / 2, CY - H / 2, 0.05),
];
const _src = [[0, 0], [VW, 0], [VW, VH], [0, VH]];const _dst: number[][] = [[0, 0], [0, 0], [0, 0], [0, 0]];

export function createScreenSystem(
  hostLayer: HTMLElement,
  addToScene: (o: THREE.Object3D) => void,
  removeFromScene: (o: THREE.Object3D) => void
) {
  const screens = new Map<string, ScreenState>();
  /** 入座模式：update() 每帧把相机钉到 self 屏幕正前方（在 group 更新之后执行，顺序绝对正确） */
  let seatMode = false;

  const frameMat = () => new THREE.MeshStandardMaterial({ color: new THREE.Color("#232c38"), roughness: 0.55, metalness: 0.35 });

  function ensure(id: string): ScreenState {
    let s = screens.get(id);
    if (s) return s;
    const group = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(W + 0.14, H + 0.14, 0.07), frameMat());
    frame.position.y = CY;
    frame.castShadow = true;
    group.add(frame);
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshBasicMaterial({ color: new THREE.Color("#0b111a") })
    );
    back.position.set(0, CY, 0.045);
    group.add(back);
    const legGeo = new THREE.BoxGeometry(0.09, 0.9, 0.09);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, frameMat());
      leg.position.set(sx * (W / 2 - 0.22), 0.45, 0);
      leg.castShadow = true;
      group.add(leg);
    }
    group.visible = false;
    addToScene(group);
    s = { group, host: null, media: "none", video: null, iframe: null, open: 0, on: false };
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
    s.host?.remove();
    s.host = null;
    s.media = "none";
  }

  function setMedia(id: string, url: string, kind: "video" | "web", interactive: boolean) {
    const s = ensure(id);
    clearMedia(s);
    if (!url) return;
    s.media = kind;
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "0";
    host.style.top = "0";
    host.style.width = `${VW}px`;
    host.style.height = `${VH}px`;
    host.style.transformOrigin = "0 0";
    host.style.backgroundColor = "#0b111a";
    host.style.overflow = "hidden";
    host.style.zIndex = "5";
    host.style.pointerEvents = interactive ? "auto" : "none";
    host.style.display = "none"; // 首帧投影后再显示
    let el: HTMLVideoElement | HTMLIFrameElement;
    if (kind === "video") {
      const v = document.createElement("video") as HTMLVideoElement;
      v.controls = interactive;
      v.playsInline = true;
      v.style.width = "100%";
      v.style.height = "100%";
      v.style.objectFit = "contain";
      el = v;
      s.video = v;
    } else {
      const f = document.createElement("iframe") as HTMLIFrameElement;
      f.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
      f.referrerPolicy = "no-referrer";
      f.style.width = "100%";
      f.style.height = "100%";
      f.style.border = "0";
      el = f;
      s.iframe = f;
    }
    host.appendChild(el);
    s.host = host;
    hostLayer.appendChild(host);
    if (kind === "web") s.iframe!.src = url;
    else s.video!.src = url;
  }

  return {
    /** 开/关某块屏（主人或远端镜像） */
    setOpen(id: string, on: boolean) {
      const s = ensure(id);
      s.on = on;
      if (!on) clearMedia(s);
    },

    /** 入座模式开关：update() 每帧把相机钉到 self 屏幕正前方 */
    setSeatMode(on: boolean) {
      seatMode = on;
    },

    setMedia,

    /** 播放/暂停 + 对齐进度（观众端镜像主人心跳） */
    setPlay(id: string, play: boolean, t: number) {
      const s = screens.get(id);
      if (!s) return;
      if (s.video) {
        if (t > 0 && Number.isFinite(s.video.duration)) {
          try { s.video.currentTime = t; } catch { /* 元数据未就绪 */ }
        }
        if (play) void s.video.play().catch(() => { /* 自动播放策略拒绝：用户点一下屏幕即可 */ });
        else s.video.pause();
      } else if (s.iframe && s.iframe.src.includes("youtube.com/embed")) {
        // YouTube 嵌入 API（B站 embed 无公开等价接口，跳过）
        s.iframe.contentWindow?.postMessage(
          JSON.stringify({ event: "command", func: play ? "playVideo" : "pauseVideo", args: [] }),
          "*"
        );
      }
    },

    /** 主人心跳用：自己屏幕上视频的当前进度（秒） */
    getTime(id: string): number {
      return screens.get(id)?.video?.currentTime ?? 0;
    },

    /** 入座模式用：屏幕正面 dist 米处的观看机位（pos + 注视点） */
    getViewpoint(id: string, dist: number, out: { pos: THREE.Vector3; look: THREE.Vector3 }): boolean {
      const s = screens.get(id);
      if (!s || !s.group.visible) return false;
      s.group.updateMatrixWorld(true);
      const center = _v.set(0, CY, 0.05).applyMatrix4(s.group.matrixWorld);
      const nz = _normal.set(0, 0, 1).transformDirection(s.group.matrixWorld);
      out.pos.copy(center).addScaledVector(nz, dist);
      out.look.copy(center);
      return true;
    },

    /** 每帧：屏幕跟随主人 + 展开动画 + 四角投影贴 DOM */
    update(
      dt: number,
      camera: THREE.Camera,
      viewportW: number,
      viewportH: number,
      self: { pos: THREE.Vector3; yaw: number },
      remoteOf: (id: string) => { pos: THREE.Vector3; yaw: number } | null,
      volumeOf: (id: string) => number
    ) {
      // 相机矩阵保鲜（update 在 WebGL render 之前跑，project 需要本帧矩阵）
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      // 投影矩阵自愈：aspect 曾被 0 尺寸污染成 NaN 时，用当前视口强制重算
      if (!Number.isFinite(camera.projectionMatrix.elements[0])) {
        const cw = hostLayer.clientWidth || window.innerWidth;
        const ch = hostLayer.clientHeight || window.innerHeight;
        if (cw > 2 && ch > 2) {
          const pc = camera as THREE.PerspectiveCamera;
          pc.aspect = cw / ch;
          pc.updateProjectionMatrix();
        }
      }
      for (const [id, s] of screens) {
        const owner = id === "self" ? self : remoteOf(id);
        const show = s.on && !!owner && (s.host !== null || s.media === "none");
        if (!show) {
          s.group.visible = false;
          if (s.host) s.host.style.display = "none";
          continue;
        }
        s.group.visible = true;
        s.open += (1 - s.open) * Math.min(1, dt * 5);
        const e = 1 - Math.pow(1 - s.open, 2);
        s.group.scale.setScalar(0.05 + 0.95 * e);
        const fx = Math.sin(owner.yaw);
        const fz = Math.cos(owner.yaw);
        s.group.position.set(owner.pos.x + fx * 2.8, Math.max(owner.pos.y, 0) + 0.05, owner.pos.z + fz * 2.8);
        s.group.lookAt(owner.pos.x, s.group.position.y + 0.8, owner.pos.z);
        s.group.updateMatrixWorld(true);
        if (s.video) s.video.volume = Math.max(0, Math.min(1, volumeOf(id)));

        if (!s.host) continue;
        // 四角世界 → 视口像素（手写透视：不依赖 renderer 更新的逆矩阵，
        // rAF 冻结恢复后也立即正确；w≈0 或结果非有限时整帧隐藏防 NaN 污染）
        camera.updateMatrixWorld();
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        const pe = camera.projectionMatrix.elements;
        let behind = false;
        for (let i = 0; i < 4; i++) {
          _v.copy(_corners[i]).applyMatrix4(s.group.matrixWorld);
          _v.applyMatrix4(camera.matrixWorldInverse);
          const cx = pe[0] * _v.x + pe[4] * _v.y + pe[8] * _v.z + pe[12];
          const cy = pe[1] * _v.x + pe[5] * _v.y + pe[9] * _v.z + pe[13];
          const cw = pe[3] * _v.x + pe[7] * _v.y + pe[11] * _v.z + pe[15];
          if (!Number.isFinite(cx) || !Number.isFinite(cy) || Math.abs(cw) < 1e-6 || cw < 0) behind = true;
          _dst[i][0] = (cx / cw) * 0.5 * viewportW + viewportW / 2;
          _dst[i][1] = viewportH / 2 - (cy / cw) * 0.5 * viewportH;
        }
        if (behind) {
          s.host.style.display = "none";
          continue;
        }
        const hom = solveHomography(_src, _dst);
        if (!hom) {
          s.host.style.display = "none";
          continue;
        }
        const [h11, h12, h13, h21, h22, h23, h31, h32] = hom;
        s.host.style.display = "block";
        s.host.style.transform =
          `matrix3d(${h11},${h21},0,${h31},${h12},${h22},0,${h32},0,0,1,0,${h13},${h23},0,1)`;
        s.host.style.opacity = String(Math.max(0.25, e));
      }
      // 入座模式：紧跟 group 更新，把相机钉到 self 屏幕正前方 1.7m（长焦铺满由外部 fovOverride 配合）
      if (seatMode) {
        const s = screens.get("self");
        if (s && s.on && s.group.visible) {
          s.group.updateMatrixWorld(true);
          const center = _v.set(0, CY, 0.05).applyMatrix4(s.group.matrixWorld);
          const n = _normal.set(0, 0, 1).transformDirection(s.group.matrixWorld);
          camera.position.copy(center).addScaledVector(n, 1.7);
          camera.lookAt(center);
        }
      }
    },

    dispose() {
      for (const [, s] of screens) {
        clearMedia(s);
        removeFromScene(s.group);
      }
      screens.clear();
    },
  };
}
