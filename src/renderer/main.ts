import { resolveTheme, applyTheme } from "./theme.js";

interface StudioApi {
  initBackend(): Promise<{ kind: string }>;
  start(id: string): Promise<unknown>;
  stop(): Promise<unknown>;
  install(pbwPath: string): Promise<unknown>;
  button(id: string): Promise<unknown>;
  accelTap(): Promise<unknown>;
  screenshot(out: string): Promise<unknown>;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}

applyTheme(resolveTheme("dark"));

const app = document.getElementById("app")!;
app.innerHTML = `
  <main class="shell">
    <h1>Pebble Studio</h1>
    <p class="backend">Backend: <span id="backend-kind">…</span></p>
  </main>
`;

async function init(): Promise<void> {
  const kindEl = document.getElementById("backend-kind")!;
  try {
    const { kind } = await window.studio.initBackend();
    kindEl.textContent = kind;
  } catch (err) {
    kindEl.textContent = "error";
    console.error("backend init failed", err);
  }
}

void init();
