import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error type error without @types/node package
import process from "node:process";

// package.json 声明了 "type": "module"，vite.config.ts 按 ESM 加载，没有 __dirname，
// 需要从 import.meta.url 推导出配置文件所在目录
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Mochi 是多窗口应用：pet（宠物）/ chat（聊天）/ alert（提醒弹窗）各是一个 HTML 入口。
  // dev 模式下 Tauri 窗口通过 devUrl + 文件名（如 /chat.html）加载对应页面；
  // build 模式下由 rollupOptions.input 告诉 Vite 打包出三个 HTML。
  build: {
    rollupOptions: {
      input: {
        pet: path.resolve(__dirname, "index.html"),
        chat: path.resolve(__dirname, "chat.html"),
        alert: path.resolve(__dirname, "alert.html"),
      },
    },
  },

  resolve: {
    alias: {
      // 让 src 内部用 @/xxx 导入，与 tsconfig paths 保持一致
      "@": path.resolve(__dirname, "src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
