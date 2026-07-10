import { defineConfig, type Plugin } from "vite";

// Inject a strict Content-Security-Policy into the PRODUCTION index.html only.
// Dev is skipped so Vite's HMR client (inline scripts + ws to the dev port)
// keeps working. Scoped to this renderer's index.html, so the Clay config
// window (which loads remote/data: HTML) is unaffected.
//   - script-src 'self'            : only the bundled module graph
//   - worker-src 'self' blob:      : gif.js loads ./gif.worker.js (blob in some builds)
//   - connect-src ... ws localhost : noVNC + Clay socket to the local emulator
//   - img/media 'self' data: blob: : canvas captures (screenshots/GIFs)
//   - style-src 'self' 'unsafe-inline' : the app sets element styles inline
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

function cspMeta(): Plugin {
  return {
    name: "inject-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "</title>",
        `</title>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [cspMeta()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    // Electron 33 ships Chromium 130, which supports top-level await
    // (used by @novnc/novnc 1.7's WebCodecs feature detection).
    target: "chrome130",
  },
});
