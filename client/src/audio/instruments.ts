import type { MusicEngine } from "./engine";

/**
 * 手持乐器：竖琴 / 长笛 / 风铃——全合成音色（零素材）。
 * Q W E R T Y U = 自然音阶 do~si，Shift 高八度，Z/X 变调。
 * 别人的琴声按距离衰减；一次弹奏 = 一次事件（服务器只做频率限制）。
 */

export type InstrumentKind = "harp" | "flute" | "bell";

export const INSTRUMENTS: { kind: InstrumentKind; label: string }[] = [
  { kind: "harp", label: "竖琴" },
  { kind: "flute", label: "长笛" },
  { kind: "bell", label: "风铃" },
];

const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Instruments {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;

  /** 必须在用户手势解锁后调用；接音乐引擎的上下文 */
  init(engine: MusicEngine) {
    if (this.ctx || !engine.ctx) return;
    this.ctx = engine.ctx;
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 0.5;
    this.bus.connect(this.ctx.destination);
  }

  /** 弹一个音。vol 0~1（远端按距离衰减后传入）；pan -1~1（-1=声源在正左→左耳，空间声像） */
  play(kind: InstrumentKind, midi: number, vol = 1, pan = 0) {
    if (!this.ctx || !this.bus || vol <= 0.01) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const f = midiToFreq(midi);
    const g = ctx.createGain();
    // 空间声像：声源不在正前方时，音符经立体声定位器再进总线（左声偏左耳）
    if (pan < -0.01 || pan > 0.01) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p).connect(this.bus);
    } else {
      g.connect(this.bus);
    }

    if (kind === "harp") {
      // 拨弦：双失谐三角波 + 快速指数衰减
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 2400;
      lp.connect(g);
      for (const detune of [-4, 3]) {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = f;
        o.detune.value = detune;
        o.connect(lp);
        o.start(now);
        o.stop(now + 1.4);
      }
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.32 * vol, now + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);
    } else if (kind === "flute") {
      // 吹管：正弦 + 颤音，软起音
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.2;
      const vibG = ctx.createGain();
      vibG.gain.value = f * 0.006;
      vib.connect(vibG).connect(o.frequency);
      o.connect(g);
      o.start(now);
      vib.start(now);
      o.stop(now + 0.85);
      vib.stop(now + 0.85);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.3 * vol, now + 0.09);
      g.gain.setValueAtTime(0.3 * vol, now + 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.82);
    } else {
      // 风铃：基音 + 2.76 倍非谐分音，亮而空
      const partials: [number, number][] = [
        [1, 0.26],
        [2.76, 0.1],
        [5.4, 0.035],
      ];
      for (const [ratio, amp] of partials) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f * ratio;
        const og = ctx.createGain();
        og.gain.setValueAtTime(0, now);
        og.gain.linearRampToValueAtTime(amp * vol, now + 0.006);
        og.gain.exponentialRampToValueAtTime(0.0001, now + 1.6 / ratio + 0.4);
        o.connect(og).connect(g);
        o.start(now);
        o.stop(now + 2.1);
      }
      g.gain.value = 1;
    }
  }
}
