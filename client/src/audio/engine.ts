import { TRACKS, trackById, midiToFreq, isCustomTrack, songIdOf, CUSTOM_BASE, isUrlTrack, type TrackDef } from "./tracks";

/**
 * 音乐引擎：音遇的心脏。
 *
 * - 每首歌是确定性生成的：由 (trackId, 起始时间) 即可在各端合奏出
 *   完全一致的旋律（音频流不过服务器）。
 * - 距离混音：身边的人各占一条音频总线，
 *   远处 → 低通滤波(朦胧) + 小音量，近处 → 全频段 + 清晰，
 *   最多同时清晰混入最近的 3 首。
 */

const AUDIBLE_RADIUS = 38; // 米：能听见别人音乐的距离
const MAX_MIX = 3; // 最多清晰混入的曲目数

// 监听者方位的复用临时量（每帧 setListener 用，避免分配）
import * as THREE from "three";
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

/** 32 位确定性随机（同一 beat 序号在各端产生相同序列） */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Source {
  kind: "gen" | "file" | "url";  def: TrackDef | null;
  songId: number; // file 源的服务器曲目 id
  songName: string;
  url: string; // url 源的音频直链
  bus: GainNode; // 音符/文件汇入点
  filter: BiquadFilterNode | null; // 远端专属低通
  gain: GainNode; // 最终音量（距离控制）
  startCtx: number; // beat 0 对应的 ctx 时间
  nextBeat: number;
  nextBeatTime: number;
  lastGain: number;
  bufNode: AudioBufferSourceNode | null; // file 源
  bufDur: number;
  analyser: AnalyserNode | null; // file 源的实时能量（光环脉动）
  trackId: number;
  html: HTMLAudioElement | null; // 无 CORS 链接的降级播放（纯音量，无滤波）
  panner: PannerNode; // HRTF 声像（方向感）
}

export interface MixInfo {
  key: string;
  clarity: number; // 0~1
  gain: number;
}

/** 一帧音乐特征（features() 的返回）：分频段包络 + 节拍脉冲，全部 0~1 */
export interface MusicFeatureFrame {
  level: number; // 总能量（慢包络）
  bass: number; // 低频（鼓点/贝斯）
  mid: number; // 中频（旋律/人声）
  treble: number; // 高频（碎拍/镲片）
  beat: number; // 节拍脉冲（检测到踩点时跳起，指数衰减）
}

interface FeatureState {
  level: number;
  bass: number;
  mid: number;
  treble: number;
  beat: number;
  bassAvg: number;
  lastBeat: number;
}

export class MusicEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sources = new Map<string, Source>();
  private feat = new Map<string, FeatureState>(); // features() 的每源状态
  private ownKey = "self";
  ownTrackId = -1;
  /** 自己当前链接曲目的 URL（暂停恢复时带上） */
  ownUrl = "";
  /** 引擎提示（降级/失败等，接 UI toast） */
  onNotice: ((msg: string) => void) | null = null;
  private bufCache = new Map<string, Promise<AudioBuffer>>();
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private ownStartWall = 0; // 自己当前曲目开始时的墙钟时间
  private ownPaused = false;
  private ownElapsedMs = 0; // 暂停时保存的进度

  /** 自己是否处于暂停态 */
  get isOwnPaused() {
    return this.ownPaused;
  }

  // 环境声
  private windGain!: GainNode;
  private waveGain!: GainNode;
  private fireGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  // 飞行风声（光遇式：随空速涨落的宽频风 + 高频气流层 + 布料扑簌）
  private flightLowG!: GainNode; // 风声主体（低频体腔）
  private flightHighG!: GainNode; // 高频气流（速度越快越亮）
  private flightHighF!: BiquadFilterNode; // 气流滤波（中心频率随空速/俯冲开高）
  private flightLevel = 0; // 平滑后的飞行强度
  private nextFlutter = 0; // 下一次布料扑簌的时刻

  /** 必须在用户手势里调用（浏览器自动播放策略）。
   *  不阻塞等待 resume——即使音频暂时被策略挂起，入场流程也能继续，
   *  tick() 会在 context 真正 running 后自动开始调度。 */
  async unlock() {
    if (this.ctx) {
      this.ctx.resume().catch(() => {});
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    ctx.resume().catch(() => {});
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    // 白噪声底料（环境声与动作音效共用）
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;

    const mkNoise = (filterType: BiquadFilterType, freq: number, q: number) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      return g;
    };

    this.windGain = mkNoise("bandpass", 480, 0.6);
    this.waveGain = mkNoise("lowpass", 360, 0.8);
    this.fireGain = mkNoise("highpass", 2800, 0.5);

    // 飞行风声：两层共用一条噪声源——
    // 低频层是风的「体腔」（lowpass，随空速增强），
    // 高频层是擦过耳边的「气流」（bandpass，中心频率随空速与俯冲速度开高）
    const mkFlight = (filterType: BiquadFilterType, freq: number, q: number) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      return { f, g };
    };
    const low = mkFlight("lowpass", 380, 0.7);
    const high = mkFlight("bandpass", 1100, 0.9);
    this.flightLowG = low.g;
    this.flightHighG = high.g;
    this.flightHighF = high.f;
  }

  // ---------- 曲源管理 ----------

  private makeSource(trackId: number, songName: string, startedAtLocalMs: number, remote: boolean, url = ""): Source {
    const ctx = this.ctx!;
    const bus = ctx.createGain();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // HRTF 声像：每个曲源一个 3D 声像节点——声音在左边就左耳响、
    // 走到脑后就闷过去（距离衰减仍由 gain 管，panner 只管方向）
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "linear";
    panner.refDistance = 1;
    panner.maxDistance = 1e6;
    panner.rolloffFactor = 0; // 距离衰减交给清晰度系统
    let filter: BiquadFilterNode | null = null;
    let analyser: AnalyserNode | null = null;
    if (remote) {
      filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 400;
      bus.connect(filter).connect(gain).connect(panner).connect(this.master);
    } else {
      bus.connect(gain).connect(panner).connect(this.master);
    }

    const custom = isCustomTrack(trackId);
    const urlTrack = isUrlTrack(trackId) && /^https?:\/\//.test(url);
    const def = !custom && !urlTrack ? trackById(trackId) ?? null : null;
    if (custom || urlTrack) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512; // 512 才能把鼓点段(0-180Hz)和旋律(220Hz+)分开——256 时一个 bin 187Hz，旋律会灌进低频段把节拍检测淹死
      bus.connect(analyser);
    }

    // 与服务器时间戳对齐：反推 beat 0 的 ctx 时间
    const beatSec = def ? 60 / def.bpm : 0.5;
    const elapsedMs = Date.now() - startedAtLocalMs;
    const startCtx = ctx.currentTime - Math.max(0, elapsedMs) / 1000;
    const nextBeat = def ? Math.max(0, Math.ceil((ctx.currentTime - startCtx) / beatSec)) : 0;

    const src: Source = {
      kind: urlTrack ? "url" : custom ? "file" : "gen",
      def,
      songId: custom ? songIdOf(trackId) : -1,
      songName,
      url: urlTrack ? url : "",
      bus,
      filter,
      gain,
      panner,
      startCtx,
      nextBeat,
      nextBeatTime: startCtx + nextBeat * beatSec,
      lastGain: 0,
      bufNode: null,
      bufDur: 0,
      analyser,
      trackId,
      html: null,
    };

    if (urlTrack) {
      this.attachUrlBuffer(src, url, Math.max(0, elapsedMs) / 1000, remote);
    } else if (custom) {
      this.attachFileBuffer(src, Math.max(0, elapsedMs) / 1000);
    }
    return src;
  }

  /** 链接曲目：先尝试 fetch+decode（链接带 CORS → 完整渐强管线）；
   *  失败则降级为 <audio> 纯音量播放（无滤波渐清晰，靠近只变大声） */
  private attachUrlBuffer(src: Source, url: string, elapsedSec: number, remote: boolean) {
    const key = "u:" + url;
    if (!this.bufCache.has(key)) {
      this.bufCache.set(
        key,
        (async () => {
          const res = await fetch(url, { mode: "cors" });
          if (!res.ok) throw new Error(`链接拉取失败 ${res.status}`);
          const data = await res.arrayBuffer();
          return await this.ctx!.decodeAudioData(data);
        })()
      );
    }
    this.bufCache
      .get(key)!
      .then((buf) => {
        if (!this.sources.has(this.ownKey) && ![...this.sources.values()].includes(src)) return;
        if (src.url !== url) return;
        if (buf.duration > 15 * 60) {
          this.onNotice?.("链接的曲子太长了（超过 15 分钟），换一首吧");
          this.stopSource(src);
          return;
        }
        const ctx = this.ctx!;
        src.bufDur = buf.duration;
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.loop = true;
        node.connect(src.bus);
        node.start(ctx.currentTime, elapsedSec % buf.duration);
        src.bufNode = node;
      })
      .catch(() => {
        // CORS 拒绝或解码失败 → 降级
        if (src.url !== url) return;
        this.startDegraded(src, url, elapsedSec, remote);
      });
  }

  /** 无 CORS 链接的降级播放：普通 <audio> 元素，只有音量可控 */
  private startDegraded(src: Source, url: string, elapsedSec: number, remote: boolean) {
    if (src.url !== url || src.html) return;
    const el = new Audio(url);
    el.loop = true;
    el.preload = "auto";
    el.volume = 0;
    el.addEventListener(
      "loadedmetadata",
      () => {
        if (Number.isFinite(el.duration) && el.duration > 0) el.currentTime = elapsedSec % el.duration;
      },
      { once: true }
    );
    el.play().catch(() => {
      // 自动播放策略或链接失效
      if (src.url === url) this.onNotice?.("这个链接播不出来，换一个试试");
    });
    src.html = el;
    if (!remote) el.volume = 0.62;
    if (!this.degradedNotified) {
      this.degradedNotified = true;
      this.onNotice?.("该链接不支持渐清晰滤波，以基础模式播放（靠近只变大声）");
    }
  }

  private degradedNotified = false;

  /** 拉取歌曲文件并循环播放（进度与大家保持一致） */
  private attachFileBuffer(src: Source, elapsedSec: number) {
    const songId = src.songId;
    const key = "f:" + songId;
    if (!this.bufCache.has(key)) {
      this.bufCache.set(
        key,
        (async () => {
          const res = await fetch(`/songs/file/${songId}`);
          if (!res.ok) throw new Error(`歌曲 ${songId} 拉取失败`);
          const data = await res.arrayBuffer();
          return await this.ctx!.decodeAudioData(data);
        })()
      );
    }
    this.bufCache
      .get(key)!
      .then((buf) => {
        // 异步加载完成时，这条源可能已经被换掉/移除
        if (this.sources.get(this.ownKey) !== src && ![...this.sources.values()].includes(src)) return;
        if (src.trackId !== CUSTOM_BASE + songId && src.songId !== songId) return;
        // 超长音频解码后可能占用数百 MB 内存，直接拒播保护听者
        if (buf.duration > 15 * 60) {
          console.warn("[music] 曲目过长，跳过播放", songId);
          return;
        }
        const ctx = this.ctx!;
        src.bufDur = buf.duration;
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.loop = true;
        node.connect(src.bus);
        node.start(ctx.currentTime, elapsedSec % buf.duration);
        src.bufNode = node;
      })
      .catch((e) => console.warn("[music] 无法播放自定义曲目", e));
  }

  /** 某个源的歌曲时长（秒）：文件/链接=真实时长，合成曲=32 小节；未知=0。
   *  供「歌之相遇册」的听完判定用 */
  songDurOf(key: string): number {
    const src = this.sources.get(key);
    if (!src) return 0;
    if (src.bufDur > 0) return src.bufDur;
    if (src.def) return (32 * src.def.beatsPerBar * 60) / src.def.bpm;
    return 0;
  }

  /** 某个源当前的歌标识（换歌后变化），相遇册用来区分「同一首」 */
  trackKeyOf(key: string): string {
    const src = this.sources.get(key);
    return src ? `${src.trackId}|${src.songName}|${src.url}` : "";
  }

  // ---------- 空间声像：声音在哪边，哪只耳朵响 ----------

  /** 每帧写入某个曲源的世界位置（HRTF 声像跟随） */
  setSourcePos(key: string, x: number, y: number, z: number) {
    const src = this.sources.get(key);
    if (!src) return;
    const p = src.panner.positionX;
    if (p) {
      src.panner.positionX.value = x;
      src.panner.positionY.value = y;
      src.panner.positionZ.value = z;
    } else {
      src.panner.setPosition(x, y, z); // 旧版 Safari
    }
  }

  /** 每帧写入监听者（= 相机）的位置与朝向，HRTF 以此计算双耳差 */
  setListener(cam: { position: THREE.Vector3; matrixWorld: THREE.Matrix4 }) {
    const l = this.ctx!.listener;
    const fwd = _fwd.set(0, 0, -1).transformDirection(cam.matrixWorld);
    const up = _up.set(0, 1, 0).transformDirection(cam.matrixWorld);
    if (l.positionX) {
      l.positionX.value = cam.position.x;
      l.positionY.value = cam.position.y;
      l.positionZ.value = cam.position.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = fwd.y;
      l.forwardZ.value = fwd.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(cam.position.x, cam.position.y, cam.position.z);
      (l as unknown as { setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void })
        .setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /** 自己换歌（立即从当前时刻开始）；自定义曲目传编号与名字，链接曲目传 URL_TRACK 与直链 */
  setOwnTrack(trackId: number, songName = "", url = "") {    this.ownTrackId = trackId;
    this.ownUrl = isUrlTrack(trackId) ? url : "";
    this.ownPaused = false;
    this.ownElapsedMs = 0;
    this.ownStartWall = Date.now();
    const existing = this.sources.get(this.ownKey);
    if (existing) this.stopSource(existing);
    this.sources.delete(this.ownKey);
    this.feat.delete(this.ownKey);
    if (trackId < 0 || !this.ctx) return;
    const src = this.makeSource(trackId, songName, Date.now(), false, url);
    src.gain.gain.value = 0.62;
    this.sources.set(this.ownKey, src);
  }

  /** 暂停自己的音乐（保留进度），返回已播放的毫秒数 */
  pauseOwn(): number {
    if (this.ownTrackId < 0 || this.ownPaused) return this.ownElapsedMs;
    this.ownElapsedMs = Math.max(0, Date.now() - this.ownStartWall);
    this.ownPaused = true;
    const src = this.sources.get(this.ownKey);
    if (src) this.stopSource(src);
    this.sources.delete(this.ownKey);
    this.feat.delete(this.ownKey);
    return this.ownElapsedMs;
  }

  /** 从暂停处继续，返回恢复用的进度毫秒数（未暂停/没歌返回 -1） */
  resumeOwn(songName = ""): number {
    if (this.ownTrackId < 0 || !this.ownPaused || !this.ctx) return -1;
    this.ownPaused = false;
    const startedAt = Date.now() - this.ownElapsedMs;
    this.ownStartWall = startedAt;
    const src = this.makeSource(this.ownTrackId, songName, startedAt, false, this.ownUrl);
    src.gain.gain.value = 0.62;
    this.sources.set(this.ownKey, src);
    return this.ownElapsedMs;
  }

  /** 同步/更新一首都端听到的歌 */
  syncRemote(key: string, trackId: number, startedAtServerMs: number, clockOffset: number, songName = "", url = "") {
    if (trackId < 0) {
      this.removeRemote(key);
      return;
    }
    const existing = this.sources.get(key);
    const startedLocal = startedAtServerMs - clockOffset;
    if (existing && existing.trackId === trackId && existing.url === url) {
      // 已在播：校对相位（漂移超过阈值才重排，避免抖动）
      const elapsedSec = Math.max(0, (Date.now() - startedLocal) / 1000);
      if (existing.kind === "gen" && existing.def) {
        const beatSec = 60 / existing.def.bpm;
        const idealStart = this.ctx!.currentTime - elapsedSec;
        if (Math.abs(idealStart - existing.startCtx) > beatSec * 0.5) {
          existing.startCtx = idealStart;
          existing.nextBeat = Math.ceil((this.ctx!.currentTime - idealStart) / beatSec);
          existing.nextBeatTime = idealStart + existing.nextBeat * beatSec;
        }
      } else if (existing.kind === "file" && existing.bufNode && existing.bufDur > 0) {
        // 文件源：比较理论播放位置与节点实际位置
        const idealOffset = elapsedSec % existing.bufDur;
        const drift = Math.abs(idealOffset - existing.bufNode.context.currentTime % existing.bufDur);
        void drift;
      }
      return;
    }
    this.removeRemote(key);
    this.sources.set(key, this.makeSource(trackId, songName, startedLocal, true, url));
  }

  private stopSource(src: Source) {
    src.gain.gain.setTargetAtTime(0, this.ctx!.currentTime, 0.08);
    try {
      src.bufNode?.stop();
    } catch {
      /* 已停止 */
    }
    if (src.html) {
      try {
        src.html.pause();
        src.html.src = "";
      } catch {
        /* 忽略 */
      }
      src.html = null;
    }
    const bus = src.bus;
    setTimeout(() => bus.disconnect(), 400);
  }

  removeRemote(key: string) {
    const src = this.sources.get(key);
    if (!src) return;
    this.stopSource(src);
    this.sources.delete(key);
    this.feat.delete(key);
  }

  // ---------- 生成式调度 ----------

  private note(src: Source, midi: number, when: number, dur: number, vol: number, wave: OscillatorType, bell = false) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = midiToFreq(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(src.bus);
    osc.start(when);
    osc.stop(when + dur + 0.05);
    if (bell) {
      // 泛音让铃音更亮
      const o2 = ctx.createOscillator();
      o2.type = "sine";
      o2.frequency.value = midiToFreq(midi + 12);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0, when);
      g2.gain.linearRampToValueAtTime(vol * 0.3, when + 0.01);
      g2.gain.exponentialRampToValueAtTime(0.0001, when + dur * 0.6);
      o2.connect(g2).connect(src.bus);
      o2.start(when);
      o2.stop(when + dur);
    }
  }

  private scheduleBeat(src: Source, beatIdx: number, when: number) {
    const def = src.def;
    if (!def) return;
    const rand = seeded(def.id * 7919 + beatIdx * 104729);
    const bpb = def.beatsPerBar;
    const bar = Math.floor(beatIdx / bpb);
    const beat = beatIdx % bpb;
    const beatSec = 60 / def.bpm;

    if (beat === 0) {
      // 和弦进行：I - vi - IV - V 的五声化版本
      const prog = [0, 3, 1, 2][bar % 4];
      const chordRoot = def.root + def.scale[prog % def.scale.length];
      const dur = beatSec * bpb;
      for (const interval of [0, def.scale[2], def.scale[4] ?? 7]) {
        const midi = chordRoot + interval;
        const ctx = this.ctx!;
        const osc = ctx.createOscillator();
        osc.type = def.padWave;
        osc.frequency.value = midiToFreq(midi);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(0.045, when + dur * 0.25);
        g.gain.linearRampToValueAtTime(0.0001, when + dur);
        osc.connect(g).connect(src.bus);
        osc.start(when);
        osc.stop(when + dur + 0.05);
      }
      // 低音
      this.note(src, chordRoot - 12, when, beatSec * 1.6, 0.1, def.padWave);
    }

    // 旋律
    if (rand() < def.density) {
      const steps = def.scale.length;
      const deg = Math.floor(rand() * steps);
      const oct = rand() < 0.6 ? 0 : 12;
      const midi = def.root + 12 + def.scale[deg] + oct;
      const dur = def.mood === "bell" ? 1.3 : 0.5 + rand() * 0.3;
      const vol = def.wave === "square" ? 0.055 : 0.09;
      this.note(src, midi, when, dur, vol, def.wave, def.mood === "bell");
    }

    // 星光闪现
    if (rand() < def.sparkle) {
      const midi = def.root + 24 + def.scale[Math.floor(rand() * def.scale.length)];
      this.note(src, midi, when + beatSec * 0.5, 1.6, 0.035, "sine", true);
    }
  }

  /** 每帧调用：推进所有曲源的调度器（文件源由 AudioBufferSourceNode 自动播放） */
  tick() {
    if (!this.ctx || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    for (const src of this.sources.values()) {
      if (src.kind !== "gen" || !src.def) continue;
      const beatSec = 60 / src.def.bpm;
      while (src.nextBeatTime < now + 0.18) {
        if (src.nextBeatTime > now - 0.1) {
          this.scheduleBeat(src, src.nextBeat, Math.max(src.nextBeatTime, now + 0.005));
        }
        src.nextBeat++;
        src.nextBeatTime = src.startCtx + src.nextBeat * beatSec;
      }
    }
  }

  // ---------- 距离混音 ----------

  /**
   * @param listeners 每个远处听歌人 { key, trackId, startedAt(服务器ms), dist, songName, songUrl }
   * @returns 每个人的清晰度（供光环与 UI 使用）
   */
  mix(listeners: Array<{ key: string; trackId: number; startedAt: number; dist: number; clockOffset: number; songName?: string; songUrl?: string }>): Map<string, number> {
    if (!this.ctx || this.ctx.state !== "running") return new Map();
    const clarityMap = new Map<string, number>();

    const audible = listeners
      .filter((l) => l.trackId >= 0 && l.dist < AUDIBLE_RADIUS)
      .map((l) => {
        const t = Math.max(0, 1 - l.dist / AUDIBLE_RADIUS);
        const clarity = t * t * (3 - 2 * t); // smoothstep
        return { ...l, clarity };
      })
      .sort((a, b) => b.clarity - a.clarity)
      .slice(0, MAX_MIX);

    const activeKeys = new Set(audible.map((l) => l.key));
    // 不在范围内的曲源淡出
    for (const key of this.sources.keys()) {
      if (key !== this.ownKey && !activeKeys.has(key)) {
        const src = this.sources.get(key)!;
        src.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
        src.filter?.frequency.setTargetAtTime(320, this.ctx.currentTime, 0.3);
        if (src.html) src.html.volume = 0;
        clarityMap.set(key, 0);
      }
    }

    const now = this.ctx.currentTime;
    for (const l of audible) {
      this.syncRemote(l.key, l.trackId, l.startedAt, l.clockOffset, l.songName ?? "", l.songUrl ?? "");
      const src = this.sources.get(l.key);
      if (!src) continue;
      const gain = 0.78 * Math.pow(l.clarity, 1.5);
      const cutoff = 320 + Math.pow(l.clarity, 3) * 14800;
      src.gain.gain.setTargetAtTime(gain, now, 0.18);
      src.filter?.frequency.setTargetAtTime(cutoff, now, 0.2);
      // 降级链接源：<audio> 只能控音量，没有滤波渐清晰
      if (src.html) src.html.volume = Math.min(1, gain);
      clarityMap.set(l.key, l.clarity);
    }
    return clarityMap;
  }

  // ---------- 音乐特征提取（视觉动效的驱动源） ----------

  /** 一帧音乐特征：分频段包络 + 节拍脉冲 */
  features(key: string): MusicFeatureFrame {
    const zero: MusicFeatureFrame = { level: 0, bass: 0, mid: 0, treble: 0, beat: 0 };
    const src = this.sources.get(key);
    if (!src || !this.ctx || this.ctx.state !== "running") return zero;
    const dt = 1 / 60; // 每帧调一次，固定步长对包络足够
    let st = this.feat.get(key);
    if (!st) {
      st = { level: 0, bass: 0, mid: 0, treble: 0, beat: 0, bassAvg: 0, lastBeat: -9 };
      this.feat.set(key, st);
    }

    let bassRaw = 0;
    let midRaw = 0;
    let trebleRaw = 0;
    let levelRaw = 0;
    if ((src.kind === "file" || src.kind === "url") && src.analyser && !src.html) {
      if (!this.freqData || this.freqData.length !== src.analyser.frequencyBinCount) {
        this.freqData = new Uint8Array(src.analyser.frequencyBinCount);
      }
      src.analyser.getByteFrequencyData(this.freqData);
      const n = this.freqData.length; // fftSize 512 → 256 bin；48kHz 时每 bin ≈ 94Hz
      const hzPerBin = this.ctx.sampleRate / 2 / n;
      const bassEnd = Math.max(1, Math.round(180 / hzPerBin)); // 0-180Hz：底鼓/贝斯（旋律 220Hz+ 不许进）
      const midEnd = Math.round(5500 / hzPerBin); // ~180Hz-5.5kHz：旋律/人声
      let b = 0;
      let m = 0;
      let tr = 0;
      let all = 0;
      for (let i = 0; i < n; i++) {
        const v = this.freqData[i] / 255;
        all += v;
        if (i < bassEnd) b += v;
        else if (i < midEnd) m += v;
        else tr += v;
      }
      bassRaw = b / bassEnd;
      midRaw = m / (midEnd - bassEnd);
      trebleRaw = tr / Math.max(1, n - midEnd);
      levelRaw = all / n;
    } else if (src.def || src.html) {
      // 无频谱（生成式曲目/降级链接）：用节拍相位合成同一套包络，
      // 视觉上仍是「低频踩点、高频碎闪」而不是单一抖动
      const beatSec = src.def ? 60 / src.def.bpm : 0.73;
      const phase = ((this.ctx.currentTime - src.startCtx) / beatSec) % 1;
      const pulse = Math.pow(1 - phase, 2.2);
      bassRaw = pulse;
      midRaw = pulse * 0.5 + 0.1;
      trebleRaw = pulse * pulse * 0.75;
      levelRaw = pulse * 0.55 + 0.18;
    } else return zero;

    // 快起慢落包络：敲下去立刻跟上，松开后缓缓退潮
    const env = (cur: number, raw: number, up: number, down: number) => cur + (raw - cur) * Math.min(1, (raw > cur ? up : down) * dt);
    st.bass = env(st.bass, bassRaw, 18, 7);
    st.mid = env(st.mid, midRaw, 14, 6);
    st.treble = env(st.treble, trebleRaw, 22, 9);
    st.level = env(st.level, levelRaw, 12, 4);

    // 自适应节拍检测：低频瞬时能量显著高于其长时均值 → 一次踩点
    st.bassAvg += (bassRaw - st.bassAvg) * Math.min(1, dt * 0.7);
    const now = this.ctx.currentTime;
    st.beat *= Math.exp(-dt * 7);
    if (bassRaw > st.bassAvg * 1.38 + 0.05 && bassRaw > 0.055 && now - st.lastBeat > 0.22) {
      st.lastBeat = now;
      st.beat = Math.min(1, 0.55 + (bassRaw - st.bassAvg) * 2.2);
    }
    return { level: st.level, bass: st.bass, mid: st.mid, treble: st.treble, beat: st.beat };
  }

  /** 光环节拍包络（0~1，每拍衰减）；文件/链接源用实时频谱能量 */
  beatEnv(key: string): number {
    const src = this.sources.get(key);
    if (!src || !this.ctx) return 0;
    if ((src.kind === "file" || src.kind === "url") && src.analyser && !src.html) {
      if (!this.freqData || this.freqData.length !== src.analyser.frequencyBinCount) {
        this.freqData = new Uint8Array(src.analyser.frequencyBinCount);
      }
      src.analyser.getByteFrequencyData(this.freqData);
      let sum = 0;
      for (let i = 0; i < this.freqData.length; i++) sum += this.freqData[i];
      return Math.min(1, sum / this.freqData.length / 96);
    }
    if (src.kind === "url" && src.html) {
      // 降级链接：没有频谱可看，用时间相位模拟节拍脉动
      const phase = ((this.ctx.currentTime - src.startCtx) / 0.73) % 1;
      return Math.pow(1 - phase, 2.2);
    }
    if (!src.def) return 0;
    const beatSec = 60 / src.def.bpm;
    const phase = ((this.ctx.currentTime - src.startCtx) / beatSec) % 1;
    return Math.pow(1 - phase, 2.2);
  }

  /** 环境声：风、浪、篝火，以及随飞行状态变化的气流层。
   *  普通跳跃只保留很轻的空气位移，展开披风后才出现持续宽频风声。 */
  ambient(t: number, playerR: number, fireDist: number, speedH = 0, airborne = false, vy = 0, gliding = false) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const shore = smoothstep(30, 52, playerR); // 越靠近岸浪声越大
    this.waveGain.gain.value = (0.05 + 0.045 * (0.5 + 0.5 * Math.sin(t * 0.4))) * (0.25 + shore);
    this.windGain.gain.value = 0.028 + 0.014 * Math.sin(t * 0.23) + shore * 0.01;
    const fireProx = Math.max(0, 1 - fireDist / 13);
    this.fireGain.gain.value = fireProx * (0.014 + Math.random() * 0.012);

    // ---- 飞行风声 ----
    // 强度 = 空速 + 俯冲分量：起跳离地时缓缓升起，落地时收掉
    const w = Math.min(1, speedH / 9);
    const dive = airborne ? Math.max(0, Math.min(1, -vy / 10)) : 0; // 俯冲 0~1
    const target = airborne ? Math.min(1, (gliding ? 0.3 : 0.07) + w * (gliding ? 0.58 : 0.12) + dive * 0.4) : 0;
    // 手动平滑（起风 ~0.5s，收风 ~0.35s）
    this.flightLevel += (target - this.flightLevel) * (target > this.flightLevel ? 0.05 : 0.07);
    if (this.flightLevel < 0.003) {
      this.flightLevel = 0;
      this.flightLowG.gain.value = 0;
      this.flightHighG.gain.value = 0;
    } else {
      // 阵风起伏：三个不同频率的正弦叠加，像一阵一阵的风
      const gust = 0.72 + 0.16 * Math.sin(t * 1.9) + 0.08 * Math.sin(t * 3.7 + 1.3) + 0.04 * Math.sin(t * 7.3);
      const lv = this.flightLevel * gust;
      this.flightLowG.gain.value = 0.16 * lv;
      // 气流层：速度越快、俯冲越猛，频段越亮、越响
      this.flightHighF.frequency.value = 900 + w * 1500 + dive * 1200;
      this.flightHighG.gain.value = (0.05 + 0.11 * w + 0.1 * dive) * gust * this.flightLevel;
      // 布料扑簌：高速滑翔时披风边角被风撕出的间歇轻响
      if (gliding && w > 0.35 && t > this.nextFlutter) {
        this.noiseHit({
          freq0: 1600 + Math.random() * 1800,
          freq1: 700 + Math.random() * 500,
          dur: 0.05 + Math.random() * 0.09,
          vol: 0.02 + Math.random() * 0.028 * w,
          type: "bandpass",
          q: 1.4,
        });
        this.nextFlutter = t + 0.35 + Math.random() * 0.85;
      }
    }
  }

  // ---------- 动作音效（合成，零素材） ----------

  private noiseHit(opts: { freq0: number; freq1: number; dur: number; vol: number; type: BiquadFilterType; q?: number; delay?: number }) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const when = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.Q.value = opts.q ?? 1;
    f.frequency.setValueAtTime(opts.freq0, when);
    f.frequency.exponentialRampToValueAtTime(opts.freq1, when + opts.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(opts.vol, when + opts.dur * 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, when + opts.dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(when);
    src.stop(when + opts.dur + 0.05);
  }

  private tone(freq: number, dur: number, vol: number, type: OscillatorType = "sine", delay = 0) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const when = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(this.master);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  private sweepTone(freq0: number, freq1: number, dur: number, vol: number, type: OscillatorType = "sine", delay = 0) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const when = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq0, when);
    osc.frequency.exponentialRampToValueAtTime(freq1, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + Math.min(0.035, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(this.master);
    osc.start(when);
    osc.stop(when + dur + 0.04);
  }

  /** 起跳：脚下短促推风与轻微上行泛音，避免像沉重撞击。 */
  sfxJump() {
    this.noiseHit({ freq0: 420, freq1: 1500, dur: 0.2, vol: 0.055, type: "bandpass", q: 0.75 });
    this.sweepTone(230, 410, 0.24, 0.026, "sine", 0.01);
  }

  /** 披风展开：由窄到宽的织物掠风，长按进入滑翔时只触发一次。 */
  sfxGlideOpen() {
    this.noiseHit({ freq0: 2400, freq1: 760, dur: 0.36, vol: 0.075, type: "bandpass", q: 0.65 });
    this.noiseHit({ freq0: 900, freq1: 1800, dur: 0.22, vol: 0.026, type: "highpass", q: 0.8, delay: 0.04 });
    this.sweepTone(330, 495, 0.46, 0.018, "sine", 0.025);
  }

  /** 扑翼：低频推力、宽频披风和短暂泛音组成原创的轻盈升空反馈。 */
  sfxFlap() {
    this.noiseHit({ freq0: 280, freq1: 120, dur: 0.18, vol: 0.12, type: "lowpass", q: 0.8 });
    this.noiseHit({ freq0: 1700, freq1: 480, dur: 0.3, vol: 0.095, type: "bandpass", q: 0.65, delay: 0.012 });
    this.noiseHit({ freq0: 3000, freq1: 5200, dur: 0.065, vol: 0.032, type: "highpass", q: 1, delay: 0.008 });
    this.sweepTone(185, 370, 0.34, 0.04, "sine", 0.015);
    this.tone(740, 0.58, 0.018, "sine", 0.055);
    this.tone(1110, 0.72, 0.01, "sine", 0.085);
  }

  /** 落地：低沉的噗 + 轻尘 */
  sfxLand() {
    this.tone(90, 0.16, 0.2);
    this.noiseHit({ freq0: 2200, freq1: 500, dur: 0.14, vol: 0.05, type: "lowpass" });
  }

  /** 坐下：布料窸窣 */
  sfxSit() {
    this.noiseHit({ freq0: 2400, freq1: 3600, dur: 0.18, vol: 0.035, type: "highpass" });
  }

  /** 换歌：一次温柔的钟声过门 */
  sfxChime() {
    this.tone(880, 0.9, 0.06);
    this.tone(1320, 1.1, 0.035, "sine", 0.07);
  }
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const AUDIBLE_R = AUDIBLE_RADIUS;
export { TRACKS };
