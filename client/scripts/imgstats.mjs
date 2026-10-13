#!/usr/bin/env node
/**
 * 音遇画面定量分析：解码 PNG（无第三方依赖，用 node:zlib）后输出可用于 A/B 对比的指标。
 *
 * 用法：
 *   node scripts/imgstats.mjs a.png
 *   node scripts/imgstats.mjs a.png b.png            # 两张并排对比 + 差值
 *   node scripts/imgstats.mjs a.png --json           # 机器可读
 *
 * 为什么需要它：验证「发光是否真的生效」「MSAA 是否真的打开」这类改动，
 * 肉眼不可靠、也无从对比；下面的指标是可直接 A/B 的硬数字。
 *
 * 指标说明：
 *   lumaMean/Max      线性亮度均值/最大值
 *   glow%             亮度 > 0.75 的像素占比 —— 直接反映「有没有真在发光」
 *   hi%               亮度 > 0.90 的像素占比（过曝面积）
 *   dark%             亮度 < 0.10 的像素占比
 *   edgeHard%         相邻像素亮度差 > 0.25 的占比 —— 越高说明锯齿/硬边越多
 *   edgeSoft%         相邻像素亮度差在 0.03~0.25 —— MSAA 打开后这个会明显上升
 *   edgeHard/Soft     比值，越接近 1 说明边缘越"软"（越小越软）
 *   colorfulness      平均色度（max-min 通道），反映画面是不是发灰
 *   region*           九宫格各区域的平均亮度/色相（看地面/天空/水面分层）
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

// ---------------- PNG 解码 ----------------
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("只支持 8-bit PNG，当前 " + bitDepth);
  if (interlace !== 0) throw new Error("不支持隔行 PNG");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels < 0) throw new Error("不支持 colorType " + colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawv = raw[rp + x];
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= channels && y > 0 ? out[prevStart + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rawv; break;
        case 1: v = rawv + a; break;
        case 2: v = rawv + b; break;
        case 3: v = rawv + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = rawv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("未知滤波器 " + filter);
      }
      out[rowStart + x] = v & 0xff;
    }
    rp += stride;
  }
  return { width, height, channels, data: out };
}

// sRGB → 线性（Rec709 亮度用线性值才有意义）
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function analyze(img) {
  const { width: W, height: H, channels: C, data } = img;
  const n = W * H;
  let sum = 0, max = 0, glow = 0, hi = 0, dark = 0, chroma = 0;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * C;
    const r = data[o] / 255, g = data[o + 1] / 255, b = data[o + 2] / 255;
    const L = 0.2126 * s2l(r) + 0.7152 * s2l(g) + 0.0722 * s2l(b);
    lum[i] = L;
    sum += L;
    if (L > max) max = L;
    if (L > 0.75) glow++;
    if (L > 0.90) hi++;
    if (L < 0.10) dark++;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  // 边缘梯度（水平 + 垂直），用 sRGB 空间算差值更贴近观感
  let hard = 0, soft = 0, edges = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const d = Math.abs(lum[y * W + x] - lum[y * W + x - 1]);
      if (d > 0.25) hard++; else if (d > 0.03) soft++;
      if (d > 0.03) edges++;
    }
  }
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.abs(lum[y * W + x] - lum[(y - 1) * W + x]);
      if (d > 0.25) hard++; else if (d > 0.03) soft++;
      if (d > 0.03) edges++;
    }
  }
  const samples = 2 * n;
  // 九宫格分区亮度
  const regions = [];
  for (let ry = 0; ry < 3; ry++) {
    for (let rx = 0; rx < 3; rx++) {
      let s = 0, c = 0;
      const y0 = Math.floor((ry * H) / 3), y1 = Math.floor(((ry + 1) * H) / 3);
      const x0 = Math.floor((rx * W) / 3), x1 = Math.floor(((rx + 1) * W) / 3);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += lum[y * W + x]; c++; }
      regions.push(s / c);
    }
  }
  const pct = (v) => +((v / n) * 100).toFixed(3);
  return {
    size: `${W}x${H}`,
    lumaMean: +(sum / n).toFixed(4),
    lumaMax: +max.toFixed(4),
    glowPct: pct(glow),
    hiPct: pct(hi),
    darkPct: pct(dark),
    colorfulness: +(chroma / n).toFixed(4),
    edgeHardPct: +((hard / samples) * 100).toFixed(3),
    edgeSoftPct: +((soft / samples) * 100).toFixed(3),
    edgeHardSoft: +((hard / Math.max(1, soft))).toFixed(4),
    regions: regions.map((v) => +v.toFixed(3)),
  };
}

function diff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { note: "尺寸不同，跳过差值" };
  const n = a.width * a.height;
  let changed = 0, sumAbs = 0;
  for (let i = 0; i < n; i++) {
    const o = i * a.channels, p = i * b.channels;
    const d = (Math.abs(a.data[o] - b.data[p]) + Math.abs(a.data[o + 1] - b.data[p + 1]) + Math.abs(a.data[o + 2] - b.data[p + 2])) / 3;
    sumAbs += d;
    if (d > 6) changed++;
  }
  return { changedPct: +((changed / n) * 100).toFixed(2), meanAbsDiff: +(sumAbs / n).toFixed(2) };
}

// ---------------- CLI ----------------
const files = process.argv.slice(2).filter((a) => !a.startsWith("--") && a.endsWith(".png"));
const asJson = process.argv.includes("--json");
if (!files.length) {
  console.error("用法: node scripts/imgstats.mjs <a.png> [b.png] [--json]");
  process.exit(2);
}
const imgs = files.map((f) => ({ f, img: decodePNG(readFileSync(f)) }));
const results = imgs.map(({ f, img }) => ({ file: f, ...analyze(img) }));
if (asJson) {
  console.log(JSON.stringify(imgs.length === 2 ? { a: results[0], b: results[1], diff: diff(imgs[0].img, imgs[1].img) } : results, null, 2));
} else {
  const keys = ["size", "lumaMean", "lumaMax", "glowPct", "hiPct", "darkPct", "colorfulness", "edgeHardPct", "edgeSoftPct", "edgeHardSoft"];
  console.log("指标".padEnd(14) + results.map((r) => r.file.split(/[\\/]/).pop().padEnd(18)).join(""));
  for (const k of keys) {
    console.log(k.padEnd(14) + results.map((r) => String(r[k]).padEnd(18)).join(""));
  }
  console.log("regions".padEnd(14) + results.map((r) => r.regions.slice(3, 6).join(",").padEnd(18)).join(""));
  if (results.length === 2) {
    const d = diff(imgs[0].img, imgs[1].img);
    console.log("\n差值: " + JSON.stringify(d));
  }
}
