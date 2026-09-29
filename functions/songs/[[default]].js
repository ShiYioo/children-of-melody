/**
 * EdgeOne Pages 边缘函数——本文件路径即路由：/songs/*。
 * 玩家上传的歌走同源相对路径（/songs/file/:id），这里原样反代回源服务器。
 */
const TARGET = "http://160.30.231.236:2567";

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const upstream = TARGET + url.pathname + url.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  return fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });
}
