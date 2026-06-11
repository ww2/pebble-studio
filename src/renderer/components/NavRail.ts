/**
 * Left navigation rail (Windows 11 Fluent style). Renders a vertical list of
 * nav items; the selected item shows a small accent-colored pill on its left
 * edge. Selecting an item invokes `onSelect` with the item's id so the shell can
 * swap the right inspector pane.
 *
 * Pure presentation + selection state — owns no app data. The shell (main.ts)
 * wires the panes.
 */
export interface NavItem {
  id: string;
  /** Short visible label, e.g. "Apps". */
  label: string;
  /** Decorative glyph (emoji / unicode) shown above the label. */
  glyph: string;
}

export class NavRail {
  readonly el: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private selectedId: string;

  constructor(
    private readonly items: NavItem[],
    private readonly onSelect: (id: string) => void,
    initial?: string,
  ) {
    this.selectedId = initial ?? items[0]?.id ?? "";

    this.el = document.createElement("nav");
    this.el.className = "nav-rail";
    this.el.setAttribute("role", "tablist");
    this.el.setAttribute("aria-label", "Inspector sections");

    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-rail-item";
      btn.dataset.nav = item.id;
      btn.setAttribute("role", "tab");
      btn.title = item.label;
      btn.innerHTML = `
        <span class="nav-rail-pill" aria-hidden="true"></span>
        <span class="nav-rail-glyph" aria-hidden="true">${item.glyph}</span>
        <span class="nav-rail-label">${item.label}</span>
      `;
      btn.addEventListener("click", () => this.select(item.id));
      this.buttons.set(item.id, btn);
      this.el.appendChild(btn);
    }

    this.syncState();
  }

  /** Currently selected nav item id. */
  get value(): string {
    return this.selectedId;
  }

  /** Programmatically select an item; fires onSelect when it changes. */
  select(id: string): void {
    if (!this.buttons.has(id)) return;
    const changed = id !== this.selectedId;
    this.selectedId = id;
    this.syncState();
    if (changed) this.onSelect(id);
  }

  private syncState(): void {
    for (const [id, btn] of this.buttons) {
      const active = id === this.selectedId;
      btn.classList.toggle("nav-rail-item--active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
  }
}
