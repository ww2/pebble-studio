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
  type TimeSource,
} from "../../main/backend/timeController.js";

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
const TIME_CUSTOM_KEY = "pebble-studio:time-custom"; // datetime-local string

const COMMON_ZONES = [
  "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago",
  "America/New_York", "America/Sao_Paulo", "Europe/London", "Europe/Paris",
  "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Shanghai",
  "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];

/** Convert a datetime-local string ("2026-06-01T14:30") to a UTC-naive epoch ms. */
function dtLocalToUtcMs(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
}

/** Human-readable labels for each bindable emulator action (Keyboard section). */
const ACTION_LABELS: Record<KeyAction, string> = {
  back: "Back",
  up: "Up",
  select: "Select",
  down: "Down",
  tap: "Tap (accel)",
  shake: "Shake",
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

    // Time source dropdown (System / Custom).
    const sourceControl = document.createElement("label");
    sourceControl.className = "settings-watch-control";
    const sourceLabel = document.createElement("span");
    sourceLabel.className = "settings-watch-label type-body";
    sourceLabel.textContent = "Time source";
    const sourceSelect = document.createElement("select");
    sourceSelect.className = "settings-watch-select";
    for (const [value, text] of [["system", "System"], ["custom", "Custom"]]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      sourceSelect.appendChild(opt);
    }
    sourceSelect.value = localStorage.getItem(TIME_SOURCE_KEY) ?? "system";
    sourceControl.append(sourceLabel, sourceSelect);

    // Custom date & time input (enabled only when source === "custom").
    const customControl = document.createElement("label");
    customControl.className = "settings-watch-control";
    const customLabel = document.createElement("span");
    customLabel.className = "settings-watch-label type-body";
    customLabel.textContent = "Custom date & time";
    const customInput = document.createElement("input");
    customInput.type = "datetime-local";
    customInput.className = "settings-watch-select";
    const storedCustom = localStorage.getItem(TIME_CUSTOM_KEY);
    if (storedCustom) customInput.value = storedCustom;
    customInput.disabled = sourceSelect.value !== "custom";
    customControl.append(customLabel, customInput);

    sourceSelect.addEventListener("change", () => {
      localStorage.setItem(TIME_SOURCE_KEY, sourceSelect.value);
      customInput.disabled = sourceSelect.value !== "custom";
      this.pushTimeConfig();
    });
    customInput.addEventListener("change", () => {
      localStorage.setItem(TIME_CUSTOM_KEY, customInput.value);
      this.pushTimeConfig();
    });

    // Rate dropdown (Frozen / 1× / 2× / 4× / 10×).
    const rateControl = document.createElement("label");
    rateControl.className = "settings-watch-control";
    const rateLabel = document.createElement("span");
    rateLabel.className = "settings-watch-label type-body";
    rateLabel.textContent = "Rate";
    const rateSelect = document.createElement("select");
    rateSelect.className = "settings-watch-select";
    for (const [value, text] of [
      ["frozen", "Frozen"], ["1x", "1×"], ["2x", "2×"], ["4x", "4×"], ["10x", "10×"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      rateSelect.appendChild(opt);
    }
    rateSelect.value = localStorage.getItem(TIME_RATE_KEY) ?? "1x";
    rateSelect.addEventListener("change", () => {
      localStorage.setItem(TIME_RATE_KEY, rateSelect.value);
      this.pushTimeConfig();
    });
    rateControl.append(rateLabel, rateSelect);

    // Timezone dropdown (COMMON_ZONES + host zone if missing).
    const tzControl = document.createElement("label");
    tzControl.className = "settings-watch-control";
    const tzLabel = document.createElement("span");
    tzLabel.className = "settings-watch-label type-body";
    tzLabel.textContent = "Timezone";
    const tzSelect = document.createElement("select");
    tzSelect.className = "settings-watch-select";
    const hostTz = detectHostTimezone();
    const zones = [...COMMON_ZONES];
    if (!zones.includes(hostTz)) zones.unshift(hostTz);
    for (const z of zones) {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z;
      tzSelect.appendChild(opt);
    }
    tzSelect.value = localStorage.getItem(TIME_TZ_KEY) ?? hostTz;
    tzSelect.addEventListener("change", () => {
      localStorage.setItem(TIME_TZ_KEY, tzSelect.value);
      this.pushTimeConfig();
    });
    tzControl.append(tzLabel, tzSelect);

    // 24-hour clock toggle.
    const hour24Row = this.makeSwitchRow(
      "24-hour clock",
      "Sets what clock_is_24h_style() returns on the watch.",
      localStorage.getItem(TIME_HOUR24_KEY) !== "false", // default ON
      (on) => {
        localStorage.setItem(TIME_HOUR24_KEY, on ? "true" : "false");
        this.pushTimeConfig();
      },
    );

    const timeNote = document.createElement("p");
    timeNote.className = "settings-row-desc type-caption";
    timeNote.textContent =
      "Speeding up time only fast-forwards clock-driven display (hands, date, ticks), not app animations.";

    time.append(
      timeHeading, sourceControl, customControl, rateControl, tzControl, hour24Row, timeNote,
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
    blMethodSelect.value = localStorage.getItem(BACKLIGHT_METHOD_KEY) ?? "back";
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

    // Apply persisted backlight method to main on startup.
    const initialBlMethod = localStorage.getItem(BACKLIGHT_METHOD_KEY) ?? "back";
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

    // Push the persisted time config to the backend on startup (fire-and-forget).
    this.pushTimeConfig();

    // Apply persisted throttle setting on startup.
    void window.studio.setBackgroundThrottling(
      localStorage.getItem("pebble-studio:no-throttle") === "false",
    ).catch(() => {});
  }

  /** Read the persisted time settings from localStorage into a TimeConfig. */
  private buildTimeConfig(): TimeConfig {
    const source = (localStorage.getItem(TIME_SOURCE_KEY) ?? "system") as TimeSource;
    const rate = (localStorage.getItem(TIME_RATE_KEY) ?? "1x") as Rate;
    const timezone = localStorage.getItem(TIME_TZ_KEY) ?? detectHostTimezone();
    const hour24 = localStorage.getItem(TIME_HOUR24_KEY) !== "false";
    const customWallMs = dtLocalToUtcMs(localStorage.getItem(TIME_CUSTOM_KEY) ?? "");
    return { ...DEFAULT_TIME_CONFIG, source, rate, timezone, hour24, customWallMs };
  }

  /**
   * Build the current time config, persist each field, push it to the backend,
   * and broadcast a window event so the time badge (Task 11) can react.
   */
  private pushTimeConfig(): void {
    const cfg = this.buildTimeConfig();
    localStorage.setItem(TIME_SOURCE_KEY, cfg.source);
    localStorage.setItem(TIME_RATE_KEY, cfg.rate);
    localStorage.setItem(TIME_TZ_KEY, cfg.timezone);
    localStorage.setItem(TIME_HOUR24_KEY, cfg.hour24 ? "true" : "false");
    void window.studio.setTimeConfig(cfg).catch(() => {});
    window.dispatchEvent(new CustomEvent("pebble-studio:time-changed", { detail: cfg }));
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
