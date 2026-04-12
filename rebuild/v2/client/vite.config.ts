import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/assets": {
        target: "http://127.0.0.1:4100",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist-v2"
  }
});
