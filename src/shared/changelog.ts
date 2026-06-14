/** A single user-facing changelog entry. Newest entries come first in CHANGELOG. */
export interface ChangelogEntry {
  version: string;
  date: string; // YYYY-MM-DD
  changes: string[];
}

/**
 * User-facing changelog (concise, newest-first). Patch iterations within the
 * 0.0.13.x line are folded into their 0.0.13 entry to stay readable. Source of
 * truth for the Help → "What's New" modal.
 */
export const CHANGELOG: ChangelogEntry[] = [
  { version: "1.0.0", date: "2026-06-13", changes: [
    "First stable release — the WSL-connected Pebble emulator GUI.",
    "New app & Windows .exe icon (Pebble Time 2 watch design).",
    "Application menu: File (Install PBW…, Clear Emulator), Edit, Window, Help.",
    "Help → What's New shows the version and this changelog.",
  ]},
  { version: "0.0.13", date: "2026-06-13", changes: [
    "Backlight button on the toolbar (activation: Back button or Shake, set in Settings).",
    "Toolbar button groups wrap together and stay centered on small windows.",
    "Fixed a false 'Emulator stopped responding' relaunch loop on a healthy emulator.",
    "Persistent, copyable diagnostics session log; loud Clay failures + auto-recovery.",
    "Time & Clay configuration port; per-app Clay config window.",
  ]},
  { version: "0.0.12", date: "2026-06-12", changes: [
    "Timezone and custom time reliably reach the watch; 12-hour default.",
  ]},
  { version: "0.0.11", date: "2026-06-12", changes: [
    "24-hour default, backlight-off default, time and app-list fixes, status row.",
  ]},
  { version: "0.0.10", date: "2026-06-11", changes: [
    "Working Timezone / Custom time, plus Freeze and time-rate controls.",
  ]},
  { version: "0.0.9", date: "2026-06-11", changes: [
    "Time offset and a three-mode Time source; live status; dropdown fixes.",
  ]},
  { version: "0.0.8", date: "2026-06-10", changes: [
    "Timeline button; Settings Time section (System vs Custom).",
  ]},
  { version: "0.0.7", date: "2026-06-10", changes: [
    "Opaque model dropdown, neutral Tap button, backlight-keepalive option.",
  ]},
  { version: "0.0.6", date: "2026-06-09", changes: [
    "Launch-failure highlight on the Relaunch button.",
  ]},
  { version: "0.0.5", date: "2026-06-09", changes: [
    "Boot cancellation + abort, splash screen.",
  ]},
  { version: "0.0.4", date: "2026-06-08", changes: [
    "Fit scaling, round-watch layout, thin screen bezel.",
  ]},
  { version: "0.0.3", date: "2026-06-08", changes: [
    "Screenshot/GIF capture; app library improvements.",
  ]},
  { version: "0.0.2", date: "2026-06-07", changes: [
    "Multi-platform model switching; noVNC live screen.",
  ]},
  { version: "0.0.1", date: "2026-06-07", changes: [
    "Initial build — boot the qemu-pebble emulator and view the live watch.",
  ]},
];
