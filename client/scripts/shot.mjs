#!/usr/bin/env node
/**
 * 用 headless Chrome + CDP 给音遇客户端截图（美术改动的验证工具）。
 *
 * 用法：
 *   node scripts/shot.mjs --out shot.png
 *   node scripts/shot.mjs --out shot.png --eval "crescendo.controls.camDist = 3" --frames 60
 *
 * 参数：
 *   --url    <url>     目标页面（默认 http://127.0.0.1:5173）
 *   --out    <path>    输出 PNG（默认 shot.png）
 *   --width  <n>       视口宽（默认 1280）
 *   --height <n>       视口高（默认 720）
 *   --frames <n>       入场后先手动泵 n 帧（隐藏页 rAF 被冻结时用）
 *   --wait   <ms>      入场后额外等待（默认 1500）
 *   --eval   <js>      入场后、截图前执行的表达式（可用 crescendo / document）
 *   --no-enter         不点入场按钮（截入场镜头）
 *   --info             额外打印 renderer.info 与场景对象数
 *   --keep             截图后不杀 Chrome（调试用）
 *
 * 只用 Node 内置模块（Node 22+ 的全局 WebSocket）；无需 puppeteer。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const arg = (name, def = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

/** `--alpha`：让页面背景变透明，截出来是带 alpha 通道的 PNG。
 *  给 img2threejs 的 turntable_gate.py 用 —— 它靠 alpha 做前景分割，
 *  不透明画布会让它报 segmentationReliable:false（整幅画面都被当成模型）。 */
const ALPHA = flag("alpha");

const URL_ = arg("url", "http://127.0.0.1:5173");
const OUT = resolve(arg("out", "shot.png"));
const WIDTH = Number(arg("width", 1280));
const HEIGHT = Number(arg("height", 720));
const FRAMES = Number(arg("frames", 0));
const WAIT = Number(arg("wait", 1500));
const EVAL = arg("eval", "");
const DO_ENTER = !flag("no-enter");
const SHOW_INFO = flag("info");
const KEEP = flag("keep");
const PORT = Number(arg("port", 9333));

// ---------------- 找 Chrome ----------------
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chromePath) {
  console.error("找不到 Chrome/Edge，可用 CHROME_PATH 环境变量指定。");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 启动 Chrome ----------------
const profile = mkdtempSync(join(tmpdir(), "yinyu-shot-"));
const chromeArgs = [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--hide-scrollbars",
  "--mute-audio",
  // WebGL：优先真 GPU，失败自动回退 SwiftShader（加 --enable-unsafe-swiftshader 让软件渲染也可用）
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "about:blank",
];
const chrome = spawn(chromePath, chromeArgs, { stdio: ["ignore", "pipe", "pipe"] });
let chromeStderr = "";
chrome.stderr.on("data", (d) => (chromeStderr += d.toString()));

function cleanup(code) {
  if (!KEEP) {
    try { chrome.kill(); } catch {}
  }
  setTimeout(() => {
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }, KEEP ? 0 : 250);
}

// ---------------- 等调试端口 ----------------
async function browserWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error("Chrome 调试端口未就绪。stderr:\n" + chromeStderr.slice(-1500));
}

// ---------------- 极简 CDP 客户端 ----------------
/** 页面控制台里的 error/warning（three 的 framebuffer 报错只走这里） */
const consoleMsgs = [];
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        // 收集页面里的报错：three 的 framebuffer/纹理错误只走 console，不抛异常，
        // 不看控制台会完全查不出"画面全黑/全空"的原因
        if (msg.method === "Runtime.consoleAPICalled") {
          const t = msg.params.type;
          if (t === "error" || t === "warning") {
            const text = (msg.params.args || [])
              .map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type)
              .join(" ");
            consoleMsgs.push(`[${t}] ${text}`);
          }
        } else if (msg.method === "Runtime.exceptionThrown") {
          const d = msg.params.exceptionDetails;
          consoleMsgs.push(`[exception] ${d.exception?.description ?? d.text}`);
        } else if (msg.method === "Log.entryAdded") {
          const e = msg.params.entry;
          if (e.level === "error" || e.level === "warning") consoleMsgs.push(`[log:${e.level}] ${e.text}`);
        }
      }
    });
    this.events = [];
    this.console = consoleMsgs;
  }
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  return new CDP(ws);
}

// ---------------- 主流程 ----------------
(async () => {
  const bws = await browserWs();
  const browser = await connect(bws);

  // 新建一个 page target 并 attach（flatten），所有命令带 sessionId
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => browser.send(m, p, sessionId);

  await s("Page.enable");
  await s("Runtime.enable");
  await s("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  // 屏蔽实时服务：dev 态会去连 127.0.0.1:2567，让它快速失败落到「独自漫游」模式
  await s("Network.enable");
  await s("Network.setBlockedURLs", { urls: ["*/matchmake*", "*/colyseus*"] }).catch(() => {});

  const evalJs = async (expression, userGesture = false) => {
    const r = await s("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, userGesture,
    });
    if (r.exceptionDetails) {
      throw new Error("页面内异常: " + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
    }
    return r.result?.value;
  };

  await s("Page.navigate", { url: URL_ });

  // 等页面加载 + 应用初始化（有 crescendo 钩子说明主模块已跑起来）
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try {
      ready = await evalJs("!!(window.crescendo && document.getElementById('enterBtn'))");
      if (ready) break;
    } catch {}
  }
  if (!ready) throw new Error("页面未初始化完成（window.crescendo / #enterBtn 未就绪）");
  await evalJs("document.fonts && document.fonts.ready ? document.fonts.ready.then(()=>true) : true");

  // 入场
  if (DO_ENTER) {
    await evalJs(
      `(() => {
         const inp = document.getElementById('enterName');
         if (inp) { inp.value = '审查'; inp.dispatchEvent(new Event('input', {bubbles:true})); }
         const btn = document.getElementById('enterBtn');
         if (btn) btn.click();
         return true;
       })()`,
      true // userGesture：让 music.unlock() 的 AudioContext.resume 能过
    );
    // 等 selfAvatar 出现（spawnSelf 完成）
    let ok = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      try {
        if (await evalJs("!!(window.crescendo && window.crescendo.selfAvatar)")) { ok = true; break; }
      } catch {}
    }
    if (!ok) console.warn("  [警告] 未等到 cresendo.selfAvatar（可能仍在连接），继续截图");
  }

  await sleep(WAIT);

  // 手动泵帧（隐藏页 rAF 被冻结时的兜底）
  if (FRAMES > 0) await evalJs(`crescendo.step(${FRAMES})`);

  // 自定义场景设置
  if (EVAL) {
    const v = await evalJs(`(() => { ${EVAL} })()`);
    if (v !== undefined && v !== null) console.log("  eval →", JSON.stringify(v));
    await evalJs(`crescendo.step(4)`);
  }

  // 等一帧真正绘完
  await evalJs("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(400);

  if (SHOW_INFO) {
    const info = await evalJs(`(() => {
      const r = crescendo.world.composer.renderer;
      // composer 一帧会 render 多次（每个 pass 一次），而 renderer.info 默认每个 render() 开头归零，
      // 所以直接读只会拿到最后一个 pass 的数字。关掉 autoReset 才能统计整帧总 draw call。
      r.info.autoReset = false;
      r.info.reset();
      crescendo.world.composer.render();
      const calls = r.info.render.calls, triangles = r.info.render.triangles;
      r.info.autoReset = true;
      let meshes = 0, instanced = 0, sprites = 0, points = 0, lines = 0;
      crescendo.world.scene.traverse(o => {
        if (o.isInstancedMesh) instanced++;
        else if (o.isMesh) meshes++;
        else if (o.isSprite) sprites++;
        else if (o.isPoints) points++;
        else if (o.isLine || o.isLineSegments) lines++;
      });
      return {
        drawCallsPerFrame: calls, trianglesPerFrame: triangles,
        programs: r.info.programs ? r.info.programs.length : -1,
        geometries: r.info.memory.geometries, textures: r.info.memory.textures,
        objects: { meshes, instanced, sprites, points, lines },
        canvas: r.domElement.width + 'x' + r.domElement.height,
      };
    })()`);
    console.log("  renderer.info:", JSON.stringify(info));
  }

  // --alpha：把页面默认背景设成全透明，截出来的 PNG 才带 alpha 通道。
  // 游戏画面的 canvas 自己是不透明的，所以普通截图看起来完全一样 ——
  // 只有被藏掉世界之后露出的"底"会变成透明，正是隔离渲染需要的。
  if (ALPHA) {
    await s("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
  }
  const shot = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log(`  已保存 ${OUT}  (${WIDTH}x${HEIGHT})`);

  if (consoleMsgs.length) {
    const uniq = [...new Set(consoleMsgs)];
    console.log(`\n  页面控制台（${consoleMsgs.length} 条，去重后 ${uniq.length}）:`);
    for (const m of uniq.slice(0, 25)) console.log("   " + m.slice(0, 400));
  } else {
    console.log("\n  页面控制台：无 error/warning");
  }

  await browser.send("Target.closeTarget", { targetId });
  cleanup(0);
})().catch((e) => {
  console.error("截图失败:", e.message);
  if (chromeStderr) console.error("Chrome stderr:\n" + chromeStderr.slice(-2000));
  cleanup(1);
});
