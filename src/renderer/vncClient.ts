// noVNC ships ESM at core/rfb.js (package exports "./core/rfb.js"), with no
// bundled type declarations. We declare a minimal RFB surface below so the
// renderer typechecks under the bundler resolution config.
// The package's "exports" field maps the root entry to ./core/rfb.js, so we
// import the bare package name (the subpath form is rejected by exports).
import RFB from "@novnc/novnc";
import type { VncEndpoint } from "../main/backend/BackendDriver.js"; // type-only (erased by Vite)

export interface VncHandle {
  disconnect(): void;
  setTouchEnabled(on: boolean): void;
}

export function connectVnc(
  container: HTMLElement,
  ep: VncEndpoint,
  touchEnabled: boolean,
): VncHandle {
  const url = `ws://${ep.host}:${ep.port}${ep.wsPath}`;
  const rfb = new RFB(container, url, {});
  rfb.viewOnly = !touchEnabled; // only emery/gabbro forward pointer events
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.addEventListener("connect", () => console.log("[vnc] connected", url));
  rfb.addEventListener("disconnect", (e: Event) => {
    const clean = (e as CustomEvent<{ clean?: boolean }>).detail?.clean;
    console.log("[vnc] disconnected", clean);
  });
  return {
    disconnect: () => rfb.disconnect(),
    setTouchEnabled: (on: boolean) => {
      rfb.viewOnly = !on;
    },
  };
}
