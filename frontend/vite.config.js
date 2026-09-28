import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";


export default defineConfig({
  plugins: [vue()],
  base: "/admin-ui/",
  server: {
    port: 5173,
    proxy: {
      "/admin/api": {
        target: process.env.API_TARGET || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: { assetsInlineLimit: 0, target: "es2020", sourcemap: false, reportCompressedSize: true },
});
