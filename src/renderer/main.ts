import { resolveTheme, applyTheme } from "./theme.js";
import { EmulatorView } from "./components/EmulatorView.js";
import { VersionSwitcher } from "./components/VersionSwitcher.js";
import { AppLibrary } from "./components/AppLibrary.js";
import type { PlatformId } from "../shared/types.js";

interface StudioApi {
  initBackend(): Promise<{ kind: string }>;
  start(id: string): Promise<{ host: string; port: number; wsPath: string }>;
  stop(): Promise<unknown>;
  install(pbwPath: string): Promise<unknown>;
  button(id: string): Promise<unknown>;
  accelTap(): Promise<unknown>;
  screenshot(out: string): Promise<unknown>;
  libAdd(pbwPath: string): Promise<string[]>;
  libList(): Promise<string[]>;
  libRemove(p: string): Promise<string[]>;
  libInstallAll(): Promise<void>;
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}

applyTheme(resolveTheme("dark"));

const app = document.getElementById("app")!;
app.innerHTML = `
  <main class="shell emu-shell">
    <header class="emu-header">
      <h1>Pebble Studio</h1>
      <div class="emu-toolbar" id="emu-toolbar">
        <span class="emu-backend">Backend: <span id="backend-kind">…</span></span>
      </div>
    </header>
    <div id="emu-mount"></div>
  </main>
`;

const view = new EmulatorView();
const switcher = new VersionSwitcher((id: PlatformId) => void view.show(id), "basalt");
const library = new AppLibrary();

const toolbar = document.getElementById("emu-toolbar")!;
toolbar.insertBefore(switcher.el, toolbar.firstChild);
const emuMount = document.getElementById("emu-mount")!;
emuMount.appendChild(view.el);
emuMount.appendChild(library.el);

async function init(): Promise<void> {
  const kindEl = document.getElementById("backend-kind")!;
  try {
    const { kind } = await window.studio.initBackend();
    kindEl.textContent = kind;
    await library.refresh();
    await view.show(switcher.value);
  } catch (err) {
    kindEl.textContent = "error";
    console.error("backend init failed", err);
  }
}

void init();
