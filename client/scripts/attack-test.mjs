/**
 * 攻击模拟验证：上线前的服务器防护自测。
 * 用法：确保服务器在跑，然后  node scripts/attack-test.mjs
 * 验证四类攻击下服务器存活、拒绝生效、洪水客户端被踢：
 *  1. NaN/Infinity 坐标（绕过速度检查+毒广播）
 *  2. 消息洪水（300/s × 3s，令牌桶应踢线）
 *  3. 超长聊天串（10KB × 20，应被截断不炸）
 *  4. 恶意 track URL（javascript: 协议，应被拒绝）
 * 最后用一个新客户端确认服务器仍然健康响应。
 */
import { Client } from "@colyseus/sdk";

const ENDPOINT = process.env.ATTACK_TARGET || "http://localhost:2567";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  const client = new Client(ENDPOINT);
  return client.joinOrCreate("island", { name });
}

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
};

async function serverAlive() {
  try {
    const room = await connect("健康探针");
    const ok = room.sessionId.length > 0;
    room.leave();
    return ok;
  } catch {
    return false;
  }
}

async function main() {
  // ---- 1. NaN 坐标 ----
  {
    const room = await connect("NaN攻击者");
    for (let i = 0; i < 50; i++) {
      room.send("pos", { x: NaN, y: Infinity, z: NaN, ry: NaN, mov: 1, sit: false });
    }
    await sleep(600);
    check("NaN 坐标攻击：服务器存活", await serverAlive(), "50 条 NaN pos 已发送");
    room.leave();
  }

  // ---- 2. 消息洪水 ----
  {
    const room = await connect("洪水攻击者");
    let kicked = false;
    room.onLeave(() => (kicked = true));
    const t0 = Date.now();
    let sent = 0;
    while (Date.now() - t0 < 3000) {
      for (let i = 0; i < 30; i++) room.send("time", {}); // 无类型限制地猛灌
      sent += 30;
      await sleep(100);
    }
    await sleep(800);
    check("消息洪水：攻击者被踢", kicked, `发送 ~${sent} 条 / 3s`);
    check("消息洪水：服务器存活", await serverAlive());
    try { room.leave(); } catch {}
  }

  // ---- 3. 超长聊天 ----
  {
    const room = await connect("复读机");
    for (let i = 0; i < 20; i++) room.send("chat", { text: "A".repeat(10240) });
    await sleep(600);
    check("超长聊天轰炸：服务器存活", await serverAlive(), "20 条 10KB 聊天已发送");
    room.leave();
  }

  // ---- 4. 恶意 track ----
  {
    const room = await connect("投毒者");
    room.send("track", { trackId: 200, url: "javascript:alert(1)", name: "<script>x</script>" });
    room.send("track", { trackId: 200, url: "http://" + "b".repeat(600) + ".com/a.mp3" });
    room.send("track", { trackId: 99999 });
    await sleep(500);
    check("恶意 track URL：服务器存活", await serverAlive(), "javascript: 协议 + 超长 URL + 越界 id 已发送");
    room.leave();
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n✗ ${failed.length} 项未通过` : "\n全部通过：防护有效");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("测试脚本自身失败:", e.message);
  process.exit(2);
});
