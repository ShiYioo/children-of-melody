export type VoiceMode = "off" | "starting" | "on" | "blocked";

export interface VoiceSignal {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

interface VoiceCallbacks {
  sendPresence: (active: boolean) => void;
  requestPresence: () => void;
  sendSignal: (to: string, signal: VoiceSignal) => void;
  /** 服务器中继通道：把自己的 16kHz PCM 分片交给服务器转发（24 米内的人都能收到） */
  sendAudio: (pcm: Uint8Array) => void;
  /** 说话人 sessionId → 立体声像 -1~1（说话人在哪声在哪，由主循环按相机方位算） */
  panOf: (id: string) => number;
  onState: (mode: VoiceMode) => void;
  onLocalLevel: (level: number) => void;
  onPeerLevel: (id: string, active: boolean, level: number) => void;
  onError: (message: string) => void;
}

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  stream: MediaStream | null;
  pendingCandidates: RTCIceCandidateInit[];
  signalQueue: Promise<void>;
  disconnectTimer: number | null;
  offerStarted: boolean;
}

const VOICE_RADIUS = 24;
const STUN_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function levelOf(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const sample = (data[i] - 128) / 128;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 3.8);
}

/**
 * 近距离语音：音频走 WebRTC 点对点，Colyseus 只做信令转发。
 * 只有双方都打开语音且距离足够近时才建立连接，离开范围就释放连接。
 */
export class VoiceChat {
  readonly radius = VOICE_RADIUS;
  private readonly callbacks: VoiceCallbacks;
  private sessionId = "";
  private enabled = false;
  private online = false;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private localSource: MediaStreamAudioSourceNode | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localData: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  private peers = new Map<string, Peer>();
  private remotePresence = new Set<string>();
  private nearby = new Map<string, number>();
  private sampleHandle = 0;
  private lastLocalLevel = -1;
  private lastPeerLevels = new Map<string, number>();

  constructor(callbacks: VoiceCallbacks) {
    this.callbacks = callbacks;
    this.sampleHandle = window.requestAnimationFrame(() => this.sample());
  }

  setNetwork(sessionId: string | null) {
    if (this.sessionId && this.sessionId !== sessionId) this.closeAllPeers();
    this.sessionId = sessionId ?? "";
    this.online = !!this.sessionId;
    if (!this.online) {
      this.closeAllPeers();
      this.remotePresence.clear();
      this.nearby.clear();
      return;
    }
    if (this.enabled) {
      this.callbacks.sendPresence(true);
      this.callbacks.requestPresence();
      this.syncPeers();
    }
  }

  async toggle() {
    if (this.enabled) {
      this.disable();
      return;
    }
    await this.enable();
  }

  async enable() {
    if (this.enabled) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      this.callbacks.onState("blocked");
      // 浏览器都支持语音——内网 HTTP 访问（http://192.168.x.x 之类）不是「安全上下文」，
      // 浏览器会把麦克风 API 整个藏起来。给出可操作的解法而不是误诊「不支持」
      const reason = !window.isSecureContext
        ? `内网 HTTP 无法使用麦克风（${location.origin} 非安全环境）。每台设备一次性设置：地址栏输入 chrome://flags 搜「unsafely-treat-insecure-origin-as-secure」，填入 ${location.origin} 并重启浏览器；正式环境请用 HTTPS 域名访问`
        : "当前浏览器不支持语音通话";
      this.callbacks.onError(reason);
      return;
    }

    this.enabled = true;
    this.callbacks.onState("starting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      this.audioContext = new AudioContext();
      await this.audioContext.resume();
      this.localSource = this.audioContext.createMediaStreamSource(this.stream);
      this.localAnalyser = this.audioContext.createAnalyser();
      this.localAnalyser.fftSize = 256;
      this.localData = new Uint8Array(new ArrayBuffer(this.localAnalyser.fftSize));
      // 只接分析器，不接 destination，避免把自己的麦克风回放到耳机里。
      this.localSource.connect(this.localAnalyser);
      // 中继采集：开麦即通过服务器转发——P2P（WebRTC 直连）在内网常被 VPN TUN/
      // 防火墙/mDNS 问题打死，而游戏 WebSocket 本来就通着，走它就一定有声音。
      // P2P 若连上，接收端会自动忽略中继分片（防双声）
      this.startRelayCapture();
      this.callbacks.onState("on");
      if (this.online) {
        this.callbacks.sendPresence(true);
        this.callbacks.requestPresence();
        this.syncPeers();
      }
      // 诊断：开麦 10 秒后附近没有任何人开麦——说明不是连接问题而是没人说话。
      // （音频有服务器中继兜底，P2P 连不上不再算故障）
      window.setTimeout(() => {
        if (!this.enabled) return;
        if (this.remotePresence.size > 0) return;
        this.callbacks.onError("麦克风已开。附近还没有其他人开麦——对方点一下麦克风按钮，24 米内不开麦也能听见你");
      }, 10000);
    } catch (error) {
      this.enabled = false;
      this.stopLocalAudio();
      this.callbacks.onState("blocked");
      const reason = error instanceof DOMException && error.name === "NotAllowedError" ? "麦克风权限被拒绝了" : "麦克风暂时不可用";
      this.callbacks.onError(reason);
    }
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.online) this.callbacks.sendPresence(false);
    this.closeAllPeers();
    this.stopLocalAudio();
    this.callbacks.onLocalLevel(0);
    this.callbacks.onState("off");
  }

  handlePresence(id: string, active: boolean) {
    if (!id || id === this.sessionId) return;
    if (active) {
      this.remotePresence.add(id);
      this.callbacks.onPeerLevel(id, true, this.lastPeerLevels.get(id) ?? 0);
    } else {
      this.remotePresence.delete(id);
      this.closePeer(id);
      this.callbacks.onPeerLevel(id, false, 0);
    }
    this.syncPeers();
  }

  handleSignal(from: string, signal: VoiceSignal) {
    if (!this.enabled || !from || from === this.sessionId || !signal) return;
    const peer = this.getOrCreatePeer(from);
    peer.signalQueue = peer.signalQueue
      .then(() => this.applySignal(peer, signal))
      .catch(() => this.closePeer(from));
  }

  /** 每帧由主循环提供附近玩家距离，语音连接只保留在这个范围内。 */
  updateNearby(players: Array<{ id: string; distance: number }>) {
    const next = new Map<string, number>();
    for (const p of players) {
      if (p.id && p.distance < VOICE_RADIUS) next.set(p.id, p.distance);
    }
    let changed = next.size !== this.nearby.size;
    if (!changed) {
      for (const [id, distance] of next) {
        const previous = this.nearby.get(id);
        if (previous === undefined || Math.abs(previous - distance) > 0.5) {
          changed = true;
          break;
        }
      }
    }
    this.nearby = next;
    if (changed) this.syncPeers();
    for (const [id, distance] of this.nearby) {
      const peer = this.peers.get(id);
      if (peer?.gain) {
        const clarity = Math.max(0, 1 - distance / VOICE_RADIUS);
        peer.gain.gain.setTargetAtTime(0.12 + clarity * 0.7, this.audioContext?.currentTime ?? 0, 0.12);
      }
    }
  }

  closeRemote(id: string) {
    this.remotePresence.delete(id);
    this.nearby.delete(id);
    this.closePeer(id);
    this.callbacks.onPeerLevel(id, false, 0);
  }

  dispose() {
    this.disable();
    window.cancelAnimationFrame(this.sampleHandle);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
  }

  // ============ 服务器中继语音（保底通道：游戏 WebSocket 本来就通，走它必有声） ============

  private relayNode: AudioWorkletNode | null = null;
  /** 每个说话者的中继播放时间轴（抖动缓冲：按序排队，断流自动追赶） */
  private relayNextAt = new Map<string, number>();
  /** 中继说话者的最后活跃时刻（供 sample() 收拾 UI 电平） */
  private relayLastAt = new Map<string, number>();
  /** 免开麦的独立播放上下文：不随麦克风关闭而关闭（不开麦也要能听见） */
  private _playCtx: AudioContext | null = null;

  private playCtx(): AudioContext | null {
    if (!this._playCtx) {
      try {
        this._playCtx = new AudioContext();
      } catch {
        return null;
      }
    }
    // 进过游戏（点过按钮）就有 sticky activation，resume 能成功
    if (this._playCtx.state === "suspended") void this._playCtx.resume();
    return this._playCtx;
  }

  /** 开麦即启动中继采集：AudioWorklet 内重采样到 16kHz、打包 80ms 的 Int16 分片 */
  private startRelayCapture() {
    if (!this.audioContext || this.relayNode) return;
    const code = `
class RelayProc extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.f = 0;
    this.acc = new Float32Array(1280);
    this.count = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    while (this.f < ch.length) {
      const i = this.f | 0;
      const t = this.f - i;
      const nx = Math.min(i + 1, ch.length - 1);
      this.acc[this.count++] = ch[i] + (ch[nx] - ch[i]) * t;
      this.f += this.ratio;
      if (this.count >= 1280) {
        const out = new Int16Array(1280);
        for (let j = 0; j < 1280; j++) {
          const v = Math.max(-1, Math.min(1, this.acc[j]));
          out[j] = v < 0 ? v * 32768 : v * 32767;
        }
        this.postMessage(out.buffer, [out.buffer]);
        this.count = 0;
      }
    }
    this.f -= ch.length;
    return true;
  }
}
registerProcessor("relay-proc", RelayProc);`;
    const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    this.audioContext
      .audioWorklet.addModule(url)
      .then(() => {
        if (!this.audioContext || !this.stream || !this.localSource) return;
        const node = new AudioWorkletNode(this.audioContext, "relay-proc");
        node.port.onmessage = (e) => {
          const buf = e.data as ArrayBuffer;
          if (this.enabled && this.online && buf.byteLength === 2560) {
            this.callbacks.sendAudio(new Uint8Array(buf));
          }
        };
        // 本地麦克风分两路：分析器（UI 电平）+ 中继采集（worklet 不接目的地，无回声）
        this.localSource.connect(node);
        this.relayNode = node;
      })
      .catch(() => {
        /* 中继采集失败：还有 P2P 路径 */
      });
  }

  /** 收到中继语音：不开麦也能听（懒建播放上下文）；P2P 已通的说话者跳过防双声 */
  handleVoiceAudio(from: string, pcm: Uint8Array) {
    if (!from || from === this.sessionId) return;
    const peer = this.peers.get(from);
    if (peer?.pc.connectionState === "connected") return;
    if (pcm.length < 320) return;
    const ctx = this.playCtx();
    if (!ctx) return;
    const samples = pcm.length >> 1;
    const buf = ctx.createBuffer(1, samples, 16000);
    const ch = buf.getChannelData(0);
    const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let sum = 0;
    for (let i = 0; i < samples; i++) {
      const v = dv.getInt16(i * 2, true) / 32768;
      ch[i] = v;
      sum += v * v;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    // 空间声像：说话人在左边就左耳响（pan 由 main 按说话人位置 vs 相机实时算好传入）
    const pan = this.callbacks.panOf ? this.callbacks.panOf(from) : 0;
    if (Math.abs(pan) > 0.01) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(gain).connect(p).connect(ctx.destination);
    } else {
      src.connect(gain).connect(ctx.destination);
    }
    // 抖动缓冲：顺序排队播放；积压超过 0.4s（断流后的陈旧分片）直接追平到现在
    let next = this.relayNextAt.get(from) ?? 0;
    if (next - ctx.currentTime > 0.4) next = 0;
    const startAt = Math.max(next, ctx.currentTime + 0.05);
    src.start(startAt);
    this.relayNextAt.set(from, startAt + buf.duration);
    this.relayLastAt.set(from, performance.now());
    // 说话电平供 UI 声浪
    this.callbacks.onPeerLevel(from, true, Math.min(1, Math.sqrt(sum / samples) * 4));
  }

  /** ICE 失败后的自愈重试（去抖：1.2s 内只排一次） */
  private retryTimer: number | null = null;
  private retrySoon() {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.enabled && this.online) this.syncPeers();
    }, 1200);
  }

  private syncPeers() {
    if (!this.enabled || !this.online) return;
    for (const id of this.remotePresence) {
      if (!this.nearby.has(id)) {
        this.closePeer(id);
        continue;
      }
      // 只让 sessionId 字典序更小的一方发起 offer，避免双方同时发 offer。
      if (this.sessionId < id) this.startOffer(id);
    }
    for (const [id] of this.peers) {
      if (!this.remotePresence.has(id) || !this.nearby.has(id)) this.closePeer(id);
    }
  }

  private getOrCreatePeer(id: string): Peer {
    const existing = this.peers.get(id);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    const peer: Peer = {
      id,
      pc,
      analyser: null,
      source: null,
      gain: null,
      stream: null,
      pendingCandidates: [],
      signalQueue: Promise.resolve(),
      disconnectTimer: null,
      offerStarted: false,
    };
    this.peers.set(id, peer);

    this.stream?.getTracks().forEach((track) => pc.addTrack(track, this.stream!));
    pc.onicecandidate = (event) => {
      if (event.candidate) this.callbacks.sendSignal(id, { candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.attachRemoteAudio(peer, stream);
    };
    pc.onconnectionstatechange = () => {
      console.info(`[voice] 与 ${id.slice(0, 6)} 的通道: ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.closePeer(id, peer);
        // ICE 失败自愈：syncPeers 是事件驱动的，失败后没人再触发就永远哑着——
        // 2 秒后自动重试（常见于内网里 VPN/虚拟网卡的候选路由劣化，重试常能换路建连）
        this.retrySoon();
      }
      if (pc.connectionState === "disconnected") {
        if (peer.disconnectTimer !== null) window.clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = window.setTimeout(() => {
          if (pc.connectionState === "disconnected") {
            this.closePeer(id, peer);
            this.retrySoon();
          }
        }, 6000);
      }
    };
    return peer;
  }

  private async startOffer(id: string) {
    const peer = this.getOrCreatePeer(id);
    if (peer.offerStarted || peer.pc.signalingState !== "stable") return;
    peer.offerStarted = true;
    try {
      const offer = await peer.pc.createOffer();
      if (this.peers.get(id) !== peer) return;
      await peer.pc.setLocalDescription(offer);
      if (peer.pc.localDescription) this.callbacks.sendSignal(id, { description: peer.pc.localDescription.toJSON() });
    } catch {
      this.closePeer(id, peer);
    }
  }

  private async applySignal(peer: Peer, signal: VoiceSignal) {
    if (signal.description) {
      await peer.pc.setRemoteDescription(signal.description);
      for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
      if (signal.description.type === "offer") {
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        if (peer.pc.localDescription) this.callbacks.sendSignal(peer.id, { description: peer.pc.localDescription.toJSON() });
      }
    }
    if (signal.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate);
      else peer.pendingCandidates.push(signal.candidate);
    }
  }

  private attachRemoteAudio(peer: Peer, stream: MediaStream) {
    if (peer.stream === stream && peer.source) return;
    peer.stream = stream;
    if (!this.audioContext) return;
    peer.source?.disconnect();
    peer.analyser?.disconnect();
    peer.gain?.disconnect();
    const source = this.audioContext.createMediaStreamSource(stream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    const gain = this.audioContext.createGain();
    const distance = this.nearby.get(peer.id) ?? VOICE_RADIUS;
    gain.gain.value = 0.12 + Math.max(0, 1 - distance / VOICE_RADIUS) * 0.7;
    source.connect(analyser).connect(gain).connect(this.audioContext.destination);
    peer.source = source;
    peer.analyser = analyser;
    peer.gain = gain;
    this.lastPeerLevels.set(peer.id, 0);
    this.callbacks.onPeerLevel(peer.id, true, 0);
  }

  private closePeer(id: string, expected?: Peer) {
    const peer = this.peers.get(id);
    if (!peer || (expected && peer !== expected)) return;
    this.peers.delete(id);
    if (peer.disconnectTimer !== null) window.clearTimeout(peer.disconnectTimer);
    peer.source?.disconnect();
    peer.analyser?.disconnect();
    peer.gain?.disconnect();
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.close();
    this.lastPeerLevels.delete(id);
    this.callbacks.onPeerLevel(id, false, 0);
  }

  private closeAllPeers() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }

  private stopLocalAudio() {
    this.localSource?.disconnect();
    this.localAnalyser?.disconnect();
    this.relayNode?.disconnect();
    this.relayNode = null;
    this.localSource = null;
    this.localAnalyser = null;
    this.localData = new Uint8Array(new ArrayBuffer(0));
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    // 注意：_playCtx 不关——关麦后仍要能听见别人的中继语音
  }

  private sample() {
    if (this.localAnalyser && this.localData.length > 0) {
      const level = levelOf(this.localAnalyser, this.localData);
      if (Math.abs(level - this.lastLocalLevel) > 0.015) {
        this.lastLocalLevel = level;
        this.callbacks.onLocalLevel(level);
      }
    }
    for (const [id, peer] of this.peers) {
      if (!peer.analyser) continue;
      const data = new Uint8Array(new ArrayBuffer(peer.analyser.fftSize));
      const level = levelOf(peer.analyser, data);
      const previous = this.lastPeerLevels.get(id) ?? -1;
      if (Math.abs(level - previous) > 0.015) {
        this.lastPeerLevels.set(id, level);
        this.callbacks.onPeerLevel(id, true, level);
      }
    }
    // 中继说话者停说 600ms → 收拾 UI 电平
    const now = performance.now();
    for (const [id, at] of this.relayLastAt) {
      if (now - at > 600) {
        this.relayLastAt.delete(id);
        this.relayNextAt.delete(id);
        if (!this.peers.has(id)) this.callbacks.onPeerLevel(id, false, 0);
      }
    }
    this.sampleHandle = window.requestAnimationFrame(() => this.sample());
  }
}
