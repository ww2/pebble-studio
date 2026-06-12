/**
 * Custom-time field formatting (12h / 24h) — kept DOM-free and pure so it can be
 * unit-tested and reused.
 *
 * WHY this exists: a native `<input type="time">` renders 12h-with-AM/PM or 24h
 * purely from the OS/app LOCALE (en-US → AM/PM, en-GB → 24h) and ignores the
 * element's `lang` attribute in Electron/Chromium — so the in-app "24-hour clock"
 * toggle could not change it (it always showed AM/PM on a US machine). We instead
 * use a plain text input and format/parse it ourselves off the toggle.
 *
 * Canonical storage form is always 24-hour "HH:MM" (zero-padded) so the rest of
 * the time pipeline (customWallMs, the badge) stays unambiguous.
 */

/** Canonical "HH:MM" (24h) ⇒ the string shown in the input for the active mode. */
export function formatTimeDisplay(canon: string, hour24: boolean): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(canon.trim());
  if (!m) return "";
  let h = +m[1];
  const mm = m[2];
  if (h > 23 || +mm > 59) return "";
  if (hour24) return `${String(h).padStart(2, "0")}:${mm}`;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mm} ${ap}`;
}

/**
 * Parse whatever the user typed into the canonical "HH:MM" (24h), or null if it
 * isn't a valid time. Accepts both forms regardless of the active mode so a paste
 * or a leftover value is tolerated:
 *   - 24h: "9:05", "09:05", "21:5" → "09:05" / "21:05"
 *   - 12h: "9:05 pm", "9:05PM", "12:00 am" → "21:05" / "00:00"
 */
export function parseTimeInput(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const pad = (n: number): string => String(n).padStart(2, "0");

  // 12-hour with an AM/PM marker.
  const twelve = /^(\d{1,2}):(\d{1,2})\s*([AaPp])\.?[Mm]\.?$/.exec(s);
  if (twelve) {
    let h = +twelve[1];
    const mi = +twelve[2];
    const pm = /[Pp]/.test(twelve[3]);
    if (h < 1 || h > 12 || mi > 59) return null;
    if (h === 12) h = 0;
    if (pm) h += 12;
    return `${pad(h)}:${pad(mi)}`;
  }

  // 24-hour, no marker.
  const twentyfour = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (twentyfour) {
    const h = +twentyfour[1];
    const mi = +twentyfour[2];
    if (h > 23 || mi > 59) return null;
    return `${pad(h)}:${pad(mi)}`;
  }

  return null;
}

/** Placeholder/example for the active mode. */
export function timePlaceholder(hour24: boolean): string {
  return hour24 ? "HH:MM (e.g. 14:30)" : "h:mm AM/PM (e.g. 2:30 PM)";
}
