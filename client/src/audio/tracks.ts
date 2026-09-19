/**
 * 曲库：六首「生成式」曲目。
 * 每首歌由确定性的种子算法实时演奏——同样的曲目编号与起始时间，
 * 在任何客户端上都会长出一模一样的旋律，因此无需传输任何音频流，
 * 服务器只要同步 (trackId, startedAt)，各端本地合奏即可完全对齐。
 */
export interface TrackDef {
  id: number;
  name: string;
  desc: string;
  color: string;
  bpm: number;
  beatsPerBar: number;
  root: number; // MIDI 根音
  scale: number[]; // 半音阶型
  wave: OscillatorType; // 主奏音色
  padWave: OscillatorType;
  density: number; // 每拍出旋律的概率
  sparkle: number; // 高音闪现概率
  mood: "pluck" | "bell" | "arp";
}

export const TRACKS: TrackDef[] = [
  {
    id: 0,
    name: "晨岛摇篮曲",
    desc: "温软的琥珀色，像被晒暖的石头",
    color: "#ffb45e",
    bpm: 72,
    beatsPerBar: 4,
    root: 60,
    scale: [0, 2, 4, 7, 9],
    wave: "triangle",
    padWave: "sine",
    density: 0.5,
    sparkle: 0.08,
    mood: "pluck",
  },
  {
    id: 1,
    name: "云海漂流",
    desc: "稀薄的天蓝，飘在很高很高的地方",
    color: "#7ec8ff",
    bpm: 60,
    beatsPerBar: 4,
    root: 62,
    scale: [0, 2, 4, 6, 7, 9, 11],
    wave: "sine",
    padWave: "sine",
    density: 0.34,
    sparkle: 0.16,
    mood: "bell",
  },
  {
    id: 2,
    name: "篝火圆舞曲",
    desc: "珊瑚色的三拍子，围着火转圈吧",
    color: "#ff8f9e",
    bpm: 96,
    beatsPerBar: 3,
    root: 57,
    scale: [0, 3, 5, 7, 10],
    wave: "square",
    padWave: "triangle",
    density: 0.62,
    sparkle: 0.1,
    mood: "pluck",
  },
  {
    id: 3,
    name: "潮汐信笺",
    desc: "青绿色的浪，一封慢慢展开的信",
    color: "#5fd6c8",
    bpm: 84,
    beatsPerBar: 4,
    root: 65,
    scale: [0, 2, 4, 7, 9],
    wave: "sine",
    padWave: "sine",
    density: 0.45,
    sparkle: 0.12,
    mood: "bell",
  },
  {
    id: 4,
    name: "星光慢行",
    desc: "薰衣草色的夜路，走得很慢很慢",
    color: "#b9a0ff",
    bpm: 66,
    beatsPerBar: 4,
    root: 67,
    scale: [0, 2, 4, 7, 9],
    wave: "triangle",
    padWave: "sine",
    density: 0.3,
    sparkle: 0.22,
    mood: "bell",
  },
  {
    id: 5,
    name: "微风花田",
    desc: "薄荷绿的奔跑，风把花粉吹得到处都是",
    color: "#9ee6a8",
    bpm: 90,
    beatsPerBar: 4,
    root: 62,
    scale: [0, 2, 4, 7, 9, 12],
    wave: "triangle",
    padWave: "triangle",
    density: 0.7,
    sparkle: 0.1,
    mood: "arp",
  },
];

export function trackById(id: number): TrackDef | undefined {
  return TRACKS.find((t) => t.id === id);
}

/** 自定义曲目编号从 100 起：trackId - 100 = 服务器上的 songId */
export const CUSTOM_BASE = 100;
export const isCustomTrack = (id: number) => id >= CUSTOM_BASE;
export const songIdOf = (id: number) => id - CUSTOM_BASE;

/** 链接曲目固定编号：具体地址在 songUrl 字段里，服务器只存字符串不中转音频 */
export const URL_TRACK = 200;
export const isUrlTrack = (id: number) => id === URL_TRACK;

/** 从链接里取个短名字（hostname） */
export function urlHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "链接";
  }
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** 任何曲目（生成式/自定义/链接）的显示名与光环颜色 */
export function trackMeta(trackId: number, songName = "", url = ""): { name: string; color: string } {
  const def = trackById(trackId);
  if (def) return { name: def.name, color: def.color };
  if (isUrlTrack(trackId)) {
    const hue = Math.round(hashStr(url || songName) * 360);
    return { name: songName || urlHost(url) || "旅人的链接", color: hslToHex(hue / 360, 0.5, 0.66) };
  }
  if (isCustomTrack(trackId)) {
    const hue = ((songIdOf(trackId) * 47) % 360 + 360) % 360;
    return { name: songName || "旅人的歌", color: hslToHex(hue / 360, 0.5, 0.66) };
  }
  return { name: "", color: "#ffb45e" };
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, "0");
  };
  return "#" + f(0) + f(8) + f(4);
}

/** 音高 → 频率 */
export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}
