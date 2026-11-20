import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: { input: { main: "index.html", aria: "aria.html" } },
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
