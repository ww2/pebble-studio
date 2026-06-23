import { resolveTheme, applyTheme, type ThemeMode } from "../theme.js";
import type { PlatformId } from "../../shared/types.js";
import { PLATFORMS } from "../../main/backend/emulatorRegistry.js"; // pure module, bundled by Vite
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  loadBindings,
  saveBindings,
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
  private bootMode: BootMode;
  /** Switches the live preview to the chosen platform (wired from main.ts). */
  private readonly onPlatformChange: (id: PlatformId) => void;
  /** Persists + notifies main.ts when the boot mode changes. */
  private readonly onBootModeChange: (mode: BootMode) => void;
  /** Flips EmulatorView's diagnostics overlay live (J). */
  private readonly onDiagnosticsChange: (on: boolean) => void;
  private readonly onWeatherRefreshReconnect?: () => void | Promise<void>;
  private readonly onWeatherRefreshBegin?: () => void;
  private readonly onWeatherRefreshEnd?: () => void;

  /** Current keybindings (Keyboard section); reloaded on reset/rebind. */
  private bindings: Bindings;
  /** Host for the per-action keybinding rows (rebuilt on change). */
  private readonly keyRowsHost: HTMLElement;
  /** Active document keydown listener while in rebind-capture mode (else null). */
  private rebindListener: ((e: KeyboardEvent) => void) | null = null;

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

    const watchHeading = document.createElement("h3");
    watchHeading.className = "settings-section-title type-body-strong";
    watchHeading.textContent = "Default watch";

    const watchDesc = document.createElement("p");
    watchDesc.className = "settings-row-desc type-caption";
    watchDesc.textContent =
      "Which watch Pebble Studio opens on launch. Switching the active watch from the top bar won't change this.";

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
    const bootLabel = document.createElement("span");
    bootLabel.className = "settings-row-label type-body";
    bootLabel.textContent = "Auto-boot on switch";
    const bootDesc = document.createElement("span");
    bootDesc.className = "settings-row-desc type-caption";
    bootDesc.textContent = "On: boot when a model is selected. Off: load the chrome and wait for Launch.";
    bootText.append(bootLabel, bootDesc);

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

    watch.append(watchHeading, watchDesc, this.defaultWatchSlot, bootRow);

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

    const customRow = document.createElement("label");
    customRow.className = "settings-watch-control";
    const customLabel = document.createElement("span");
    customLabel.className = "settings-watch-label type-body";
    customLabel.textContent = "Coordinates";
    const latInput = document.createElement("input");
    latInput.type = "number"; latInput.step = "0.0001"; latInput.value = String(simState.lat);
    latInput.placeholder = "lat"; latInput.title = "Latitude"; latInput.className = "settings-watch-select"; latInput.style.width = "7em";
    const lonInput = document.createElement("input");
    lonInput.type = "number"; lonInput.step = "0.0001"; lonInput.value = String(simState.lon);
    lonInput.placeholder = "lon"; lonInput.title = "Longitude"; lonInput.className = "settings-watch-select"; lonInput.style.width = "7em";
    const coordWrap = document.createElement("div");
    coordWrap.className = "settings-time-selects";
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
    latInput.addEventListener("input", () => { simState.lat = Number(latInput.value) || 0; markSimDirty(); });
    lonInput.addEventListener("input", () => { simState.lon = Number(lonInput.value) || 0; markSimDirty(); });

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
      "Auto-enables Pebble Health on the legacy boards (Pebble Classic, Pebble Time, Pebble Time Round, Pebble 2) so health-dependent watchfaces work. The newer boards (Pebble Time 2, Pebble Round 2, Pebble 2 Duo) have Pebble Health on by default, so this toggle doesn't affect them. Default on.",
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
    const blMethodLabel = document.createElement("span");
    blMethodLabel.className = "settings-watch-label type-body";
    blMethodLabel.textContent = "Backlight keepalive";
    const blMethodSelect = document.createElement("select");
    blMethodSelect.className = "settings-watch-select";
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
    blMethodControl.append(blMethodLabel, blMethodSelect);

    const blMethodDesc = document.createElement("p");
    blMethodDesc.className = "settings-row-desc type-caption";
    blMethodDesc.textContent =
      "Back-press wakes the screen but navigates menus; Motion wakes it but triggers shake handlers; Off disables the keepalive.";

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
    const blBtnLabel = document.createElement("span");
    blBtnLabel.className = "settings-watch-label type-body";
    blBtnLabel.textContent = "Backlight button";
    const blBtnSelect = document.createElement("select");
    blBtnSelect.className = "settings-watch-select";
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
    blBtnControl.append(blBtnLabel, blBtnSelect);

    const blBtnDesc = document.createElement("p");
    blBtnDesc.className = "settings-row-desc type-caption";
    blBtnDesc.textContent =
      "What the main-page Backlight button does: Back button reliably wakes the screen but can navigate inside an app; Shake sends a motion nudge (won't navigate).";

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

    capture.append(blCaptureRow, sunlightRow, liveSunlightRow, blMethodControl, blMethodDesc, blBtnControl, blBtnDesc);

    // ── Keyboard section (I) ──────────────────────────────────────────────
    const keyboard = document.createElement("section");
    keyboard.className = "settings-section";

    const keyHeading = document.createElement("h3");
    keyHeading.className = "settings-section-title type-body-strong";
    keyHeading.textContent = "Keyboard";

    const keyDesc = document.createElement("p");
    keyDesc.className = "settings-row-desc type-caption";
    keyDesc.textContent = "Bind keys to emulator buttons (active only while live).";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "lib-pick-btn";
    resetBtn.textContent = "Reset to defaults";
    resetBtn.addEventListener("click", () => this.resetBindings());

    keyboard.append(keyHeading, keyDesc, this.keyRowsHost, resetBtn);
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

    advanced.append(advHeading, diagRow, throttleRow, autoRelaunchRow);

    this.el.append(appearance, watch, time, battery, sim, health, capture, keyboard, advanced);

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
    const labelEl = document.createElement("span");
    labelEl.className = "settings-row-label type-body";
    labelEl.textContent = label;
    const descEl = document.createElement("span");
    descEl.className = "settings-row-desc type-caption";
    descEl.textContent = desc;
    text.append(labelEl, descEl);

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

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      this.cancelRebind();
      if (e.key === "Escape") {
        this.renderKeyRows(); // cancelled — restore the button label
        return;
      }
      this.bindings[action] = e.key;
      saveBindings(this.bindings);
      this.renderKeyRows();
      window.dispatchEvent(new Event("pebble-studio:keybindings-changed"));
    };
    this.rebindListener = onKey;
    document.addEventListener("keydown", onKey, true);
  }

  /** Tear down any active rebind-capture listener/state (idempotent). */
  private cancelRebind(): void {
    if (this.rebindListener) {
      document.removeEventListener("keydown", this.rebindListener, true);
      this.rebindListener = null;
    }
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
