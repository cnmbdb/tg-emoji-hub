import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devApiTarget = process.env.VITE_DEV_API_TARGET ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: devApiTarget,
        changeOrigin: true,
      },
      "/healthz": {
        target: devApiTarget,
        changeOrigin: true,
      },
      "/thumbs": {
        target: devApiTarget,
        changeOrigin: true,
      },
      "/emoji": {
        target: devApiTarget,
        changeOrigin: true,
      },
      "/mcp": {
        target: devApiTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // lottie-web + pako 拆独立 chunk，列表页不放 tgs 的话整个 chunk 不下载
          if (id.includes("node_modules/lottie-web") || id.includes("node_modules/pako")) {
            return "lottie";
          }
        },
      },
    },
  },
});
