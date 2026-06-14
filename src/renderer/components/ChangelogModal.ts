import { CHANGELOG, type ChangelogEntry } from "../../shared/changelog.js";

/** Pure: flatten changelog entries into render-ready sections (testable). */
export function renderChangelogSections(
  entries: ChangelogEntry[],
): { version: string; date: string; bullets: string[] }[] {
  return entries.map((e) => ({ version: e.version, date: e.date, bullets: e.changes }));
}

/**
 * In-app "What's New / Changelog" modal. Built lazily; opened from the Help menu.
 * Reuses theme tokens. Close via the ✕, backdrop click, or Esc.
 */
export class ChangelogModal {
  private overlay: HTMLElement | null = null;
  private onKey: ((e: KeyboardEvent) => void) | null = null;

  constructor(private readonly version: () => Promise<string>) {}

  async open(): Promise<void> {
    if (this.overlay) return;
    const v = await this.version().catch(() => "");
    const overlay = document.createElement("div");
    overlay.className = "cl-overlay";
    overlay.innerHTML = `
      <div class="cl-card" role="dialog" aria-modal="true" aria-label="What's New">
        <div class="cl-head">
          <span class="brand-mark" aria-hidden="true">P</span>
          <div class="cl-title">
            <div class="type-body-strong">Pebble Studio</div>
            <div class="cl-version">v${escapeHtml(v)}</div>
          </div>
          <button class="cl-close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="cl-body"></div>
      </div>`;
    const body = overlay.querySelector(".cl-body")!;
    for (const s of renderChangelogSections(CHANGELOG)) {
      const sec = document.createElement("div");
      sec.className = "cl-entry";
      const ul = s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("");
      sec.innerHTML = `<div class="cl-entry-head"><span class="cl-ev">v${escapeHtml(s.version)}</span>` +
        `<span class="cl-ed type-caption">${escapeHtml(s.date)}</span></div><ul>${ul}</ul>`;
      body.appendChild(sec);
    }
    const close = (): void => this.close();
    overlay.querySelector(".cl-close")!.addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    this.onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", this.onKey);
    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  close(): void {
    if (this.onKey) { document.removeEventListener("keydown", this.onKey); this.onKey = null; }
    this.overlay?.remove();
    this.overlay = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
