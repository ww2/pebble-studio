import type { PlatformId } from "../../shared/types.js";
import { PLATFORMS } from "../../main/backend/emulatorRegistry.js"; // pure module, bundled by Vite

/**
 * A <select> listing every Pebble platform as "label (id)". Calls onChange with
 * the chosen PlatformId. Exposes `.el` and a `value` getter.
 */
export class VersionSwitcher {
  readonly el: HTMLSelectElement;

  constructor(onChange: (id: PlatformId) => void, initial: PlatformId = "basalt") {
    const select = document.createElement("select");
    select.className = "emu-switcher";

    for (const p of PLATFORMS) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.label} (${p.id})`;
      if (p.id === initial) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener("change", () => onChange(select.value as PlatformId));
    this.el = select;
  }

  get value(): PlatformId {
    return this.el.value as PlatformId;
  }
}
