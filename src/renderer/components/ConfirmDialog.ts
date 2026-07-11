/**
 * A bespoke, in-app modal dialog styled to match Pebble Studio (see `.dlg-*` in
 * app.css) — the themed replacement for the OS `dialog.showMessageBox`. Generic:
 * a title, one or more body paragraphs, and a row of buttons. Resolves to the
 * chosen button's `value`, or `dismissValue` on Esc / backdrop / ✕.
 *
 * Accessible: role="dialog" + aria-modal, focus moves into the dialog and is
 * trapped across the buttons, and the triggering element is refocused on close.
 */
export interface DialogButton {
  label: string;
  value: string;
  /** primary = accent fill; danger = destructive tint; default = plain. */
  variant?: "primary" | "danger" | "default";
}

export interface DialogOptions {
  title: string;
  /** Body paragraphs (plain text — rendered as separate <p>s, escaped). */
  lines: string[];
  buttons: DialogButton[];
  /** Value resolved when the dialog is dismissed (Esc / backdrop / ✕). Defaults
   * to the first button's value when omitted. */
  dismissValue?: string;
}

export function openDialog(opts: DialogOptions): Promise<string> {
  const dismiss = opts.dismissValue ?? opts.buttons[0]?.value ?? "";
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = document.createElement("div");
  overlay.className = "dlg-overlay";

  const card = document.createElement("div");
  card.className = "dlg-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", opts.title);

  const head = document.createElement("div");
  head.className = "dlg-head";
  const brand = document.createElement("span");
  brand.className = "brand-mark";
  brand.setAttribute("aria-hidden", "true");
  brand.textContent = "P";
  const title = document.createElement("div");
  title.className = "dlg-title type-body-strong";
  title.textContent = opts.title;
  head.append(brand, title);

  const body = document.createElement("div");
  body.className = "dlg-body";
  for (const line of opts.lines) {
    const p = document.createElement("p");
    p.className = "type-body";
    p.textContent = line;
    body.appendChild(p);
  }

  const actions = document.createElement("div");
  actions.className = "dlg-actions";

  return new Promise<string>((resolve) => {
    let done = false;
    const close = (value: string): void => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.isConnected) prevFocus.focus();
      resolve(value);
    };

    const btnEls: HTMLButtonElement[] = opts.buttons.map((b) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `dlg-btn dlg-btn--${b.variant ?? "default"}`;
      el.textContent = b.label;
      el.addEventListener("click", () => close(b.value));
      return el;
    });
    actions.append(...btnEls);

    card.append(head, body, actions);
    overlay.appendChild(card);

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(dismiss);
    });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(dismiss);
        return;
      }
      if (e.key === "Tab" && btnEls.length > 0) {
        // Trap focus within the button row.
        e.preventDefault();
        const idx = btnEls.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.shiftKey
          ? (idx <= 0 ? btnEls.length - 1 : idx - 1)
          : (idx === btnEls.length - 1 ? 0 : idx + 1);
        btnEls[next]?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    // Focus the primary button if there is one, else the last (usually the safe
    // default) — never a destructive button.
    const primary = btnEls.find((_, i) => opts.buttons[i].variant === "primary");
    (primary ?? btnEls[btnEls.length - 1])?.focus();
  });
}
