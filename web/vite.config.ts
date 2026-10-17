import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev server proxies `/api` to the aaas engine (contract §5).
 *
 * SSE deliberately has no buffering setting here: the proxy pipes the upstream
 * response straight through, and the server already sends
 * `cache-control: no-cache, no-transform` + `x-accel-buffering: no`.
 * Adding a buffer/compression layer would delay `data:` frames until flush.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7788",
        changeOrigin: true,
      },
    },
  },
});
