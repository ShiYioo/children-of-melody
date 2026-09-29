/**
 * EdgeOne 边缘函数：把游戏 API 反代回源到大陆服务器（免域名备案方案）。
 *
 * 部署：EdgeOne 控制台 → 你的 Pages 站点 → 边缘函数 → 创建函数，
 *       绑定路由 `/colyseus/*` 和 `/songs/*`，粘贴本文件代码。
 *
 * 原理：浏览器(HTTPS/WSS) → EdgeOne 边缘节点(终结TLS) → HTTP 回源 IP:2567。
 * 域名是 EdgeOne 的，不碰"大陆服务器+域名"的备案要求；
 * 纯 IP:非标准端口 的 HTTP 回源通常不触发运营商的未备案拦截。
 *
 * Colyseus 的 WebSocket 升级请求：EdgeOne 边缘函数对 WS 的透传支持
 * 以平台实现为准——若边缘函数不支持 WS 升级，改用规则引擎的"修改回源"
 * （规则引擎原生支持代理 WS）；两条路都写在此，先试规则引擎。
 */
export function onRequest({ request, params }: { request: Request; params: any }) {
  const TARGET = "http://160.30.231.236:2567"; // 你的大陆服务器（IP 直连，未备案域名不要绑它）
  const url = new URL(request.url);
  // /colyseus/xxx → /xxx（Colyseus 挂在服务器根路径）
  const path = url.pathname.replace(/^\/colyseus/, "") || "/";
  const upstream = TARGET + path + url.search;

  const headers = new Headers(request.headers);
  headers.delete("host"); // 让上游以 IP 为主机名响应

  const init: RequestInit = {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  };
  return fetch(upstream, init);
}
