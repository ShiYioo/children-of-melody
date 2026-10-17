// OhMyGame 发布构建：页面托管在与实时服务不同的域名上，
// 所以构建时注入 VITE_SERVER_URL，让 WebSocket 与曲库请求都直连已部署的服务器。
// client/ 自己的构建（EdgeOne 流水线）不经过这里，行为完全不变。
import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = path.join(root, "client");

const result = spawnSync("npm", ["run", "build"], {
  cwd: client,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, VITE_SERVER_URL: "https://ws.shiyio.uk:8443" },
});
if (result.status !== 0) process.exit(result.status ?? 1);

// 发布器读取根目录 dist/，把 client 构建产物汇总过去
const dist = path.join(root, "dist");
rmSync(dist, { recursive: true, force: true });
cpSync(path.join(client, "dist"), dist, { recursive: true });
console.log("\n[publish] 构建完成 → dist/（VITE_SERVER_URL=https://ws.shiyio.uk:8443）");
