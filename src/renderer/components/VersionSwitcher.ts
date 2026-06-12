import type { PlatformId } from "../../shared/types.js";
import { PLATFORMS } from "../../main/backend/emulatorRegistry.js"; // pure module, bundled by Vite

/**
 * Accessible custom combobox listing every Pebble platform. Replaces the native
 * `<select>` (whose option list could not be themed, producing white-on-white in
 * one theme) with a fully theme-controlled button + popup listbox.
 *
 * Public API (consumed by main.ts) is preserved:
 *  - constructor(onChange, initial)
 *  - `.el` is an HTMLElement (root container)
 *  - `.value` getter returns the selected PlatformId
 */
export class VersionSwitcher {
  readonly el: HTMLElement;

  private readonly onChange: (id: PlatformId) => void;
  private readonly button: HTMLButtonElement;
  private readonly buttonLabel: HTMLSpanElement;
  private readonly popup: HTMLDivElement;
  private readonly options: HTMLDivElement[] = [];

  private selected: PlatformId;
  private activeIndex = 0;
  private open = false;

  constructor(onChange: (id: PlatformId) => void, initial: PlatformId = "basalt") {
    this.onChange = onChange;
    this.selected = PLATFORMS.some((p) => p.id === initial) ? initial : PLATFORMS[0].id;

    const root = document.createElement("div");
    root.className = "version-combo";

    // Trigger button (shows the current model label).
    const button = document.createElement("button");
    button.type = "button";
    button.className = "version-combo-btn";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "version-combo-label";
    const caret = document.createElement("span");
    caret.className = "version-combo-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▾"; // ▾
    button.append(label, caret);

    // Popup listbox.
    const popup = document.createElement("div");
    popup.className = "version-combo-popup";
    popup.setAttribute("role", "listbox");
    popup.hidden = true;

    PLATFORMS.forEach((p, i) => {
      const opt = document.createElement("div");
      opt.className = "version-combo-option";
      opt.setAttribute("role", "option");
      opt.dataset.id = p.id;
      opt.id = `version-combo-opt-${p.id}`;

      const name = document.createElement("span");
      name.className = "version-combo-opt-label";
      name.textContent = p.label;
      const id = document.createElement("span");
      id.className = "version-combo-opt-id";
      id.textContent = p.id;
      opt.append(name, id);

      opt.addEventListener("click", (e) => { e.stopPropagation(); this.choose(i); });
      opt.addEventListener("mousemove", () => this.setActive(i));
      popup.appendChild(opt);
      this.options.push(opt);
    });

    button.addEventListener("click", (e) => { e.stopPropagation(); this.toggle(); });
    button.addEventListener("keydown", (e) => this.onKeydown(e));
    document.addEventListener("click", (e) => {
      if (this.open && !root.contains(e.target as Node)) this.close();
    });

    root.append(button, popup);

    this.el = root;
    this.button = button;
    this.buttonLabel = label;
    this.popup = popup;

    this.syncButton();
    this.syncSelectedState();
  }

  get value(): PlatformId {
    return this.selected;
  }

  /**
   * Programmatically set the selection (e.g. from the Settings "Startup watch"
   * dropdown) WITHOUT firing onChange — the caller drives the preview itself,
   * so this only keeps the combo's shown value in sync.
   */
  set value(id: PlatformId) {
    if (!PLATFORMS.some((p) => p.id === id) || id === this.selected) return;
    this.selected = id;
    this.syncButton();
    this.syncSelectedState();
  }

  // ── internals ────────────────────────────────────────────────────────────
  private indexOfSelected(): number {
    return PLATFORMS.findIndex((p) => p.id === this.selected);
  }

  private syncButton(): void {
    const p = PLATFORMS[this.indexOfSelected()];
    this.buttonLabel.textContent = p.label;
  }

  private syncSelectedState(): void {
    this.options.forEach((opt, i) => {
      const isSel = PLATFORMS[i].id === this.selected;
      opt.classList.toggle("is-selected", isSel);
      opt.setAttribute("aria-selected", isSel ? "true" : "false");
    });
  }

  private setActive(i: number): void {
    this.activeIndex = i;
    this.options.forEach((opt, idx) => opt.classList.toggle("is-active", idx === i));
    const active = this.options[i];
    if (active) {
      this.button.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    }
  }

  private toggle(): void {
    this.open ? this.close() : this.openPopup();
  }

  private openPopup(): void {
    this.open = true;
    this.popup.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.setActive(this.indexOfSelected());
  }

  private close(): void {
    this.open = false;
    this.popup.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    this.button.removeAttribute("aria-activedescendant");
    this.options.forEach((opt) => opt.classList.remove("is-active"));
  }

  private choose(i: number): void {
    const id = PLATFORMS[i].id;
    const changed = id !== this.selected;
    this.selected = id;
    this.syncButton();
    this.syncSelectedState();
    this.close();
    this.button.focus();
    if (changed) this.onChange(id);
  }

  private onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        if (this.open) this.choose(this.activeIndex);
        else this.openPopup();
        break;
      case "ArrowDown":
        e.preventDefault();
        if (!this.open) this.openPopup();
        else this.setActive(Math.min(this.activeIndex + 1, this.options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!this.open) this.openPopup();
        else this.setActive(Math.max(this.activeIndex - 1, 0));
        break;
      case "Home":
        if (this.open) { e.preventDefault(); this.setActive(0); }
        break;
      case "End":
        if (this.open) { e.preventDefault(); this.setActive(this.options.length - 1); }
        break;
      case "Escape":
        if (this.open) { e.preventDefault(); this.close(); }
        break;
    }
  }
}
