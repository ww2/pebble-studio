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
import { formatTimeDisplay, parseTimeInput, timePlaceholder } from "../timeFormat.js";

type ThemeChoice = "light" | "dark";
type BootMode = "auto" | "manual";

/** Options for the boot-mode + capture-location + diagnostics controls (owned by main.ts). */
interface SettingsOptions {
  initialBootMode: BootMode;
  onBootModeChange: (mode: BootMode) => void;
  /** Flip EmulatorView's diagnostics overlay live when the toggle changes (J). */
  onDiagnosticsChange: (on: boolean) => void;
}

const CAPTURE_DIR_KEY = "pebble-studio:capture-dir";
const BACKLIGHT_CAPTURE_KEY = "pebble-studio:backlight-capture";
const BACKLIGHT_METHOD_KEY = "pebble-studio:backlight-method";
const DIAGNOSTICS_KEY = "pebble-studio:diagnostics";

const TIME_SOURCE_KEY = "pebble-studio:time-source";
const TIME_RATE_KEY = "pebble-studio:time-rate";
const TIME_TZ_KEY = "pebble-studio:time-tz";
const TIME_HOUR24_KEY = "pebble-studio:time-hour24";
const TIME_CUSTOM_DATE_KEY = "pebble-studio:time-custom-date"; // YYYY-MM-DD
const TIME_CUSTOM_TIME_KEY = "pebble-studio:time-custom-time"; // HH:MM
/** Synthetic timezone option used to display "System" while source=system. */
const TZ_SYSTEM = "__system";

const COMMON_ZONES = [
  "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago",
  "America/New_York", "America/Sao_Paulo", "Europe/London", "Europe/Paris",
  "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Shanghai",
  "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];

/** First common zone that isn't the host — the default landing zone when entering
 * Timezone mode, so the mode is immediately meaningful (not just "host again"). */
function firstNonHostZone(hostTz: string): string {
  return COMMON_ZONES.find((z) => z !== hostTz) ?? "UTC";
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
 *  - Default watch — a labeled "Startup watch" dropdown listing every platform.
 *    Its value is bound to the persisted platform (`pebble-studio:platform`);
 *    changing it persists the new value and switches the live preview via the
 *    injected `onPlatformChange` callback (the same path the top combo uses).
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

  /** Current keybindings (Keyboard section); reloaded on reset/rebind. */
  private bindings: Bindings;
  /** Host for the per-action keybinding rows (rebuilt on change). */
  private readonly keyRowsHost: HTMLElement;
  /** Active document keydown listener while in rebind-capture mode (else null). */
  private rebindListener: ((e: KeyboardEvent) => void) | null = null;

  // ── Time section controls (explicit edit-then-apply) ────────────────────
  private dateInput!: HTMLInputElement;
  private timeInput!: HTMLInputElement;
  private rateSelect!: HTMLSelectElement;
  private tzSelect!: HTMLSelectElement;
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
    watchDesc.textContent = "Choose the watch model to boot on launch.";

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

    const hostTz = detectHostTimezone();

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
    // Three mutually-exclusive intents: live host time, a fixed custom date/time,
    // or live time in another timezone. Each greys out whatever it doesn't use.
    for (const [value, text] of [
      ["system", "System"],
      ["custom", "Custom date & time"],
      ["zone", "Timezone"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      this.sourceSelect.appendChild(opt);
    }
    this.sourceSelect.value = localStorage.getItem(TIME_SOURCE_KEY) ?? "system";
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

    // Custom time input (enabled only when source === "custom").
    const timeControl = document.createElement("label");
    timeControl.className = "settings-watch-control";
    const timeInputLabel = document.createElement("span");
    timeInputLabel.className = "settings-watch-label type-body";
    timeInputLabel.textContent = "Custom time";
    // Plain text input (NOT type=time): Chromium's native time picker renders
    // 12h/24h from the OS locale and ignores our toggle, so we format/parse it
    // ourselves (see timeFormat.ts) to honor the 24-hour-clock switch.
    this.timeInput = document.createElement("input");
    this.timeInput.type = "text";
    this.timeInput.className = "settings-watch-select";
    this.timeInput.autocomplete = "off";
    timeControl.append(timeInputLabel, this.timeInput);

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

    // Timezone dropdown: synthetic "System" first, then COMMON_ZONES (+ host if missing).
    const tzControl = document.createElement("label");
    tzControl.className = "settings-watch-control";
    const tzLabel = document.createElement("span");
    tzLabel.className = "settings-watch-label type-body";
    tzLabel.textContent = "Timezone";
    this.tzSelect = document.createElement("select");
    this.tzSelect.className = "settings-watch-select";
    const sysOpt = document.createElement("option");
    sysOpt.value = TZ_SYSTEM;
    sysOpt.textContent = "System";
    this.tzSelect.appendChild(sysOpt);
    const zones = [...COMMON_ZONES];
    if (!zones.includes(hostTz)) zones.unshift(hostTz);
    for (const z of zones) {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z;
      this.tzSelect.appendChild(opt);
    }
    tzControl.append(tzLabel, this.tzSelect);

    // 24-hour clock toggle (default OFF — 12-hour is the default).
    const hour24Row = this.makeSwitchRow(
      "24-hour clock",
      "Sets what clock_is_24h_style() returns on the watch, and the custom-time input format.",
      localStorage.getItem(TIME_HOUR24_KEY) === "true", // default OFF (12h)
      (on) => {
        this.hour24 = on;
        localStorage.setItem(TIME_HOUR24_KEY, on ? "true" : "false");
        this.applyHour24ToInput();
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
        // Fixed instant in the host zone: prefill now, default Frozen. Custom is
        // host-local, so the timezone control stays on "System" (and greyed).
        // Explicit apply via "Run custom time" — don't push on select.
        const { date, time: t } = nowDateTimeLocal();
        this.dateInput.value = date;
        localStorage.setItem(TIME_CUSTOM_DATE_KEY, date);
        this.setCustomTime24(t); // t is canonical 24h "HH:MM"
        this.rateSelect.value = "frozen";
        localStorage.setItem(TIME_RATE_KEY, "frozen");
        this.tzSelect.value = TZ_SYSTEM;
        localStorage.setItem(TIME_SOURCE_KEY, "custom");
        this.timeDirty = true;
        this.syncTimeEnabled();
        this.renderTimeStatus();
      } else if (mode === "zone") {
        // Live time elsewhere: custom date/time make no sense here, so reset them
        // (they're greyed). Pick a real zone (default the first common zone that
        // isn't the host) and apply immediately — this mode is live, not staged.
        const { date, time: t } = nowDateTimeLocal();
        this.dateInput.value = date;
        this.setCustomTime24(t); // canonical 24h "HH:MM" (greyed in zone mode)
        this.rateSelect.value = "1x";
        if (this.tzSelect.value === TZ_SYSTEM) {
          const stored = localStorage.getItem(TIME_TZ_KEY);
          this.tzSelect.value =
            stored && stored !== TZ_SYSTEM && stored !== hostTz ? stored : firstNonHostZone(hostTz);
        }
        localStorage.setItem(TIME_SOURCE_KEY, "zone");
        localStorage.setItem(TIME_TZ_KEY, this.tzSelect.value);
        this.timeDirty = false;
        this.syncTimeEnabled();
        this.applyZone();
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
    this.timeInput.addEventListener("change", () => {
      const parsed = parseTimeInput(this.timeInput.value);
      if (parsed === null) {
        // Unparseable — restore the last good value rather than store garbage.
        this.applyHour24ToInput();
        return;
      }
      this.setCustomTime24(parsed); // also normalizes the displayed text
      markDirty();
    });
    this.rateSelect.addEventListener("change", () => {
      localStorage.setItem(TIME_RATE_KEY, this.rateSelect.value);
      markDirty();
    });
    this.tzSelect.addEventListener("change", () => {
      localStorage.setItem(TIME_TZ_KEY, this.tzSelect.value);
      // The timezone control is only enabled in Timezone mode, where a change
      // applies live. Selecting the synthetic "System" zone returns to System.
      if (this.sourceSelect.value === "zone") {
        if (this.tzSelect.value === TZ_SYSTEM) {
          this.sourceSelect.value = "system";
          this.selectSystem();
        } else {
          this.applyZone();
          this.renderTimeStatus();
        }
      }
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
      timeHeading, sourceControl, dateControl, timeControl, rateControl, tzControl,
      hour24Row, timeButtons, this.timeStatusEl, this.timeNoteEl,
    );

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

    capture.append(blCaptureRow, blMethodControl, blMethodDesc);

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

    advanced.append(advHeading, diagRow, throttleRow);

    this.el.append(appearance, watch, time, capture, keyboard, advanced);

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
      this.applyHour24ToInput();
      // Time source always starts at System on launch — a persisted Custom time
      // (often a now-stale timestamp) shouldn't silently drive the watch across
      // restarts. The custom field values above stay populated so switching to
      // Custom restores the last-used date/time/timezone.
      this.sourceSelect.value = "system";
      localStorage.setItem(TIME_SOURCE_KEY, "system");
      this.tzSelect.value = TZ_SYSTEM;
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

  /** Re-render the custom-time text input from the canonical value in the format
   * the toggle selects (24h "HH:MM" or 12h "h:mm AM/PM"), and update the example
   * placeholder. Called whenever hour24 or the canonical value changes. */
  private applyHour24ToInput(): void {
    this.timeInput.value = formatTimeDisplay(this.customTime24, this.hour24);
    this.timeInput.placeholder = timePlaceholder(this.hour24);
  }

  /** Set the canonical custom time (24h "HH:MM"), persist it, and re-render the
   * input. `display` controls whether the visible input is refreshed (skip while
   * the user is mid-edit so we don't fight their typing). */
  private setCustomTime24(canon: string, display = true): void {
    this.customTime24 = canon;
    localStorage.setItem(TIME_CUSTOM_TIME_KEY, canon);
    if (display) this.applyHour24ToInput();
  }

  /**
   * Enable/disable + show/hide controls for the active Time source mode, so the
   * UI only ever exposes inputs that make sense:
   *  - System: everything greyed; no buttons (auto-applies).
   *  - Custom: date/time enabled, timezone greyed (host-local); Run + Reset.
   *  - Timezone: timezone enabled, date/time greyed; "Reset to host zone".
   */
  private syncTimeEnabled(): void {
    const mode = this.sourceSelect.value;
    const custom = mode === "custom";
    const zone = mode === "zone";
    this.dateInput.disabled = !custom;
    this.timeInput.disabled = !custom;
    this.rateSelect.disabled = !custom;
    this.tzSelect.disabled = !zone;
    this.runBtn.disabled = !custom;
    // Contextual buttons: Run only in Custom; the reset button is shown in both
    // Custom and Timezone with a mode-appropriate label; hidden in System.
    this.runBtn.hidden = !custom;
    this.resetBtn.hidden = !(custom || zone);
    this.resetBtn.textContent = zone ? "Reset to host zone" : "Reset to system";
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
      "Custom time re-applies on relaunch. Timezone shifts the live display and " +
      "is re-applied automatically after commands.";
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

  /** Apply Timezone view (live time in the selected zone) — source→zone & tz change. */
  private applyZone(): void {
    const timezone = this.tzSelect.value === TZ_SYSTEM ? detectHostTimezone() : this.tzSelect.value;
    localStorage.setItem(TIME_SOURCE_KEY, "zone");
    // Encoded as system-source with a chosen zone; the timeController sets the
    // watch's utc_offset to that zone so it shows the zone's live wall clock.
    this.applyConfig({
      ...DEFAULT_TIME_CONFIG,
      source: "system",
      rate: "1x",
      timezone,
      hour24: this.read24h(),
      customWallMs: 0,
    });
  }

  /** Switch the tz control back to "System", apply system, resync UI. */
  private selectSystem(): void {
    this.tzSelect.value = TZ_SYSTEM;
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
    if (mode === "zone") {
      // Live time in the chosen zone — no staging, so always "running".
      const zone = this.tzSelect.value === TZ_SYSTEM ? detectHostTimezone() : this.tzSelect.value;
      const city = zone.split("/").pop()?.replace(/_/g, " ") ?? zone;
      el.textContent = `● Viewing live time in ${city}`;
      el.classList.add("settings-time-status--running");
      el.classList.remove("settings-time-status--edited");
      return;
    }
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
  ): HTMLElement {
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
    return row;
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
