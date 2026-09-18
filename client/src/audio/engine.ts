import { TRACKS, trackById, midiToFreq, type TrackDef } from "./tracks";

/**
 * 音乐引擎：渐强之岛的心脏。
 *
 * - 每首歌是确定性生成的：由 (trackId, 起始时间) 即可在各端合奏出
 *   完全一致的旋律（音频流不过服务器）。
 * - 距离混音：身边的人各占一条音频总线，
 *   远处 → 低通滤波(朦胧) + 小音量，近处 → 全频段 + 清晰，
 *   最多同时清晰混入最近的 3 首。
 */

const AUDIBLE_RADIUS = 38; // 米：能听见别人音乐的距离
const MAX_MIX = 3; // 最多清晰混入的曲目数

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
  def: TrackDef;
  bus: GainNode; // 音符汇入点
  filter: BiquadFilterNode | null; // 远端专属低通
  gain: GainNode; // 最终音量（距离控制）
  startCtx: number; // beat 0 对应的 ctx 时间
  nextBeat: number;
  nextBeatTime: number;
  lastGain: number;
}

export interface MixInfo {
  key: string;
  clarity: number; // 0~1
  gain: number;
}

export class MusicEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sources = new Map<string, Source>();
  private ownKey = "self";
  ownTrackId = -1;

  // 环境声
  private windGain!: GainNode;
  private waveGain!: GainNode;
  private fireGain!: GainNode;
  private noiseBuf!: AudioBuffer;

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
  }

  // ---------- 曲源管理 ----------

  private makeSource(def: TrackDef, startedAtLocalMs: number, remote: boolean): Source {
    const ctx = this.ctx!;
    const bus = ctx.createGain();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    let filter: BiquadFilterNode | null = null;
    if (remote) {
      filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 400;
      bus.connect(filter).connect(gain).connect(this.master);
    } else {
      bus.connect(gain).connect(this.master);
    }

    // 与服务器时间戳对齐：反推 beat 0 的 ctx 时间
    const beatSec = 60 / def.bpm;
    const elapsedMs = Date.now() - startedAtLocalMs;
    const startCtx = ctx.currentTime - Math.max(0, elapsedMs) / 1000;
    const nextBeat = Math.max(0, Math.ceil((ctx.currentTime - startCtx) / beatSec));

    return {
      def,
      bus,
      filter,
      gain,
      startCtx,
      nextBeat,
      nextBeatTime: startCtx + nextBeat * beatSec,
      lastGain: 0,
    };
  }

  /** 自己换歌（立即从当前时刻开始） */
  setOwnTrack(trackId: number) {
    this.ownTrackId = trackId;
    const def = trackById(trackId);
    this.sources.delete(this.ownKey);
    if (!def || !this.ctx) return;
    const src = this.makeSource(def, Date.now(), false);
    src.gain.gain.value = 0.62;
    this.sources.set(this.ownKey, src);
  }

  /** 同步/更新一首都端听到的歌 */
  syncRemote(key: string, trackId: number, startedAtServerMs: number, clockOffset: number) {
    if (trackId < 0) {
      this.removeRemote(key);
      return;
    }
    const existing = this.sources.get(key);
    const startedLocal = startedAtServerMs - clockOffset;
    if (existing && existing.def.id === trackId) {
      // 已在播：校对相位（偏差超过半拍才重排，避免抖动）
      const beatSec = 60 / existing.def.bpm;
      const idealStart = this.ctx!.currentTime - (Date.now() - startedLocal) / 1000;
      if (Math.abs(idealStart - existing.startCtx) > beatSec * 0.5) {
        existing.startCtx = idealStart;
        existing.nextBeat = Math.ceil((this.ctx!.currentTime - idealStart) / beatSec);
        existing.nextBeatTime = idealStart + existing.nextBeat * beatSec;
      }
      return;
    }
    this.removeRemote(key);
    const def = trackById(trackId);
    if (!def) return;
    this.sources.set(key, this.makeSource(def, startedLocal, true));
  }

  removeRemote(key: string) {
    const src = this.sources.get(key);
    if (!src) return;
    src.gain.gain.setTargetAtTime(0, this.ctx!.currentTime, 0.1);
    const bus = src.bus;
    setTimeout(() => bus.disconnect(), 600);
    this.sources.delete(key);
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

  /** 每帧调用：推进所有曲源的调度器 */
  tick() {
    if (!this.ctx || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    for (const src of this.sources.values()) {
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
   * @param listeners 每个远处听歌人 { key, trackId, startedAt(服务器ms), dist }
   * @returns 每个人的清晰度（供光环与 UI 使用）
   */
  mix(listeners: Array<{ key: string; trackId: number; startedAt: number; dist: number; clockOffset: number }>): Map<string, number> {
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
        clarityMap.set(key, 0);
      }
    }

    const now = this.ctx.currentTime;
    for (const l of audible) {
      this.syncRemote(l.key, l.trackId, l.startedAt, l.clockOffset);
      const src = this.sources.get(l.key);
      if (!src) continue;
      const gain = 0.78 * Math.pow(l.clarity, 1.5);
      const cutoff = 320 + Math.pow(l.clarity, 3) * 14800;
      src.gain.gain.setTargetAtTime(gain, now, 0.18);
      src.filter?.frequency.setTargetAtTime(cutoff, now, 0.2);
      clarityMap.set(l.key, l.clarity);
    }
    return clarityMap;
  }

  /** 光环节拍包络（0~1，每拍衰减） */
  beatEnv(key: string): number {
    const src = this.sources.get(key);
    if (!src || !this.ctx) return 0;
    const beatSec = 60 / src.def.bpm;
    const phase = ((this.ctx.currentTime - src.startCtx) / beatSec) % 1;
    return Math.pow(1 - phase, 2.2);
  }

  /** 环境声：风、浪、篝火；滑翔速度会自然加大风声 */
  ambient(t: number, playerR: number, fireDist: number, glideSpeed = 0) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const shore = smoothstep(30, 52, playerR); // 越靠近岸浪声越大
    this.waveGain.gain.value = (0.05 + 0.045 * (0.5 + 0.5 * Math.sin(t * 0.4))) * (0.25 + shore);
    this.windGain.gain.value = 0.028 + 0.014 * Math.sin(t * 0.23) + shore * 0.01 + Math.min(0.11, glideSpeed * 0.012);
    const fireProx = Math.max(0, 1 - fireDist / 13);
    this.fireGain.gain.value = fireProx * (0.014 + Math.random() * 0.012);
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

  /** 起跳：柔和的向上风声 */
  sfxJump() {
    this.noiseHit({ freq0: 300, freq1: 1400, dur: 0.28, vol: 0.1, type: "bandpass", q: 0.8 });
  }

  /** 扑翼：布料展翅的呼啸（两层） */
  sfxFlap() {
    this.noiseHit({ freq0: 500, freq1: 1600, dur: 0.22, vol: 0.16, type: "bandpass", q: 0.7 });
    this.noiseHit({ freq0: 900, freq1: 420, dur: 0.3, vol: 0.09, type: "bandpass", q: 1.2, delay: 0.05 });
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
