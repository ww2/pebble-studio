import { resolveTheme, applyTheme, type ThemeMode } from "../theme.js";
import type { PlatformId } from "../../shared/types.js";
import { PLATFORMS } from "../../main/backend/emulatorRegistry.js"; // pure module, bundled by Vite
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  loadBindings,
  saveBindings,
  isBareModifierKey,
  applyRebind,
  type KeyAction,
  type Bindings,
} from "../keybindings.js";
import {
  detectHostTimezone,
  DEFAULT_TIME_CONFIG,
  type TimeConfig,
  type Rate,
} from "../../main/backend/timeController.js";
import { parseTimeInput, to12h, from12h } from "../timeFormat.js";
import {
  DEFAULT_SIM_ENV, CONDITION_OPTIONS, PRESET_CITIES,
  tempInputToC, tempCToDisplay,
  type SimEnvConfig, type ConditionKey,
} from "../../shared/simEnv.js";
import { LIVE_SUNLIGHT_KEY, LIVE_SUNLIGHT_EVENT } from "../liveSunlight.js";
import { LanguagePanel } from "./LanguagePanel.js";

type ThemeChoice = "light" | "dark";
type BootMode = "auto" | "manual";
/** A switch row whose visual/closure state can be set externally without firing its onToggle. */
type SwitchRow = HTMLElement & { setOn: (on: boolean) => void };

/** Options for the boot-mode + capture-location + diagnostics controls (owned by main.ts). */
interface SettingsOptions {
  initialBootMode: BootMode;
  onBootModeChange: (mode: BootMode) => void;
  /** Flip EmulatorView's diagnostics overlay live when the toggle changes (J). */
  onDiagnosticsChange: (on: boolean) => void;
  /** Applying simulated weather reboots the emulator to clear watchface fetch
   * caches; the backend reboot leaves the VNC canvas pointing at the dead qemu,
   * so the renderer must reconnect afterwards (same as "Clear emulator"). Called
   * only when sim:set reports it rebooted. */
  onWeatherRefreshReconnect?: () => void | Promise<void>;
  /** Called BEFORE the sim:set round-trip so the EmulatorView can suppress the
   * bridge-dead/auto-relaunch path while the backend reboots the emulator (the
   * monitor would otherwise mistake the expected restart for a crash). Balanced
   * 1:1 with onWeatherRefreshEnd. */
  onWeatherRefreshBegin?: () => void;
  /** Called from a `finally` after the sim:set round-trip settles (reboot,
   * no-reboot, or failure), so the EmulatorView always balances the suppression
   * armed by onWeatherRefreshBegin. */
  onWeatherRefreshEnd?: () => void;
  /** Whether the emulator is currently live. Used by the SDK controls to decide
   * whether to auto-relaunch after swapping the SDK (so the change takes effect
   * without the user manually relaunching). */
  isEmuLive?: () => boolean;
  /** Relaunch the live emulator (used after an SDK upload/reset so the new SDK is
   * picked up). The backend tears the emulator down during the swap; this brings
   * it back on the newly-active SDK. */
  onSdkRelaunch?: () => void | Promise<void>;
  /** The live board id (Task 11) — the Language section scopes every pack call to
   * it. Provided by main.ts as `() => switcher.value`. When absent the Language
   * section is omitted (no board context to act on). */
  getBoard?: () => string;
}

const CAPTURE_DIR_KEY = "pebble-studio:capture-dir";
const BACKLIGHT_CAPTURE_KEY = "pebble-studio:backlight-capture";
const SUNLIGHT_KEY = "pebble-studio:sunlight-correction";
const BACKLIGHT_METHOD_KEY = "pebble-studio:backlight-method";
/** How the main-page Backlight button wakes the screen (EmulatorView reads this). "back" | "shake". Default "back". */
const BACKLIGHT_ACTIVATION_KEY = "pebble-studio:backlight-activation";
const DIAGNOSTICS_KEY = "pebble-studio:diagnostics";
/** Auto-relaunch the emulator when the bridge crashes (EmulatorView reads this). Default OFF. */
const AUTO_RELAUNCH_KEY = "pebble-studio:auto-relaunch";
const EMU_LOGS_KEY = "pebble-studio:emu-logs";
/** Warm-standby pre-boot on app start (Task 5). main.ts reads this to decide
 * whether to pass a `prebootBoard` to initBackend. Default OFF (opt-in). */
const PREBOOT_STARTUP_KEY = "pebble-studio:preboot-startup";

const TIME_SOURCE_KEY = "pebble-studio:time-source";
const TIME_RATE_KEY = "pebble-studio:time-rate";
const TIME_HOUR24_KEY = "pebble-studio:time-hour24";
const TIME_CUSTOM_DATE_KEY = "pebble-studio:time-custom-date"; // YYYY-MM-DD
const TIME_CUSTOM_TIME_KEY = "pebble-studio:time-custom-time"; // HH:MM

const BAT_PCT_KEY = "pebble-studio:battery-percent";
const BAT_CHG_KEY = "pebble-studio:battery-charging";
const HEALTH_BOOT_KEY = "pebble-studio:health-activate-on-boot";

/** Compute the (percent, charging) to push for a "Set battery" click. Percent is
 * clamped to 0-100; charging reflects the stored toggle. Exported for testing. */
export function buildBatteryCall(sliderValue: string, chargingStored: string | null): [number, boolean] {
  const pct = Math.max(0, Math.min(100, Number(sliderValue) || 0));
  return [pct, chargingStored === "true"];
}

/**
 * Roughly the most characters that fit on one line of caption text in the
 * Settings pane. A description longer than this is tucked behind a "?" tooltip
 * (next to its label) instead of shown inline, so the section stays uncluttered.
 */
export const ONE_LINE_DESC_CHARS = 50;

/**
 * A small "?" help icon that reveals `text` in a tooltip on hover/focus — used to
 * keep long explanations out of the always-visible layout so Settings stays
 * uncluttered. Pure CSS reveal (see `.help-tip` in app.css); keyboard-focusable.
 */
export function makeHelpTip(text: string): HTMLElement {
  const tip = document.createElement("span");
  tip.className = "help-tip";
  tip.tabIndex = 0;
  tip.setAttribute("role", "note");
  tip.setAttribute("aria-label", text);
  const glyph = document.createElement("span");
  glyph.className = "help-tip__glyph";
  glyph.textContent = "?";
  glyph.setAttribute("aria-hidden", "true");
  const bubble = document.createElement("span");
  bubble.className = "help-tip__bubble";
  bubble.textContent = text;
  tip.append(glyph, bubble);
  // Some help tips sit inside a <label> (next to a select); swallow the click so
  // tapping the "?" doesn't activate the labelled control.
  tip.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
  // The "?" sits right after the (variable-length) label, so the bubble's default
  // left-anchored position can run past the pane edge. Clamp it inside the pane
  // on hover/focus so it never overflows (no horizontal scrollbar, never cut off).
  const clamp = (): void => clampHelpBubble(tip, bubble);
  tip.addEventListener("mouseenter", clamp);
  tip.addEventListener("focus", clamp);
  return tip;
}

/**
 * Reposition a help-tip bubble so it stays within its `.settings-pane`: cap its
 * width to the pane and shift it horizontally to fit (preferring the left anchor,
 * sliding left when the trailing "?" would push it off the right edge).
 */
function clampHelpBubble(tip: HTMLElement, bubble: HTMLElement): void {
  bubble.style.left = "0px";
  const margin = 8;
  const pane = tip.closest(".settings-pane") as HTMLElement | null;
  const bounds = pane?.getBoundingClientRect();
  if (bounds) bubble.style.maxWidth = `${Math.max(160, bounds.width - margin * 2)}px`;
  const rect = bubble.getBoundingClientRect();
  const leftLimit = (bounds?.left ?? 0) + margin;
  const rightLimit = (bounds?.right ?? document.documentElement.clientWidth) - margin;
  let shift = 0;
  if (rect.right > rightLimit) shift = rightLimit - rect.right; // slide left to fit
  if (rect.left + shift < leftLimit) shift = leftLimit - rect.left; // but not past the left edge
  bubble.style.left = `${shift}px`;
}

/** UI state -> persisted SimEnvConfig. tempInput is in `units`; stored as canonical tempC. */
export function buildSimConfigFromUi(s: {
  enabled: boolean; lat: number; lon: number; name: string;
  condition: ConditionKey; tempInput: number; units: "F" | "C"; isDay: boolean;
}): SimEnvConfig {
  return {
    enabled: s.enabled,
    location: { lat: s.lat, lon: s.lon, name: s.name },
    weather: { condition: s.condition, tempC: tempInputToC(s.tempInput, s.units), isDay: s.isDay },
    units: s.units,
  };
}

/** Compose date (YYYY-MM-DD) + time (HH:MM) into a UTC-naive epoch ms (Date.UTC,
 * no host offset) — matches timeController's custom anchor contract. */
function customWallMs(dateStr: string, timeStr: string): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const t = /^(\d{2}):(\d{2})/.exec(timeStr);
  if (!d || !t) return 0;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], 0);
}
function nowDateTimeLocal(): { date: string; time: string } {
  const n = new Date();
  const pad = (x: number): string => String(x).padStart(2, "0");
  return { date: `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`,
           time: `${pad(n.getHours())}:${pad(n.getMinutes())}` };
}

/** Human-readable labels for each bindable emulator action (Keyboard section). */
const ACTION_LABELS: Record<KeyAction, string> = {
  back: "Back",
  up: "Up",
  select: "Select",
  down: "Down",
  tap: "Tap (accel)",
  shake: "Shake",
  light: "Backlight",
  screenshot: "Screenshot",
  record: "Record GIF",
};

/** Pretty-print a bound key for display (e.g. ArrowLeft → "←", " " → "Space"). */
function keyLabel(key: string | null): string {
  if (key === null) return "Unbound";
  switch (key) {
    case "ArrowLeft": return "←";
    case "ArrowUp": return "↑";
    case "ArrowRight": return "→";
    case "ArrowDown": return "↓";
    case " ": return "Space";
    case "Escape": return "Esc";
    default: return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * Settings inspector pane (Windows 11 Fluent style). Hosts app-level
 * preferences:
 *  - Theme toggle — a Fluent switch (pill track + knob, accent when on).
 *    "On" = dark theme. Persists to `pebble-studio:theme`.
 *  - Startup watch — a labeled dropdown listing every platform. It sets an
 *    explicit, persistent startup preference (persisted by main.ts to
 *    `pebble-studio:startup-watch` via the injected `onPlatformChange` callback).
 *    It is DECOUPLED from the active watch: switching watches via the top combo
 *    does not change it, and changing it here does not switch the live preview.
 *
 * The component owns the theme switch wiring (moved here from the command bar)
 * so theming stays instant via `applyTheme`.
 */
export class SettingsPane {
  readonly el: HTMLElement;
  /** Mounting point for the default-watch selector. */
  readonly defaultWatchSlot: HTMLElement;

  private themeMode: ThemeChoice;
  private readonly switchEl: HTMLButtonElement;
  private readonly watchSelect: HTMLSelectElement;
  private readonly bootSwitchEl: HTMLButtonElement;
  private readonly captureDirValue: HTMLSpanElement;
  private readonly sdkVersionValue: HTMLSpanElement;
  private readonly sdkStatus: HTMLSpanElement;
  private sdkFullBtn!: HTMLButtonElement;
  private sdkFull = false;
  private sdkSource: "custom" | "bundled" = "bundled";
  private bootMode: BootMode;
  /** Switches the live preview to the chosen platform (wired from main.ts). */
  private readonly onPlatformChange: (id: PlatformId) => void;
  /** Persists + notifies main.ts when the boot mode changes. */
  private readonly onBootModeChange: (mode: BootMode) => void;
  /** Flips EmulatorView's diagnostics overlay live (J). */
  private readonly onDiagnosticsChange: (on: boolean) => void;
  private readonly onWeatherRefreshReconnect?: () => void | Promise<void>;
  private readonly isEmuLive?: () => boolean;
  private readonly onSdkRelaunch?: () => void | Promise<void>;
  private readonly onWeatherRefreshBegin?: () => void;
  private readonly onWeatherRefreshEnd?: () => void;
  /** Board-scoped Language section (Task 11); undefined when no board getter. */
  private readonly languagePanel?: LanguagePanel;

  /** Current keybindings (Keyboard section); reloaded on reset/rebind. */
  private bindings: Bindings;
  /** Host for the per-action keybinding rows (rebuilt on change). */
  private readonly keyRowsHost: HTMLElement;
  /** Active document keydown listener while in rebind-capture mode (else null). */
  private rebindListener: ((e: KeyboardEvent) => void) | null = null;
  /** Removes ALL listeners armed for the active rebind capture (keydown + the
   * blur / outside-click cancels), or null when no capture is armed. */
  private rebindCleanup: (() => void) | null = null;

  // ── Time section controls (explicit edit-then-apply) ────────────────────
  private dateInput!: HTMLInputElement;
  // Custom time is set via no-typing dropdowns: hour + minute (+ AM/PM in 12h
  // mode). They read/write `customTime24` — see readSelectsToCanon /
  // writeCanonToSelects. The hour select's option set swaps between the 0..23
  // and 12,1..11 ranges when the 24-hour toggle flips (writeCanonToSelects).
  private hourSelect!: HTMLSelectElement;
  private minuteSelect!: HTMLSelectElement;
  private ampmSelect!: HTMLSelectElement;
  private rateSelect!: HTMLSelectElement;
  private sourceSelect!: HTMLSelectElement;
  private runBtn!: HTMLButtonElement;
  private resetBtn!: HTMLButtonElement;
  private timeStatusEl!: HTMLElement;
  /** The Settings time note; re-rendered when the shim status may have changed. */
  private timeNoteEl!: HTMLParagraphElement;
  /** Live state of the 24-hour toggle (mirrors TIME_HOUR24_KEY). */
  private hour24 = false;
  /** True when a custom field was edited but not yet applied via Run. */
  private timeDirty = false;
  /** Canonical custom time as 24-hour "HH:MM" — the source of truth. The text
   * input only DISPLAYS it (12h or 24h per the toggle); we parse edits back to
   * this so the rest of the pipeline stays unambiguous. */
  private customTime24 = "12:00";
  /** The last TimeConfig actually pushed to the watch — re-pushed (with the new
   * hour24) when the 12/24h toggle flips so the format updates without changing
   * which time mode is active. */
  private lastApplied: TimeConfig = { ...DEFAULT_TIME_CONFIG };

  constructor(
    initialTheme: ThemeChoice,
    initialPlatform: PlatformId,
    onPlatformChange: (id: PlatformId) => void,
    options: SettingsOptions,
  ) {
    this.themeMode = initialTheme;
    this.onPlatformChange = onPlatformChange;
    this.bootMode = options.initialBootMode;
    this.onBootModeChange = options.onBootModeChange;
    this.onDiagnosticsChange = options.onDiagnosticsChange;
    this.onWeatherRefreshReconnect = options.onWeatherRefreshReconnect;
    this.isEmuLive = options.isEmuLive;
    this.onSdkRelaunch = options.onSdkRelaunch;
    this.onWeatherRefreshBegin = options.onWeatherRefreshBegin;
    this.onWeatherRefreshEnd = options.onWeatherRefreshEnd;
    this.bindings = loadBindings();
    this.keyRowsHost = document.createElement("div");
    this.keyRowsHost.className = "settings-key-rows";

    this.el = document.createElement("div");
    this.el.className = "settings-pane";

    // ── Appearance section ────────────────────────────────────────────────
    const appearance = document.createElement("section");
    appearance.className = "settings-section";

    const apprHeading = document.createElement("h3");
    apprHeading.className = "settings-section-title type-body-strong";
    apprHeading.textContent = "Appearance";

    const themeRow = document.createElement("div");
    themeRow.className = "settings-row";

    const themeText = document.createElement("div");
    themeText.className = "settings-row-text";
    const themeLabel = document.createElement("span");
    themeLabel.className = "settings-row-label type-body";
    themeLabel.textContent = "Dark theme";
    const themeDesc = document.createElement("span");
    themeDesc.className = "settings-row-desc type-caption";
    themeDesc.textContent = "Switch between the light and dark Fluent themes.";
    themeText.append(themeLabel, themeDesc);

    // Fluent toggle switch (pill track + knob).
    this.switchEl = document.createElement("button");
    this.switchEl.type = "button";
    this.switchEl.className = "fluent-switch";
    this.switchEl.setAttribute("role", "switch");
    this.switchEl.setAttribute("aria-label", "Dark theme");
    const knob = document.createElement("span");
    knob.className = "fluent-switch-knob";
    knob.setAttribute("aria-hidden", "true");
    this.switchEl.appendChild(knob);
    this.switchEl.addEventListener("click", () => this.toggleTheme());

    themeRow.append(themeText, this.switchEl);
    appearance.append(apprHeading, themeRow);

    // ── Default watch section ─────────────────────────────────────────────
    const watch = document.createElement("section");
    watch.className = "settings-section";

    const watchHeader = document.createElement("div");
    watchHeader.className = "settings-section-header";
    const watchHeading = document.createElement("h3");
    watchHeading.className = "settings-section-title type-body-strong";
    watchHeading.textContent = "Default watch";
    watchHeader.append(
      watchHeading,
      makeHelpTip("Which watch Pebble Studio opens on launch. Switching the active watch from the top bar won't change this."),
    );

    // Container hosting the labeled "Startup watch" dropdown.
    this.defaultWatchSlot = document.createElement("div");
    this.defaultWatchSlot.className = "settings-default-watch";
    this.defaultWatchSlot.id = "settings-default-watch";

    const watchControl = document.createElement("label");
    watchControl.className = "settings-watch-control";

    const watchLabel = document.createElement("span");
    watchLabel.className = "settings-watch-label type-body";
    watchLabel.textContent = "Startup watch";

    this.watchSelect = document.createElement("select");
    this.watchSelect.className = "settings-watch-select";
    const validInitial = PLATFORMS.some((p) => p.id === initialPlatform)
      ? initialPlatform
      : PLATFORMS[0].id;
    for (const p of PLATFORMS) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      if (p.id === validInitial) opt.selected = true;
      this.watchSelect.appendChild(opt);
    }
    this.watchSelect.addEventListener("change", () => {
      // Persistence + combo sync are centralized in the injected callback.
      this.onPlatformChange(this.watchSelect.value as PlatformId);
    });

    watchControl.append(watchLabel, this.watchSelect);
    this.defaultWatchSlot.appendChild(watchControl);

    // Boot mode row: Auto/Manual Fluent switch ("on" = auto-boot on selection;
    // "off" = manual, load chrome and wait for Launch). Default Manual.
    const bootRow = document.createElement("div");
    bootRow.className = "settings-row";

    const bootText = document.createElement("div");
    bootText.className = "settings-row-text";
    const bootLabelLine = document.createElement("div");
    bootLabelLine.className = "settings-row-labelline";
    const bootLabel = document.createElement("span");
    bootLabel.className = "settings-row-label type-body";
    bootLabel.textContent = "Auto-boot on switch";
    bootLabelLine.append(
      bootLabel,
      makeHelpTip("On: boot when a model is selected. Off: load the chrome and wait for Launch."),
    );
    bootText.append(bootLabelLine);

    this.bootSwitchEl = document.createElement("button");
    this.bootSwitchEl.type = "button";
    this.bootSwitchEl.className = "fluent-switch";
    this.bootSwitchEl.setAttribute("role", "switch");
    this.bootSwitchEl.setAttribute("aria-label", "Auto-boot on switch");
    const bootKnob = document.createElement("span");
    bootKnob.className = "fluent-switch-knob";
    bootKnob.setAttribute("aria-hidden", "true");
    this.bootSwitchEl.appendChild(bootKnob);
    this.bootSwitchEl.addEventListener("click", () => this.toggleBootMode());

    bootRow.append(bootText, this.bootSwitchEl);

    // Pre-boot on app start (Task 5): warm-boot the startup watch in the
    // background right after launch so the first Launch attaches near-instantly.
    // main.ts reads PREBOOT_STARTUP_KEY at startup and passes the board to
    // initBackend when this is on. Default OFF (opt-in).
    const prebootRow = this.makeSwitchRow(
      "Pre-boot emulator on app start",
      "Start the last-used watch booting in the background as soon as the app opens, so your first Launch is near-instant. Off by default; turn on for instant first launches.",
      localStorage.getItem(PREBOOT_STARTUP_KEY) === "true", // default OFF (opt-in)
      (on) => localStorage.setItem(PREBOOT_STARTUP_KEY, on ? "true" : "false"),
    );

    watch.append(watchHeader, this.defaultWatchSlot, bootRow, prebootRow);

    // ── Time section ──────────────────────────────────────────────────────
    const time = document.createElement("section");
    time.className = "settings-section";

    const timeHeading = document.createElement("h3");
    timeHeading.className = "settings-section-title type-body-strong";
    timeHeading.textContent = "Time";

    // One-time migration: split the legacy combined datetime-local key.
    const legacyCustom = localStorage.getItem("pebble-studio:time-custom");
    if (
      legacyCustom &&
      localStorage.getItem(TIME_CUSTOM_DATE_KEY) === null &&
      localStorage.getItem(TIME_CUSTOM_TIME_KEY) === null
    ) {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(legacyCustom);
      if (m) {
        localStorage.setItem(TIME_CUSTOM_DATE_KEY, m[1]);
        localStorage.setItem(TIME_CUSTOM_TIME_KEY, m[2]);
      }
      localStorage.removeItem("pebble-studio:time-custom");
    }

    // Time source dropdown (System / Custom).
    const sourceControl = document.createElement("label");
    sourceControl.className = "settings-watch-control";
    const sourceLabel = document.createElement("span");
    sourceLabel.className = "settings-watch-label type-body";
    sourceLabel.textContent = "Time source";
    this.sourceSelect = document.createElement("select");
    this.sourceSelect.className = "settings-watch-select";
    // Two mutually-exclusive intents: live host time, or a fixed custom date/time.
    // System greys out the custom date/time/rate controls.
    for (const [value, text] of [
      ["system", "System"],
      ["custom", "Custom date & time"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      this.sourceSelect.appendChild(opt);
    }
    // Coerce a stored "zone" source (removed feature) back to "system" so an
    // upgrading user isn't stranded in a mode that no longer exists.
    {
      const storedSource = localStorage.getItem(TIME_SOURCE_KEY);
      this.sourceSelect.value = storedSource === "custom" ? "custom" : "system";
    }
    sourceControl.append(sourceLabel, this.sourceSelect);

    // Custom date input (enabled only when source === "custom").
    const dateControl = document.createElement("label");
    dateControl.className = "settings-watch-control";
    const dateLabel = document.createElement("span");
    dateLabel.className = "settings-watch-label type-body";
    dateLabel.textContent = "Custom date";
    this.dateInput = document.createElement("input");
    this.dateInput.type = "date";
    this.dateInput.className = "settings-watch-select";
    // Wide-open range: the clock shim takes any date in the 32-bit era — no
    // ±22-day offset limit anymore (that cap only applies in legacy fallback).
    this.dateInput.min = "1970-01-01";
    this.dateInput.max = "2099-12-31";
    dateControl.append(dateLabel, this.dateInput);

    // Custom time input (enabled only when source === "custom"). No typing: an
    // hour + minute (+ AM/PM in 12h mode) trio of dropdowns. We avoid a native
    // <input type="time"> because Chromium renders its 12h/24h purely from the
    // OS locale and ignores our toggle; these selects let the 24-hour-clock
    // switch control the format. They read/write the canonical `customTime24`
    // (see readSelectsToCanon / writeCanonToSelects); the hour-option set + the
    // AM/PM visibility are rebuilt for the active mode in writeCanonToSelects.
    const timeControl = document.createElement("div");
    timeControl.className = "settings-watch-control";
    const timeInputLabel = document.createElement("span");
    timeInputLabel.className = "settings-watch-label type-body";
    timeInputLabel.textContent = "Custom time";

    // Row holding the hour/minute/AM-PM selects side-by-side (right-aligned to
    // match the single control they replace).
    const timeSelects = document.createElement("div");
    timeSelects.className = "settings-time-selects";

    this.hourSelect = document.createElement("select");
    this.hourSelect.className = "settings-watch-select";
    this.hourSelect.setAttribute("aria-label", "Hour");
    // Options are populated by writeCanonToSelects (24h: 00..23; 12h: 12,1..11).

    this.minuteSelect = document.createElement("select");
    this.minuteSelect.className = "settings-watch-select";
    this.minuteSelect.setAttribute("aria-label", "Minute");
    for (let mi = 0; mi < 60; mi++) {
      const opt = document.createElement("option");
      opt.value = String(mi);
      opt.textContent = String(mi).padStart(2, "0");
      this.minuteSelect.appendChild(opt);
    }

    this.ampmSelect = document.createElement("select");
    this.ampmSelect.className = "settings-watch-select";
    this.ampmSelect.setAttribute("aria-label", "AM or PM");
    for (const value of ["AM", "PM"]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      this.ampmSelect.appendChild(opt);
    }

    timeSelects.append(this.hourSelect, this.minuteSelect, this.ampmSelect);
    timeControl.append(timeInputLabel, timeSelects);

    // Rate dropdown (Custom only): Frozen / 1× / 2× / 4× / 10×. Rates drive the
    // emulator's clock shim — exact multipliers, and Frozen stops seconds too
    // (see timeController's control-file contract).
    const rateControl = document.createElement("label");
    rateControl.className = "settings-watch-control";
    const rateLabel = document.createElement("span");
    rateLabel.className = "settings-watch-label type-body";
    rateLabel.textContent = "Rate";
    this.rateSelect = document.createElement("select");
    this.rateSelect.className = "settings-watch-select";
    for (const [value, text] of [
      ["frozen", "Frozen"], ["1x", "1×"], ["2x", "2×"], ["4x", "4×"], ["10x", "10×"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      this.rateSelect.appendChild(opt);
    }
    rateControl.append(rateLabel, this.rateSelect);

    // 24-hour clock toggle (default OFF — 12-hour is the default).
    const hour24Row = this.makeSwitchRow(
      "24-hour clock",
      "Sets what clock_is_24h_style() returns on the watch, and the custom-time input format.",
      localStorage.getItem(TIME_HOUR24_KEY) === "true", // default OFF (12h)
      (on) => {
        this.hour24 = on;
        localStorage.setItem(TIME_HOUR24_KEY, on ? "true" : "false");
        // Swap the hour-select range (0..23 ↔ 12,1..11) + AM/PM visibility and
        // reselect the SAME instant — convert via customTime24, don't lose it.
        this.writeCanonToSelects(this.customTime24);
        // The 12/24h format is independent of the time offset, so toggling it
        // must push to the watch RIGHT NOW (re-applying the active config so the
        // emu-time-format command actually fires) — not wait for a later "Run".
        // Preserve the staged-edit ("dirty") indicator across the re-push.
        const wasDirty = this.timeDirty;
        this.applyConfig({ ...this.lastApplied, hour24: on });
        this.timeDirty = wasDirty;
        this.renderTimeStatus();
      },
    );

    // Run / Reset buttons + status line.
    const timeButtons = document.createElement("div");
    timeButtons.className = "settings-time-buttons";
    this.runBtn = document.createElement("button");
    this.runBtn.type = "button";
    this.runBtn.className = "lib-pick-btn";
    this.runBtn.textContent = "Run custom time";
    this.resetBtn = document.createElement("button");
    this.resetBtn.type = "button";
    this.resetBtn.className = "lib-pick-btn";
    this.resetBtn.textContent = "Reset to system";
    timeButtons.append(this.runBtn, this.resetBtn);

    this.timeStatusEl = document.createElement("div");
    this.timeStatusEl.className = "settings-time-status";

    // ── Apply model: edits only mark dirty; watch changes on explicit apply. ──
    this.sourceSelect.addEventListener("change", () => {
      const mode = this.sourceSelect.value;
      if (mode === "custom") {
        // Fixed instant in the host zone: prefill now, default Frozen.
        // Explicit apply via "Run custom time" — don't push on select.
        const { date, time: t } = nowDateTimeLocal();
        this.dateInput.value = date;
        localStorage.setItem(TIME_CUSTOM_DATE_KEY, date);
        this.setCustomTime24(t); // t is canonical 24h "HH:MM"
        this.rateSelect.value = "frozen";
        localStorage.setItem(TIME_RATE_KEY, "frozen");
        localStorage.setItem(TIME_SOURCE_KEY, "custom");
        this.timeDirty = true;
        this.syncTimeEnabled();
        this.renderTimeStatus();
      } else {
        this.selectSystem();
      }
    });

    const markDirty = (): void => {
      this.timeDirty = true;
      this.renderTimeStatus();
    };
    this.dateInput.addEventListener("change", () => {
      localStorage.setItem(TIME_CUSTOM_DATE_KEY, this.dateInput.value);
      markDirty();
    });
    // Any of the three selects changing rebuilds the canonical 24h value from
    // the current (hour, minute, AM/PM + mode) and stages it. No text to
    // re-render, so setCustomTime24(canon, false) just persists.
    const onTimeSelectChange = (): void => {
      this.setCustomTime24(this.readSelectsToCanon(), false);
      markDirty();
    };
    this.hourSelect.addEventListener("change", onTimeSelectChange);
    this.minuteSelect.addEventListener("change", onTimeSelectChange);
    this.ampmSelect.addEventListener("change", onTimeSelectChange);
    this.rateSelect.addEventListener("change", () => {
      localStorage.setItem(TIME_RATE_KEY, this.rateSelect.value);
      markDirty();
    });
    this.runBtn.addEventListener("click", () => this.applyCustom());
    this.resetBtn.addEventListener("click", () => {
      this.sourceSelect.value = "system";
      this.selectSystem();
    });

    this.timeNoteEl = document.createElement("p");
    this.timeNoteEl.className = "settings-row-desc type-caption";
    this.refreshTimeNote(); // sets the base copy now; appends fallback info async
    // ensureTimeShim runs at boot (emu:start), so the shim status becomes
    // meaningful right after a launch — apps-changed fires post-boot.
    window.addEventListener("pebble-studio:apps-changed", () => this.refreshTimeNote());

    time.append(
      timeHeading, sourceControl, dateControl, timeControl, rateControl,
      hour24Row, timeButtons, this.timeStatusEl, this.timeNoteEl,
    );

    // ── Battery section ───────────────────────────────────────────────────
    const battery = document.createElement("section");
    battery.className = "settings-section";
    const batteryHeading = document.createElement("h3");
    batteryHeading.className = "settings-section-title type-body-strong";
    batteryHeading.textContent = "Battery";

    // Persisted UI state only (NOT reapplied to the emulator on boot — one-shot).
    const rawPct = localStorage.getItem(BAT_PCT_KEY);
    const startPct = rawPct !== null ? Math.max(0, Math.min(100, Number(rawPct) || 0)) : 80;

    const pctControl = document.createElement("label");
    pctControl.className = "settings-watch-control";
    const pctLabel = document.createElement("span");
    pctLabel.className = "settings-watch-label type-body";
    pctLabel.textContent = "Level";
    const pctReadout = document.createElement("span");
    pctReadout.className = "type-body";
    pctReadout.textContent = `${startPct}%`;
    const pctSlider = document.createElement("input");
    pctSlider.type = "range";
    pctSlider.min = "0";
    pctSlider.max = "100";
    pctSlider.step = "1";
    pctSlider.value = String(startPct);

    let batteryDirty = false;
    const batBtn = document.createElement("button");
    batBtn.type = "button";
    batBtn.className = "lib-pick-btn";
    batBtn.textContent = "Set battery";
    const batStatus = document.createElement("span");
    batStatus.className = "settings-row-desc type-caption";
    const markBatteryDirty = (): void => {
      batteryDirty = true;
      batBtn.classList.toggle("lib-pick-btn--needs-apply", true);
    };

    pctSlider.addEventListener("input", () => {
      pctReadout.textContent = `${pctSlider.value}%`;
      localStorage.setItem(BAT_PCT_KEY, pctSlider.value);
      markBatteryDirty();
    });
    pctControl.append(pctLabel, pctSlider, pctReadout);

    const chargeRow = this.makeSwitchRow(
      "Charging",
      "Show the watch as plugged in / charging.",
      localStorage.getItem(BAT_CHG_KEY) === "true",
      (on) => { localStorage.setItem(BAT_CHG_KEY, on ? "true" : "false"); markBatteryDirty(); },
    );

    batBtn.addEventListener("click", () => {
      // Pre-check liveness: setBattery against a stopped watch fails with a raw IPC
      // error. Give a friendly nudge instead. (Absent injection = assume live.)
      if (this.isEmuLive && !this.isEmuLive()) {
        batStatus.textContent = "Watch isn't running — launch it first.";
        return;
      }
      const [pct, charging] = buildBatteryCall(pctSlider.value, localStorage.getItem(BAT_CHG_KEY));
      batStatus.textContent = "Setting…";
      void window.studio.setBattery(pct, charging)
        .then(() => {
          batStatus.textContent = `Set to ${pct}%${charging ? " (charging)" : ""}.`;
          batteryDirty = false;
          batBtn.classList.remove("lib-pick-btn--needs-apply");
        })
        .catch((e: unknown) => { batStatus.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`; });
    });

    battery.append(batteryHeading, pctControl, chargeRow, batBtn, batStatus);

    // ── Simulated environment (location + weather) ────────────────────────
    const sim = document.createElement("section");
    sim.className = "settings-section";
    const simHeading = document.createElement("h3");
    simHeading.className = "settings-section-title type-body-strong";
    simHeading.textContent = "Simulated location & weather";

    // Live UI state, seeded from the default preset and hydrated from sim:get below.
    const simState = {
      enabled: DEFAULT_SIM_ENV.enabled,
      lat: DEFAULT_SIM_ENV.location.lat,
      lon: DEFAULT_SIM_ENV.location.lon,
      name: DEFAULT_SIM_ENV.location.name,
      condition: DEFAULT_SIM_ENV.weather.condition,
      units: DEFAULT_SIM_ENV.units,
      tempInput: Math.round(tempCToDisplay(DEFAULT_SIM_ENV.weather.tempC, DEFAULT_SIM_ENV.units)),
      isDay: DEFAULT_SIM_ENV.weather.isDay,
    };

    const simApplyBtn = document.createElement("button");
    simApplyBtn.type = "button";
    simApplyBtn.className = "lib-pick-btn";
    simApplyBtn.textContent = "Apply";
    const simStatus = document.createElement("span");
    simStatus.className = "settings-row-desc type-caption";

    let simDirty = false;
    const markSimDirty = (): void => {
      simDirty = true;
      simApplyBtn.classList.toggle("lib-pick-btn--needs-apply", true);
    };

    // Enable toggle.
    const enableRow = this.makeSwitchRow(
      "Simulate location & weather",
      "Feed weather watchfaces a fixed location + synthetic weather (offline). On by default.",
      simState.enabled,
      (on) => { simState.enabled = on; markSimDirty(); },
    );

    // Location: preset dropdown + custom lat/lon.
    const locControl = document.createElement("label");
    locControl.className = "settings-watch-control";
    const locLabel = document.createElement("span");
    locLabel.className = "settings-watch-label type-body";
    locLabel.textContent = "Location";
    const locSelect = document.createElement("select");
    locSelect.className = "settings-watch-select";
    for (const c of PRESET_CITIES) {
      const o = document.createElement("option");
      o.value = c.name; o.textContent = c.name; locSelect.appendChild(o);
    }
    const customOpt = document.createElement("option");
    customOpt.value = "__custom__"; customOpt.textContent = "Custom…";
    locSelect.appendChild(customOpt);
    locSelect.value = simState.name;
    locControl.append(locLabel, locSelect);

    // Stacked: "Coordinates" label on its own line, the lat & lon inputs full-width
    // below it (each fills half the row) so the whole value is visible.
    const customRow = document.createElement("label");
    customRow.className = "settings-watch-control settings-watch-control--stack";
    const customLabel = document.createElement("span");
    customLabel.className = "settings-watch-label type-body";
    customLabel.textContent = "Coordinates";
    const latInput = document.createElement("input");
    latInput.type = "number"; latInput.step = "0.0001"; latInput.value = String(simState.lat);
    latInput.placeholder = "lat"; latInput.title = "Latitude"; latInput.className = "settings-watch-select";
    latInput.style.flex = "1"; latInput.style.minWidth = "0";
    const lonInput = document.createElement("input");
    lonInput.type = "number"; lonInput.step = "0.0001"; lonInput.value = String(simState.lon);
    lonInput.placeholder = "lon"; lonInput.title = "Longitude"; lonInput.className = "settings-watch-select";
    lonInput.style.flex = "1"; lonInput.style.minWidth = "0";
    const coordWrap = document.createElement("div");
    coordWrap.className = "settings-time-selects";
    coordWrap.style.width = "100%";
    coordWrap.append(latInput, lonInput);
    customRow.append(customLabel, coordWrap);
    const syncCustomVisibility = (): void => { customRow.hidden = locSelect.value !== "__custom__"; };
    syncCustomVisibility();

    locSelect.addEventListener("change", () => {
      if (locSelect.value === "__custom__") {
        simState.name = "Custom";
      } else {
        const c = PRESET_CITIES.find((p) => p.name === locSelect.value)!;
        simState.name = c.name; simState.lat = c.lat; simState.lon = c.lon;
        latInput.value = String(c.lat); lonInput.value = String(c.lon);
      }
      syncCustomVisibility(); markSimDirty();
    });
    // Clamp coordinates to valid geographic ranges (±90 lat / ±180 lon) so a typo
    // can't feed an out-of-range fix to weather apps. (A sibling agent also
    // validates in the main process; this is the UI-side guard.)
    const clampNum = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    latInput.addEventListener("input", () => { simState.lat = clampNum(Number(latInput.value) || 0, -90, 90); markSimDirty(); });
    lonInput.addEventListener("input", () => { simState.lon = clampNum(Number(lonInput.value) || 0, -180, 180); markSimDirty(); });

    // Condition dropdown.
    const condControl = document.createElement("label");
    condControl.className = "settings-watch-control";
    const condLabel = document.createElement("span");
    condLabel.className = "settings-watch-label type-body";
    condLabel.textContent = "Condition";
    const condSelect = document.createElement("select");
    condSelect.className = "settings-watch-select";
    for (const c of CONDITION_OPTIONS) {
      const o = document.createElement("option");
      o.value = c.key; o.textContent = c.label; condSelect.appendChild(o);
    }
    condSelect.value = simState.condition;
    condSelect.addEventListener("change", () => {
      simState.condition = condSelect.value as ConditionKey; markSimDirty();
    });
    condControl.append(condLabel, condSelect);

    // Temperature + unit toggle.
    const tempControl = document.createElement("label");
    tempControl.className = "settings-watch-control";
    const tempLabel = document.createElement("span");
    tempLabel.className = "settings-watch-label type-body";
    tempLabel.textContent = "Temperature";
    const tempInput = document.createElement("input");
    tempInput.type = "number"; tempInput.step = "1"; tempInput.value = String(simState.tempInput);
    tempInput.className = "settings-watch-select"; tempInput.style.width = "5em";
    const unitBtn = document.createElement("button");
    unitBtn.type = "button"; unitBtn.className = "lib-pick-btn";
    unitBtn.textContent = `°${simState.units}`;
    unitBtn.title = "Toggle the unit you enter the temperature in (does not change what the watch shows)";
    unitBtn.addEventListener("click", () => {
      // Convert the current displayed value to the other unit so the meaning is preserved.
      const asC = tempInputToC(Number(tempInput.value) || 0, simState.units);
      simState.units = simState.units === "F" ? "C" : "F";
      simState.tempInput = Math.round(tempCToDisplay(asC, simState.units));
      tempInput.value = String(simState.tempInput);
      unitBtn.textContent = `°${simState.units}`;
      markSimDirty();
    });
    tempInput.addEventListener("input", () => { simState.tempInput = Number(tempInput.value) || 0; markSimDirty(); });
    const tempWrap = document.createElement("div");
    tempWrap.className = "settings-time-selects";
    tempWrap.append(tempInput, unitBtn);
    tempControl.append(tempLabel, tempWrap);

    // Day/night.
    const dayRow = this.makeSwitchRow(
      "Daytime",
      "Off = night (affects condition icon day/night variant).",
      simState.isDay,
      (on) => { simState.isDay = on; markSimDirty(); },
    );

    simApplyBtn.addEventListener("click", () => {
      const cfg = buildSimConfigFromUi(simState);
      simStatus.textContent = "Applying…";
      // Arm bridge-dead suppression BEFORE the round-trip: if the backend reboots
      // the live emulator, the health monitor would otherwise see the expected
      // restart as a crash and race an auto-relaunch against the refresh. The
      // `finally` balances this begin on EVERY exit path (reboot, no-reboot,
      // throw), so suppression is never left stuck on and never depends on the
      // reconnect handler being wired.
      this.onWeatherRefreshBegin?.();
      void window.studio.simSet(cfg)
        .then(async (res) => {
          simDirty = false;
          simApplyBtn.classList.remove("lib-pick-btn--needs-apply");
          // When live, the backend rebooted the emulator to clear watchface fetch
          // caches; reconnect the VNC canvas (it's pointing at the dead qemu) the
          // same way "Clear emulator" does, else the screen stays black.
          if (res?.rebooted) {
            simStatus.textContent = "Reloading watch to refresh weather…";
            await this.onWeatherRefreshReconnect?.();
          }
          simStatus.textContent = cfg.enabled
            ? `Active: ${cfg.location.name}, ${simState.condition}, ${simState.tempInput}°${simState.units}.`
            : "Simulation off (apps use the real network).";
        })
        .catch((e: unknown) => {
          simStatus.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
        })
        .finally(() => { this.onWeatherRefreshEnd?.(); });
    });

    sim.append(simHeading, enableRow, locControl, customRow, condControl, tempControl, dayRow, simApplyBtn, simStatus);

    // Hydrate from the persisted control file (falls back to the seeded defaults).
    void window.studio.simGet().then((cfg) => {
      simState.enabled = cfg.enabled;
      simState.lat = cfg.location.lat; simState.lon = cfg.location.lon; simState.name = cfg.location.name;
      simState.condition = cfg.weather.condition; simState.units = cfg.units;
      simState.isDay = cfg.weather.isDay;
      simState.tempInput = Math.round(tempCToDisplay(cfg.weather.tempC, cfg.units));
      // Reflect into controls.
      const known = PRESET_CITIES.some((p) => p.name === cfg.location.name);
      locSelect.value = known ? cfg.location.name : "__custom__";
      latInput.value = String(cfg.location.lat); lonInput.value = String(cfg.location.lon);
      condSelect.value = cfg.weather.condition;
      tempInput.value = String(simState.tempInput);
      unitBtn.textContent = `°${cfg.units}`;
      enableRow.setOn(cfg.enabled);
      dayRow.setOn(cfg.weather.isDay);
      syncCustomVisibility();
      simDirty = false;
      simApplyBtn.classList.remove("lib-pick-btn--needs-apply");
    }).catch(() => { /* keep seeded defaults */ });

    // ── Health section ────────────────────────────────────────────────────
    const health = document.createElement("section");
    health.className = "settings-section";
    const healthHeading = document.createElement("h3");
    healthHeading.className = "settings-section-title type-body-strong";
    healthHeading.textContent = "Health";
    const healthRow = this.makeSwitchRow(
      "Activate Pebble Health on boot (legacy boards)",
      "Auto-enables Pebble Health on the legacy boards (Pebble Classic, Pebble Time, Pebble Time Round, Pebble 2) so health-dependent watchfaces work. The newer boards (Pebble Time 2, Pebble Round 2, Pebble 2 Duo) ship with Health OFF and are always auto-activated on boot regardless of this toggle, so it doesn't affect them. Default on.",
      localStorage.getItem(HEALTH_BOOT_KEY) !== "false", // default ON
      (on) => localStorage.setItem(HEALTH_BOOT_KEY, on ? "true" : "false"),
    );
    health.append(healthHeading, healthRow);

    // ── Capture section ───────────────────────────────────────────────────
    const capture = document.createElement("section");
    capture.className = "settings-section";

    const captureHeading = document.createElement("h3");
    captureHeading.className = "settings-section-title type-body-strong";
    captureHeading.textContent = "Captures";

    const captureRow = document.createElement("div");
    captureRow.className = "settings-row";

    const captureText = document.createElement("div");
    captureText.className = "settings-row-text";
    const captureLabel = document.createElement("span");
    captureLabel.className = "settings-row-label type-body";
    captureLabel.textContent = "Capture location";
    this.captureDirValue = document.createElement("span");
    this.captureDirValue.className = "settings-row-desc type-caption";
    const storedDir = localStorage.getItem(CAPTURE_DIR_KEY);
    this.captureDirValue.textContent = storedDir ?? "Downloads (default)";
    captureText.append(captureLabel, this.captureDirValue);

    const captureBtn = document.createElement("button");
    captureBtn.type = "button";
    captureBtn.className = "lib-pick-btn";
    captureBtn.textContent = "Change…";
    captureBtn.addEventListener("click", () => void this.pickCaptureDir());

    captureRow.append(captureText, captureBtn);
    capture.append(captureHeading, captureRow);

    // K: "Backlight during capture" — briefly presses Back to wake the backlight
    // so captures aren't dim. Default ON (persisted; CaptureBar reads it directly).
    const blCaptureRow = this.makeSwitchRow(
      "Backlight during capture",
      "Briefly presses Back to wake the backlight so captures aren't dim; can navigate inside an app.",
      localStorage.getItem(BACKLIGHT_CAPTURE_KEY) !== "false", // default ON
      (on) => {
        localStorage.setItem(BACKLIGHT_CAPTURE_KEY, on ? "true" : "false");
      },
    );

    // Backlight keepalive method selector (Back-press / Motion / Off).
    const blMethodControl = document.createElement("label");
    blMethodControl.className = "settings-watch-control";
    const blMethodLabelLine = document.createElement("div");
    blMethodLabelLine.className = "settings-row-labelline";
    const blMethodLabel = document.createElement("span");
    blMethodLabel.className = "settings-watch-label type-body";
    blMethodLabel.textContent = "Backlight keepalive";
    blMethodLabelLine.append(
      blMethodLabel,
      makeHelpTip("Back-press wakes the screen but navigates menus; Motion wakes it but triggers shake handlers; Off disables the keepalive."),
    );
    const blMethodSelect = document.createElement("select");
    blMethodSelect.className = "settings-watch-select settings-watch-select--compact";
    for (const [value, text] of [
      ["back", "Back-press"],
      ["motion", "Motion"],
      ["off", "Off"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      blMethodSelect.appendChild(opt);
    }
    blMethodSelect.value = localStorage.getItem(BACKLIGHT_METHOD_KEY) ?? "off";
    blMethodSelect.addEventListener("change", () => {
      const value = blMethodSelect.value;
      localStorage.setItem(BACKLIGHT_METHOD_KEY, value);
      void window.studio.backlightMethod(value).catch(() => {});
      if (value !== "off") {
        void window.studio.backlightAlways(true).catch(() => {});
      } else {
        void window.studio.backlightAlways(false).catch(() => {});
      }
    });
    blMethodControl.append(blMethodLabelLine, blMethodSelect);

    // Apply persisted backlight method to main on startup. Default OFF — the
    // keepalive sends real Back presses / motion taps that can navigate menus,
    // so it should be opt-in, not on by default.
    const initialBlMethod = localStorage.getItem(BACKLIGHT_METHOD_KEY) ?? "off";
    void window.studio.backlightMethod(initialBlMethod).catch(() => {});
    void window.studio.backlightAlways(initialBlMethod !== "off").catch(() => {});

    // Backlight BUTTON activation method (separate from the keepalive above):
    // controls only the one-shot "Backlight" button on the main page. No IPC at
    // change time — EmulatorView reads this localStorage key when the button is
    // clicked. Default "back".
    const blBtnControl = document.createElement("label");
    blBtnControl.className = "settings-watch-control";
    const blBtnLabelLine = document.createElement("div");
    blBtnLabelLine.className = "settings-row-labelline";
    const blBtnLabel = document.createElement("span");
    blBtnLabel.className = "settings-watch-label type-body";
    blBtnLabel.textContent = "Backlight button";
    blBtnLabelLine.append(
      blBtnLabel,
      makeHelpTip("What the main-page Backlight button does: Back button reliably wakes the screen but can navigate inside an app; Shake sends a motion nudge (won't navigate)."),
    );
    const blBtnSelect = document.createElement("select");
    blBtnSelect.className = "settings-watch-select settings-watch-select--compact";
    for (const [value, text] of [
      ["back", "Back button"],
      ["shake", "Shake"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      blBtnSelect.appendChild(opt);
    }
    blBtnSelect.value = localStorage.getItem(BACKLIGHT_ACTIVATION_KEY) ?? "back";
    blBtnSelect.addEventListener("change", () => {
      localStorage.setItem(BACKLIGHT_ACTIVATION_KEY, blBtnSelect.value);
    });
    blBtnControl.append(blBtnLabelLine, blBtnSelect);

    const sunlightRow = this.makeSwitchRow(
      "Sunlight color correction",
      "Match the real Pebble display: mutes the emulator's vivid colors in screenshots & GIFs. Default off.",
      localStorage.getItem(SUNLIGHT_KEY) === "true", // default OFF
      (on) => localStorage.setItem(SUNLIGHT_KEY, on ? "true" : "false"),
    );

    const liveSunlightRow = this.makeSwitchRow(
      "Sunlight correction on live view",
      "Also apply the sunlight colour correction to the live emulator screen (not just screenshots & GIFs). Default off.",
      localStorage.getItem(LIVE_SUNLIGHT_KEY) === "true", // default OFF
      (on) => {
        localStorage.setItem(LIVE_SUNLIGHT_KEY, on ? "true" : "false");
        window.dispatchEvent(new Event(LIVE_SUNLIGHT_EVENT));
      },
    );

    capture.append(blCaptureRow, sunlightRow, liveSunlightRow, blMethodControl, blBtnControl);

    // ── Keyboard section (I) ──────────────────────────────────────────────
    const keyboard = document.createElement("section");
    keyboard.className = "settings-section";

    const keyHeader = document.createElement("div");
    keyHeader.className = "settings-section-header";
    const keyHeading = document.createElement("h3");
    keyHeading.className = "settings-section-title type-body-strong";
    keyHeading.textContent = "Keyboard";
    keyHeader.append(keyHeading, makeHelpTip("Bind keys to emulator buttons (active only while live)."));

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "lib-pick-btn";
    resetBtn.textContent = "Reset to defaults";
    resetBtn.addEventListener("click", () => this.resetBindings());

    keyboard.append(keyHeader, this.keyRowsHost, resetBtn);
    this.renderKeyRows();

    // ── Advanced section (J) ──────────────────────────────────────────────
    const advanced = document.createElement("section");
    advanced.className = "settings-section";

    const advHeading = document.createElement("h3");
    advHeading.className = "settings-section-title type-body-strong";
    advHeading.textContent = "Advanced";

    const diagRow = this.makeSwitchRow(
      "Diagnostics",
      "Show emulator FPS and detailed boot steps.",
      localStorage.getItem(DIAGNOSTICS_KEY) === "on", // default OFF
      (on) => {
        localStorage.setItem(DIAGNOSTICS_KEY, on ? "on" : "off");
        this.onDiagnosticsChange(on);
        window.dispatchEvent(new Event("pebble-studio:diagnostics-changed"));
      },
    );

    const throttleRow = this.makeSwitchRow(
      "Full speed when unfocused",
      "Keep the emulator rendering at full rate even when the window isn't focused.",
      localStorage.getItem("pebble-studio:no-throttle") !== "false", // default ON
      (on) => {
        localStorage.setItem("pebble-studio:no-throttle", on ? "true" : "false");
        void window.studio.setBackgroundThrottling(!on).catch(() => {});
      },
    );

    // v0.0.13.5: the qemu-pebble phone bridge (pypkjs) can crash on its own —
    // an upstream fragility, surfaced as "⚠ Emulator stopped responding". When
    // this is ON, the app reboots the emulator and reinstalls your apps for you
    // (capped, so a repeatedly-crashing bridge falls back to the manual Relaunch
    // button instead of looping). EmulatorView reads this key directly.
    const autoRelaunchRow = this.makeSwitchRow(
      "Auto-relaunch if the emulator crashes",
      "If the emulator bridge stops responding, automatically reboot it and reinstall your apps (falls back to manual Relaunch after repeated crashes).",
      localStorage.getItem(AUTO_RELAUNCH_KEY) === "true", // default OFF
      (on) => {
        localStorage.setItem(AUTO_RELAUNCH_KEY, on ? "true" : "false");
      },
    );

    const emuLogsRow = this.makeSwitchRow(
      "Show emulator logs",
      "Stream the watch app logs (the output of pebble install --logs) in a collapsible panel under the emulator. Default on.",
      localStorage.getItem(EMU_LOGS_KEY) !== "false", // default ON (v3.0.7, #6)
      (on) => {
        localStorage.setItem(EMU_LOGS_KEY, on ? "true" : "false");
        window.dispatchEvent(new Event("pebble-studio:emu-logs-changed"));
      },
    );

    advanced.append(advHeading, diagRow, throttleRow, autoRelaunchRow, emuLogsRow);

    // ── SDK section ───────────────────────────────────────────────────────
    // Show the active Pebble SDK and let the user replace it with their own
    // (a .tar.bz2 SDK or its folder) without a developer editing files. The
    // uploaded SDK persists across relaunches until replaced or reset, and keeps
    // the full PebbleOS launcher (the bundled unlocked firmware is overlaid).
    const sdk = document.createElement("section");
    sdk.className = "settings-section";
    // Heading carries a "?" help icon — the explanation lives in its tooltip so
    // the section stays uncluttered (no always-on paragraph of text).
    const sdkHeader = document.createElement("div");
    sdkHeader.className = "settings-section-header";
    const sdkHeading = document.createElement("h3");
    sdkHeading.className = "settings-section-title type-body-strong";
    sdkHeading.textContent = "Pebble SDK";
    sdkHeader.append(
      sdkHeading,
      makeHelpTip(
        "Upload a Pebble SDK (a sdk-core .tar.bz2 / .zip archive or its folder) to replace the bundled one. " +
          "An uploaded SDK runs its own firmware as-is; use \"Make full-featured\" to overlay the full PebbleOS " +
          "launcher (Settings, Health, full menu) — Studio reports any watch model it can't do without downgrading. " +
          "Relaunch the emulator to use a newly installed SDK.",
      ),
    );

    // Version on its own row (full width) so it can never collide with the buttons.
    const sdkRow = document.createElement("div");
    sdkRow.className = "settings-row";
    const sdkText = document.createElement("div");
    sdkText.className = "settings-row-text";
    const sdkLabel = document.createElement("span");
    sdkLabel.className = "settings-row-label type-body";
    sdkLabel.textContent = "Current version";
    this.sdkVersionValue = document.createElement("span");
    this.sdkVersionValue.className = "settings-row-desc type-caption";
    this.sdkVersionValue.textContent = "Checking…";
    sdkText.append(sdkLabel, this.sdkVersionValue);
    sdkRow.append(sdkText);

    // Buttons on their own row below the version.
    const sdkUploadBtn = document.createElement("button");
    sdkUploadBtn.type = "button";
    sdkUploadBtn.className = "lib-pick-btn";
    sdkUploadBtn.textContent = "Upload archive…";
    // Windows' open dialog cannot pick a file and a directory in one picker, so
    // an extracted SDK tree needs its own entry point into the same install path.
    const sdkUploadDirBtn = document.createElement("button");
    sdkUploadDirBtn.type = "button";
    sdkUploadDirBtn.className = "lib-pick-btn";
    sdkUploadDirBtn.textContent = "Upload folder…";
    const sdkResetBtn = document.createElement("button");
    sdkResetBtn.type = "button";
    sdkResetBtn.className = "lib-pick-btn";
    sdkResetBtn.textContent = "Reset to bundled";
    const sdkFullBtn = document.createElement("button");
    sdkFullBtn.type = "button";
    sdkFullBtn.className = "lib-pick-btn";
    sdkFullBtn.textContent = "Make full-featured";
    sdkFullBtn.disabled = true; // enabled by applySdkInfo when a custom SDK is active
    this.sdkFullBtn = sdkFullBtn;

    const sdkBtns = document.createElement("div");
    sdkBtns.className = "settings-row-actions";
    sdkBtns.append(sdkUploadBtn, sdkUploadDirBtn, sdkFullBtn, sdkResetBtn);

    this.sdkStatus = document.createElement("span");
    this.sdkStatus.className = "settings-row-desc type-caption";

    const sdkAllBtns = [sdkUploadBtn, sdkUploadDirBtn, sdkFullBtn, sdkResetBtn];
    sdkUploadBtn.addEventListener("click", () => void this.uploadSdk("file", sdkAllBtns));
    sdkUploadDirBtn.addEventListener("click", () => void this.uploadSdk("folder", sdkAllBtns));
    sdkFullBtn.addEventListener("click", () => void this.toggleFullLauncher(sdkAllBtns));
    sdkResetBtn.addEventListener("click", () => void this.resetSdk(sdkUploadBtn, sdkResetBtn));

    sdk.append(sdkHeader, sdkRow, sdkBtns, this.sdkStatus);
    void this.refreshSdkInfo();

    // ── Language section (Task 11) ────────────────────────────────────────
    // Board-specific (unlike the other sections), so it's its own component: it
    // reloads for the live board on `pebble-studio:board-changed` and refreshes
    // the active language on Live (`pebble-studio:apps-changed`). Omitted when no
    // board getter was injected (no board context to act on).
    this.languagePanel = options.getBoard
      ? new LanguagePanel(options.getBoard)
      : undefined;
    const language = this.languagePanel?.el;

    this.el.append(
      appearance, watch, time, battery, sim,
      ...(language ? [language] : []),
      health, capture, sdk, keyboard, advanced,
    );

    this.syncSwitch();
    this.syncBootSwitch();

    // ── Time startup: restore persisted values, then apply once (resume). ──
    {
      const stored = nowDateTimeLocal();
      this.dateInput.value = localStorage.getItem(TIME_CUSTOM_DATE_KEY) ?? stored.date;
      // Legacy values were written by a native time input (always 24h "HH:MM"),
      // so parseTimeInput accepts them; fall back to "now" if absent/invalid.
      this.customTime24 = parseTimeInput(localStorage.getItem(TIME_CUSTOM_TIME_KEY) ?? "") ?? stored.time;
      this.rateSelect.value = localStorage.getItem(TIME_RATE_KEY) ?? "1x";
      this.hour24 = localStorage.getItem(TIME_HOUR24_KEY) === "true"; // default OFF (12h)
      this.writeCanonToSelects(this.customTime24);
      // Time source always starts at System on launch — a persisted Custom time
      // (often a now-stale timestamp) shouldn't silently drive the watch across
      // restarts. The custom field values above stay populated so switching to
      // Custom restores the last-used date/time/timezone.
      this.sourceSelect.value = "system";
      localStorage.setItem(TIME_SOURCE_KEY, "system");
      this.syncTimeEnabled();
      this.applySystem();
      this.renderTimeStatus();
    }

    // Apply persisted throttle setting on startup.
    void window.studio.setBackgroundThrottling(
      localStorage.getItem("pebble-studio:no-throttle") === "false",
    ).catch(() => {});
  }

  /** Current state of the 24-hour toggle. */
  private read24h(): boolean {
    return this.hour24;
  }

  /** Read the three custom-time selects and fold them back into the canonical
   * 24h "HH:MM". In 24h mode the hour select already holds 0..23 (AM/PM hidden +
   * ignored); in 12h mode it holds 1..12 and we combine it with AM/PM. */
  private readSelectsToCanon(): string {
    const minute = +this.minuteSelect.value;
    if (this.hour24) {
      const pad = (n: number): string => String(n).padStart(2, "0");
      return `${pad(+this.hourSelect.value)}:${pad(minute)}`;
    }
    return from12h(+this.hourSelect.value, minute, this.ampmSelect.value as "AM" | "PM");
  }

  /** Rebuild the hour-select option set + AM/PM visibility for the current
   * `hour24`, then set all three selects from the canonical value (converting
   * 24h→12h when needed). This is the selects' analogue of the old text-input
   * refresh: called whenever hour24 or the canonical value changes. */
  private writeCanonToSelects(canon: string): void {
    // (a) Rebuild the hour options for the active mode: 24h → 00..23 (value ==
    //     label); 12h → 12 first, then 1..11 (value is the 1..12 hour).
    this.hourSelect.replaceChildren();
    if (this.hour24) {
      for (let h = 0; h < 24; h++) {
        const opt = document.createElement("option");
        opt.value = String(h);
        opt.textContent = String(h).padStart(2, "0");
        this.hourSelect.appendChild(opt);
      }
    } else {
      for (const h of [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
        const opt = document.createElement("option");
        opt.value = String(h);
        opt.textContent = String(h);
        this.hourSelect.appendChild(opt);
      }
    }
    // AM/PM only makes sense (and is only visible) in 12-hour mode.
    this.ampmSelect.hidden = this.hour24;

    // (b) Select the values matching the canonical time for this mode.
    const m = /^(\d{1,2}):(\d{2})$/.exec(canon.trim());
    const h24 = m ? +m[1] : 0;
    const minute = m ? +m[2] : 0;
    if (this.hour24) {
      this.hourSelect.value = String(h24);
    } else {
      const { hour, ampm } = to12h(canon);
      this.hourSelect.value = String(hour);
      this.ampmSelect.value = ampm;
    }
    this.minuteSelect.value = String(minute);
  }

  /** Set the canonical custom time (24h "HH:MM"), persist it, and (when
   * `display`) refresh the selects from it. `display` is false on a change that
   * originated FROM the selects (nothing to re-render); true when the value
   * changes underneath them (prefill / programmatic set). */
  private setCustomTime24(canon: string, display = true): void {
    this.customTime24 = canon;
    localStorage.setItem(TIME_CUSTOM_TIME_KEY, canon);
    if (display) this.writeCanonToSelects(canon);
  }

  /**
   * Enable/disable + show/hide controls for the active Time source mode, so the
   * UI only ever exposes inputs that make sense:
   *  - System: everything greyed; no buttons (auto-applies).
   *  - Custom: date/time/rate enabled; Run + Reset.
   */
  private syncTimeEnabled(): void {
    const custom = this.sourceSelect.value === "custom";
    this.dateInput.disabled = !custom;
    this.hourSelect.disabled = !custom;
    this.minuteSelect.disabled = !custom;
    this.ampmSelect.disabled = !custom;
    this.rateSelect.disabled = !custom;
    this.runBtn.disabled = !custom;
    // Contextual buttons: Run + Reset only in Custom; hidden in System.
    this.runBtn.hidden = !custom;
    this.resetBtn.hidden = !custom;
    this.resetBtn.textContent = "Reset to system";
  }

  /** Push a config to the emulator and notify the badge. Single apply path. */
  private applyConfig(cfg: TimeConfig): void {
    this.lastApplied = cfg;
    void window.studio.setTimeConfig(cfg)
      // Applying may have (re)attempted the shim deploy — re-query its status so
      // the note reflects whether the legacy fallback is in play.
      .then(() => this.refreshTimeNote())
      .catch(() => {});
    window.dispatchEvent(new CustomEvent("pebble-studio:time-changed", { detail: cfg }));
    this.timeDirty = false;
  }

  /** (Re)render the Settings time note. The base copy describes the v0.0.13
   * clock-shim model; when main reports the shim is unavailable we append the
   * legacy offset-fallback limits. Base text is set synchronously so the note is
   * never empty while the status query is in flight. */
  private refreshTimeNote(): void {
    const base =
      "Custom time uses a clock shim inside the emulator: any date (1970–2099), " +
      "Frozen truly freezes (seconds too), and 2×/4×/10× run exactly that fast. " +
      "Custom time re-applies on relaunch.";
    this.timeNoteEl.textContent = base;
    void window.studio.timeStatus()
      .then(({ shim, checked }) => {
        // Only warn after a real probe failed — `checked` is false until the
        // first boot/apply actually runs ensureTimeShim, and the unchecked
        // default must not read as "unavailable" at app launch.
        if (checked && !shim) {
          this.timeNoteEl.textContent =
            base +
            " (Advanced time control unavailable on this system — falling back " +
            "to offset mode: ±22 days, minute granularity.)";
        }
      })
      .catch(() => {}); // status unavailable → keep the base copy
  }

  /** Apply System time (host clock) — called from source→system & Reset. */
  private applySystem(): void {
    localStorage.setItem(TIME_SOURCE_KEY, "system");
    this.applyConfig({
      ...DEFAULT_TIME_CONFIG,
      source: "system",
      rate: "1x",
      timezone: detectHostTimezone(),
      hour24: this.read24h(),
      customWallMs: 0,
    });
  }

  /** Switch back to System, apply it, resync UI. */
  private selectSystem(): void {
    this.applySystem();
    this.syncTimeEnabled();
    this.renderTimeStatus();
  }

  /** Build the custom TimeConfig from the current control values. Custom is always
   * host-local (the timezone control is greyed in Custom mode). */
  private buildCustomConfig(): TimeConfig {
    return {
      ...DEFAULT_TIME_CONFIG,
      source: "custom",
      rate: this.rateSelect.value as Rate,
      timezone: detectHostTimezone(),
      hour24: this.read24h(),
      customWallMs: customWallMs(this.dateInput.value, this.customTime24),
    };
  }

  /** Apply the edited custom time (Run custom time button). */
  private applyCustom(): void {
    // Refuse an empty/invalid date: customWallMs() would return 0 and silently
    // drive the watch to 1970-01-01 (indistinguishable from the "random time" bug
    // class). The time comes from selects (always valid), so only the date can be
    // bad. Prompt in the status line instead of applying.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.dateInput.value)) {
      this.timeStatusEl.textContent = "Pick a valid date before running custom time.";
      this.timeStatusEl.classList.add("settings-time-status--edited");
      this.timeStatusEl.classList.remove("settings-time-status--running");
      return;
    }
    localStorage.setItem(TIME_CUSTOM_DATE_KEY, this.dateInput.value);
    localStorage.setItem(TIME_CUSTOM_TIME_KEY, this.customTime24);
    localStorage.setItem(TIME_RATE_KEY, this.rateSelect.value);
    localStorage.setItem(TIME_SOURCE_KEY, "custom");
    this.applyConfig(this.buildCustomConfig());
    this.renderTimeStatus();
  }

  /** Update the status line under the Run/Reset buttons. */
  private renderTimeStatus(): void {
    const el = this.timeStatusEl;
    const mode = this.sourceSelect.value;
    // Highlight the apply button whenever a staged custom config (date, time, or
    // rate) hasn't been pushed to the watch yet, so it's obvious that editing a
    // control — e.g. switching the rate to 2×/4×/10× — does nothing until "Run
    // custom time" is pressed. Platform-agnostic: the apply model is shared.
    this.runBtn.classList.toggle(
      "lib-pick-btn--needs-apply",
      mode === "custom" && this.timeDirty,
    );
    if (mode !== "custom") {
      el.textContent = "";
      el.classList.remove("settings-time-status--edited", "settings-time-status--running");
      return;
    }
    if (this.timeDirty) {
      el.textContent = 'Edited — press "Run custom time" to apply';
      el.classList.add("settings-time-status--edited");
      el.classList.remove("settings-time-status--running");
      return;
    }
    const ms = customWallMs(this.dateInput.value, this.customTime24);
    const d = new Date(ms);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    let timeStr: string;
    if (this.hour24) {
      timeStr = `${String(d.getUTCHours()).padStart(2, "0")}:${mm}`;
    } else {
      let h = d.getUTCHours();
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12;
      if (h === 0) h = 12;
      timeStr = `${h}:${mm} ${ampm}`;
    }
    const when = `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${timeStr}`;
    const rate = this.rateSelect.value;
    const suffix =
      rate === "frozen" ? "frozen"
      : rate === "1x" ? "ticking at 1×"
      : `running at ${rate}`;
    el.textContent = `● ${when} · ${suffix}`;
    el.classList.add("settings-time-status--running");
    el.classList.remove("settings-time-status--edited");
  }

  /**
   * Build a labeled "settings-row" with a Fluent switch on the right. `onToggle`
   * receives the new boolean state (called after the switch flips).
   */
  private makeSwitchRow(
    label: string,
    desc: string,
    initialOn: boolean,
    onToggle: (on: boolean) => void,
  ): SwitchRow {
    const row = document.createElement("div");
    row.className = "settings-row";

    const text = document.createElement("div");
    text.className = "settings-row-text";
    const labelLine = document.createElement("div");
    labelLine.className = "settings-row-labelline";
    const labelEl = document.createElement("span");
    labelEl.className = "settings-row-label type-body";
    labelEl.textContent = label;
    // A blurb longer than one line goes behind a "?" tooltip right after the
    // label's last word; a short one stays inline below the label. (The tooltip
    // clamps itself inside the pane, so the trailing "?" can't cause overflow.)
    const longDesc = desc.length > ONE_LINE_DESC_CHARS;
    labelLine.append(labelEl);
    if (longDesc) labelLine.append(makeHelpTip(desc));
    text.append(labelLine);
    if (!longDesc) {
      const descEl = document.createElement("span");
      descEl.className = "settings-row-desc type-caption";
      descEl.textContent = desc;
      text.append(descEl);
    }

    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "fluent-switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", label);
    const knob = document.createElement("span");
    knob.className = "fluent-switch-knob";
    knob.setAttribute("aria-hidden", "true");
    sw.appendChild(knob);

    let on = initialOn;
    const sync = (): void => {
      sw.classList.toggle("fluent-switch--on", on);
      sw.setAttribute("aria-checked", on ? "true" : "false");
    };
    sw.addEventListener("click", () => {
      on = !on;
      sync();
      onToggle(on);
    });
    sync();

    row.append(text, sw);
    (row as unknown as SwitchRow).setOn = (next: boolean): void => {
      on = next;
      sync();
    };
    return row as unknown as SwitchRow;
  }

  /** (Re)build the per-action keybinding rows from the current bindings. */
  private renderKeyRows(): void {
    this.keyRowsHost.replaceChildren();
    for (const action of ACTIONS) {
      const row = document.createElement("div");
      row.className = "settings-row";

      const text = document.createElement("div");
      text.className = "settings-row-text";
      const labelEl = document.createElement("span");
      labelEl.className = "settings-row-label type-body";
      labelEl.textContent = ACTION_LABELS[action];
      const keyEl = document.createElement("span");
      keyEl.className = "settings-row-desc type-caption";
      keyEl.textContent = keyLabel(this.bindings[action]);
      text.append(labelEl, keyEl);

      const rebindBtn = document.createElement("button");
      rebindBtn.type = "button";
      rebindBtn.className = "lib-pick-btn";
      rebindBtn.textContent = "Rebind";
      rebindBtn.addEventListener("click", () => this.startRebind(action, rebindBtn));

      row.append(text, rebindBtn);
      this.keyRowsHost.appendChild(row);
    }
  }

  /**
   * Enter rebind-capture for an action: the next keydown (other than Esc) becomes
   * that action's key, persists, and notifies EmulatorView. Esc cancels.
   */
  private startRebind(action: KeyAction, btn: HTMLButtonElement): void {
    this.cancelRebind(); // only one capture at a time
    btn.textContent = "Press a key…";
    btn.classList.add("lib-pick-btn--active");

    // Tear down the capture and repaint the rows (restoring the "Rebind" label and
    // reflecting any binding change). `rebound` gates the change notification.
    const finish = (rebound: boolean): void => {
      this.cancelRebind();
      this.renderKeyRows();
      if (rebound) window.dispatchEvent(new Event("pebble-studio:keybindings-changed"));
    };

    const onKey = (e: KeyboardEvent): void => {
      // The pane was detached (user navigated away — showPane replaces the DOM but
      // not this document listener). Abandon WITHOUT hijacking the key, so it can't
      // silently become the new binding.
      if (!btn.isConnected) { finish(false); return; }
      // Ignore a bare modifier press: a modifier-only key can never fire an action
      // (handleKeyDown bails on any modifier chord), so it would be a dead binding.
      // Stay armed for the actual key.
      if (isBareModifierKey(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { finish(false); return; } // cancelled
      // applyRebind clears the key from any other action first, so a key maps to
      // exactly one action (resolveAction otherwise silently keeps the first).
      this.bindings = applyRebind(this.bindings, action, e.key);
      saveBindings(this.bindings);
      finish(true);
    };
    // Cancel if the window loses focus or the user clicks anywhere but this button
    // (e.g. the nav rail to switch panes) — so the capture can't stay armed and
    // swallow the next keystroke anywhere in the app.
    const onBlur = (): void => finish(false);
    const onDown = (e: MouseEvent): void => {
      if (e.target !== btn && !btn.contains(e.target as Node)) finish(false);
    };

    this.rebindListener = onKey;
    this.rebindCleanup = (): void => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mousedown", onDown, true);
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("mousedown", onDown, true);
  }

  /** Tear down any active rebind-capture listeners/state (idempotent). */
  private cancelRebind(): void {
    if (this.rebindCleanup) { this.rebindCleanup(); this.rebindCleanup = null; }
    this.rebindListener = null;
  }

  /** Reset bindings to defaults, persist, notify EmulatorView, refresh rows. */
  private resetBindings(): void {
    this.cancelRebind();
    this.bindings = { ...DEFAULT_BINDINGS };
    saveBindings(this.bindings);
    this.renderKeyRows();
    window.dispatchEvent(new Event("pebble-studio:keybindings-changed"));
  }

  /**
   * Reflect an externally-driven platform change (e.g. the top combo) so this
   * dropdown's shown value tracks the live preview. Does NOT re-fire onChange.
   */
  setPlatform(id: PlatformId): void {
    if (this.watchSelect.value !== id) this.watchSelect.value = id;
  }

  /** Toggle Auto/Manual boot, persist + notify main.ts via the injected callback. */
  private toggleBootMode(): void {
    this.bootMode = this.bootMode === "auto" ? "manual" : "auto";
    this.syncBootSwitch();
    this.onBootModeChange(this.bootMode);
  }

  private syncBootSwitch(): void {
    const on = this.bootMode === "auto";
    this.bootSwitchEl.classList.toggle("fluent-switch--on", on);
    this.bootSwitchEl.setAttribute("aria-checked", on ? "true" : "false");
  }

  /**
   * Pick a new capture directory via the native folder picker. On success, point
   * main at it, persist the choice, and update the displayed path. Cancelling
   * (null) leaves the current setting untouched.
   */
  private async pickCaptureDir(): Promise<void> {
    let dir: string | null;
    try {
      dir = await window.studio.pickDirectory();
    } catch (err) {
      console.warn("[settings] pickDirectory failed (ignored):", err);
      return;
    }
    if (!dir) return;
    try {
      await window.studio.setCaptureDir(dir);
    } catch (err) {
      console.error("[settings] setCaptureDir failed:", err);
      return;
    }
    localStorage.setItem(CAPTURE_DIR_KEY, dir);
    this.captureDirValue.textContent = dir;
  }

  /** Format "4.17 (custom · full launcher)" / "4.9.169 (bundled · full launcher)". */
  private sdkLabel(info: { version: string; source: "custom" | "bundled"; fullLauncher: boolean }): string {
    const fw = info.fullLauncher ? "full launcher" : "stock firmware";
    return `${info.version} (${info.source} · ${fw})`;
  }

  /** Render the active SDK's version + drive the full-launcher toggle's state. */
  private applySdkInfo(info: { version: string; source: "custom" | "bundled"; fullLauncher: boolean }): void {
    this.sdkVersionValue.textContent = this.sdkLabel(info);
    this.sdkFull = info.fullLauncher;
    this.sdkSource = info.source;
    const custom = info.source === "custom";
    this.sdkFullBtn.disabled = !custom;
    this.sdkFullBtn.textContent = info.fullLauncher ? "Revert to stock firmware" : "Make full-featured";
    this.sdkFullBtn.title = custom
      ? info.fullLauncher
        ? "Restore this SDK's own firmware."
        : "Overlay the full PebbleOS launcher onto this SDK."
      : "Upload a custom SDK to toggle the full launcher.";
  }

  /** Query main for the active SDK and render it. */
  private async refreshSdkInfo(): Promise<void> {
    try {
      this.applySdkInfo(await window.studio.sdkInfo());
    } catch (err) {
      console.warn("[settings] sdkInfo failed (ignored):", err);
      this.sdkVersionValue.textContent = "unknown";
      this.sdkFullBtn.disabled = true;
    }
  }

  /** If the emulator was live when an SDK swap ran, the backend tore it down — so
   * relaunch it to pick up the new SDK (and to restore a working emulator even if
   * the swap failed). No-op when it wasn't running. */
  private async maybeRelaunchAfterSdk(wasLive: boolean): Promise<void> {
    if (!wasLive) return;
    try {
      await this.onSdkRelaunch?.();
    } catch (err) {
      console.warn("[settings] relaunch after SDK change failed:", err);
    }
  }

  /** Upload + install a user-chosen SDK (Replace & persist + full-launcher overlay). */
  private async uploadSdk(mode: "file" | "folder", btns: HTMLButtonElement[]): Promise<void> {
    const wasLive = this.isEmuLive?.() ?? false;
    for (const b of btns) b.disabled = true;
    this.sdkStatus.textContent = "Installing…";
    let relaunch = false;
    try {
      const info = await window.studio.sdkInstall(mode);
      if (info == null) {
        this.sdkStatus.textContent = ""; // cancelled — emulator untouched
      } else {
        this.applySdkInfo(info);
        relaunch = wasLive; // a real install tore the live emulator down
        const tail = wasLive ? " Relaunching the emulator…" : " Relaunch the emulator to use it.";
        this.sdkStatus.textContent =
          `Installed SDK ${info.version}. Use "Make full-featured" to add the full PebbleOS launcher.${tail}`;
      }
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
      this.sdkStatus.textContent = `Upload failed: ${reason || "see console"}`;
      relaunch = wasLive; // the backend may have torn the emulator down before failing
    } finally {
      for (const b of btns) b.disabled = false;
      // The re-enable loop above includes sdkFullBtn; keep it disabled on a
      // bundled SDK (a failed/cancelled upload never ran applySdkInfo, so the
      // loop would otherwise leave the toggle spuriously enabled).
      this.sdkFullBtn.disabled = this.sdkSource !== "custom";
    }
    await this.maybeRelaunchAfterSdk(relaunch);
  }

  /** Drop the user override and return to the bundled SDK. */
  private async resetSdk(uploadBtn: HTMLButtonElement, resetBtn: HTMLButtonElement): Promise<void> {
    const wasLive = this.isEmuLive?.() ?? false;
    uploadBtn.disabled = true;
    resetBtn.disabled = true;
    this.sdkStatus.textContent = "Resetting…";
    try {
      const info = await window.studio.sdkReset();
      this.applySdkInfo(info);
      const tail = wasLive ? " Relaunching the emulator…" : " Relaunch the emulator to use it.";
      this.sdkStatus.textContent = `Reset to bundled SDK ${info.version}.${tail}`;
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
      this.sdkStatus.textContent = `Reset failed: ${reason || "see console"}`;
    } finally {
      uploadBtn.disabled = false;
      resetBtn.disabled = false;
    }
    await this.maybeRelaunchAfterSdk(wasLive);
  }

  /** Turn a per-board apply report into a user-facing line (surfaces the
   * "deviated too far from v4.13" skip). */
  private describeApply(
    report: { applied: string[]; skippedNewer: string[]; skippedMissing: string[] },
    wasLive: boolean,
  ): string {
    const tail = wasLive ? " Relaunching the emulator…" : " Relaunch the emulator to use it.";
    if (report.applied.length === 0) {
      if (report.skippedNewer.length > 0) {
        return `Couldn't add the full launcher — this SDK is newer than our bundled launcher firmware ` +
          `(${report.skippedNewer.join(", ")}), so swapping it in would downgrade those models. Kept the SDK's own firmware.`;
      }
      return "Nothing to apply — this SDK doesn't ship the watch models we have launcher firmware for.";
    }
    let msg = `Full launcher applied to ${report.applied.join(", ")}.`;
    if (report.skippedNewer.length > 0) {
      msg += ` ${report.skippedNewer.join(", ")} kept their own firmware (newer than our launcher).`;
    }
    return msg + tail;
  }

  /** Apply or revert the full launcher on the active custom SDK. */
  private async toggleFullLauncher(btns: HTMLButtonElement[]): Promise<void> {
    const wasLive = this.isEmuLive?.() ?? false;
    const goingFull = !this.sdkFull;
    for (const b of btns) b.disabled = true;
    this.sdkStatus.textContent = goingFull ? "Adding the full launcher…" : "Reverting to stock firmware…";
    try {
      if (goingFull) {
        const { report, info } = await window.studio.sdkApplyFullLauncher();
        this.applySdkInfo(info);
        this.sdkStatus.textContent = this.describeApply(report, wasLive);
      } else {
        const { info } = await window.studio.sdkRevertFullLauncher();
        this.applySdkInfo(info);
        const tail = wasLive ? " Relaunching the emulator…" : " Relaunch the emulator to use it.";
        this.sdkStatus.textContent = `Reverted to the SDK's own firmware.${tail}`;
      }
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
      this.sdkStatus.textContent = `${goingFull ? "Apply" : "Revert"} failed: ${reason || "see console"}`;
    } finally {
      for (const b of btns) b.disabled = false;
    }
    await this.maybeRelaunchAfterSdk(wasLive);
  }

  private toggleTheme(): void {
    this.themeMode = this.themeMode === "dark" ? "light" : "dark";
    applyTheme(resolveTheme(this.themeMode as ThemeMode));
    localStorage.setItem("pebble-studio:theme", this.themeMode);
    this.syncSwitch();
  }

  private syncSwitch(): void {
    const on = this.themeMode === "dark";
    this.switchEl.classList.toggle("fluent-switch--on", on);
    this.switchEl.setAttribute("aria-checked", on ? "true" : "false");
  }
}
