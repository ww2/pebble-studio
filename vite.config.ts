import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    // Electron 33 ships Chromium 130, which supports top-level await
    // (used by @novnc/novnc 1.7's WebCodecs feature detection).
    target: "chrome130",
  },
});
