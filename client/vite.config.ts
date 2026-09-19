import { defineConfig } from "vite";

export default defineConfig({
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    host: true, // 监听所有网卡，局域网设备（手机/别的电脑）能用 宿主机IP:5173 打开
    // 开发时前端(5173)直连本地实时服务(2567)
    proxy: {
      "/matchmake": "http://localhost:2567",
      "/songs": "http://localhost:2567",
      "/ws": { target: "ws://localhost:2567", ws: true },
    },
  },
});
