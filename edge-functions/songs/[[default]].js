/**
 * EdgeOne Pages 边缘函数——本文件路径即路由：/songs/*。
 * 玩家上传的歌走同源相对路径（/songs/file/:id），这里原样反代回源服务器。
 *
 * 注意：Edge Functions 请求 body 上限 1MB（中国站文档 127416）——
 * 歌曲上传（≤20MB）经此反代会被拒，上传功能要么直连、要么换方案。
 */
const TARGET = "http://160.30.231.236:2567";

async function proxy({ request }) {
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

export const onRequest = proxy;
export default proxy;
