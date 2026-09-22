import type { Client } from "colyseus";

/**
 * 生产防护核心：
 *  - 全消息令牌桶（任何类型的消息共用一个预算，超限丢弃，屡犯踢线）
 *  - IP 并发连接上限（防连接洪水；NAT 环境留了余量）
 *  - 字段消毒：NaN/Infinity 在 typeof 检查下畅通无阻（NaN > 40 === false），
 *    必须用 Number.isFinite 显式拦截，否则脏坐标会广播毒死所有客户端
 */

export class MsgGuard {
  /** 每会话令牌桶：sessionId → { tokens, lastT, strikes, strikeAt } */
  private buckets = new Map<string, { tokens: number; lastT: number; strikes: number; strikeAt: number }>();
  /** 每 IP 活跃连接数 */
  static ipConns = new Map<string, number>();

  constructor(
    /** 持续速率（消息/秒）。合法游戏流量峰值 ~35/s（pos 10Hz + 音符 20/s），40 留余量 */
    readonly rate = 40,
    /** 突发容量 */
    readonly burst = 120,
    /** 10 秒窗口内超限次数达到即踢 */
    readonly maxStrikes = 5
  ) {}

  /** 每条消息调用：true=放行，false=丢弃（调用方无需处理，达到踢线阈值由 guard 自己踢） */
  allow(client: Client): boolean {
    const now = Date.now();
    let b = this.buckets.get(client.sessionId);
    if (!b) {
      b = { tokens: this.burst, lastT: now, strikes: 0, strikeAt: now };
      this.buckets.set(client.sessionId, b);
    }
    const elapsed = (now - b.lastT) / 1000;
    b.lastT = now;
    b.tokens = Math.min(this.burst, b.tokens + elapsed * this.rate);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    // 超限：记一次犯规；10 秒窗口内屡犯直接踢
    if (now - b.strikeAt > 10_000) {
      b.strikeAt = now;
      b.strikes = 0;
    }
    b.strikes++;
    if (b.strikes >= this.maxStrikes) {
      console.warn(`[guard] 踢出消息洪水客户端 ${client.sessionId}`);
      client.leave(4003, "消息频率超限");
    }
    return false;
  }

  cleanup(sessionId: string) {
    this.buckets.delete(sessionId);
  }

  dispose() {
    this.buckets.clear();
  }

  /** IP 连接配额：true=放行 */
  static tryAcquireIp(ip: string, max = 8): boolean {
    const n = MsgGuard.ipConns.get(ip) ?? 0;
    if (n >= max) return false;
    MsgGuard.ipConns.set(ip, n + 1);
    return true;
  }

  static releaseIp(ip: string) {
    const n = MsgGuard.ipConns.get(ip) ?? 1;
    if (n <= 1) MsgGuard.ipConns.delete(ip);
    else MsgGuard.ipConns.set(ip, n - 1);
  }
}

/** 数值消毒：非有限数（NaN/Infinity/其他类型）一律返回 fallback */
export function finite(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 数值消毒 + 区间夹取 */
export function finiteClamp(v: unknown, min: number, max: number, fallback = 0): number {
  const n = finite(v, fallback);
  return Math.max(min, Math.min(max, n));
}

/** 字符串消毒：截断 + 去控制字符（防乱码/隐形轰炸） */
export function safeStr(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLen);
}
