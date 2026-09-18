import { defineConfig } from "vite";

export default defineConfig({
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    // 开发时前端(5173)直连本地实时服务(2567)
    proxy: {
      "/matchmake": "http://localhost:2567",
      "/songs": "http://localhost:2567",
      "/ws": { target: "ws://localhost:2567", ws: true },
    },
  },
});
