import { describe, it, expect, vi } from "vitest";
import { buildMenuTemplate } from "../../src/main/menu.js";

function handlers() {
  return { installPbw: vi.fn(), clearEmulator: vi.fn(), showChangelog: vi.fn() };
}

describe("buildMenuTemplate", () => {
  it("has exactly File, Edit, Window, Help at the top level", () => {
    const t = buildMenuTemplate(handlers(), "1.0.0");
    expect(t.map((m) => m.label)).toEqual(["File", "Edit", "Window", "Help"]);
  });

  it("File → Install PBW… and Clear Emulator call their handlers", () => {
    const h = handlers();
    const file = buildMenuTemplate(h, "1.0.0")[0];
    const items = (file.submenu as any[]);
    const install = items.find((i) => i.label === "Install PBW…");
    const clear = items.find((i) => i.label === "Clear Emulator");
    install.click(); clear.click();
    expect(h.installPbw).toHaveBeenCalledOnce();
    expect(h.clearEmulator).toHaveBeenCalledOnce();
  });

  it("Help shows a disabled version item and a What's New item", () => {
    const h = handlers();
    const help = buildMenuTemplate(h, "1.0.0").find((m) => m.label === "Help")!;
    const items = (help.submenu as any[]);
    const ver = items.find((i) => i.label === "Pebble Studio v1.0.0");
    expect(ver.enabled).toBe(false);
    const whatsNew = items.find((i) => i.label === "What's New / Changelog…");
    whatsNew.click();
    expect(h.showChangelog).toHaveBeenCalledOnce();
  });
});
