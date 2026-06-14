import type { MenuItemConstructorOptions } from "electron";

/** Click handlers the template wires to menu items (injected for testability). */
export interface MenuHandlers {
  installPbw: () => void;
  clearEmulator: () => void;
  showChangelog: () => void;
}

/**
 * Pure builder for the application menu template (File/Edit/Window/Help).
 * No Electron runtime needed — only the type import (erased at compile). The
 * caller passes the resolved app version and the click handlers.
 */
export function buildMenuTemplate(h: MenuHandlers, version: string): MenuItemConstructorOptions[] {
  return [
    {
      label: "File",
      submenu: [
        { label: "Install PBW…", accelerator: "CmdOrCtrl+O", click: () => h.installPbw() },
        { label: "Clear Emulator", click: () => h.clearEmulator() },
        { type: "separator" },
        { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    { label: "Window", role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        { label: `Pebble Studio v${version}`, enabled: false },
        { type: "separator" },
        { label: "What's New / Changelog…", click: () => h.showChangelog() },
        { role: "toggleDevTools" },
      ],
    },
  ];
}
