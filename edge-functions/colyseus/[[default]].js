/**
 * EdgeOne Pages 边缘函数——本文件路径即路由：/colyseus/*。
 *
 * Pages 没有"反代设置"的控制台开关：认的是仓库根目录 edge-functions/ 下的文件
 * （中国站文档约定），推送后随构建自动部署。这里把游戏的实时连接
 * （HTTP + WebSocket 升级）反代回源到大陆服务器，解决 HTTPS 页面连 ws://IP
 * 被浏览器拦截的问题。
 *
 * 链路：浏览器 wss://站点/colyseus/* → EdgeOne 边缘(终结TLS) → http://IP:2567/*
 */
const TARGET = "http://160.30.231.236:2567";

async function proxy({ request }) {
  const url = new URL(request.url);
  // /colyseus/xxx → /xxx（Colyseus 挂在服务器根路径）
  const upstream = TARGET + url.pathname.replace(/^\/colyseus/, "") + url.search;

  const headers = new Headers(request.headers);
  headers.delete("host"); // 让上游以 IP 为主机名
  // WebSocket 升级请求原样透传（上游回 101 后由运行时接管双向通道）
  return fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });
}

export const onRequest = proxy;
export default proxy;
