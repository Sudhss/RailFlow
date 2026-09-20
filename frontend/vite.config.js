import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Three.js is the bulk of the corridor view's weight and changes far
          // less often than the console does. Keeping it in its own chunk means
          // a change to RailFlow does not invalidate it in the browser cache.
          if (id.includes("node_modules/three")) return "three";
          return undefined;
        },
      },
    },
  },
});
