export type VoiceMode = "off" | "starting" | "on" | "blocked";

export interface VoiceSignal {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

interface VoiceCallbacks {
  sendPresence: (active: boolean) => void;
  requestPresence: () => void;
  sendSignal: (to: string, signal: VoiceSignal) => void;
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
      this.callbacks.onError("当前浏览器不支持语音通话");
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
      this.callbacks.onState("on");
      if (this.online) {
        this.callbacks.sendPresence(true);
        this.callbacks.requestPresence();
        this.syncPeers();
      }
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
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.closePeer(id, peer);
      if (pc.connectionState === "disconnected") {
        if (peer.disconnectTimer !== null) window.clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = window.setTimeout(() => {
          if (pc.connectionState === "disconnected") this.closePeer(id, peer);
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
    this.localSource = null;
    this.localAnalyser = null;
    this.localData = new Uint8Array(new ArrayBuffer(0));
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
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
    this.sampleHandle = window.requestAnimationFrame(() => this.sample());
  }
}
