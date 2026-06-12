// Keyboard bindings for emulator interaction (Task I).
//
// Maps physical-key presses (KeyboardEvent.key values) to emulator actions. The
// four button actions (back/up/select/down) are bound to the arrow keys by
// default to mirror qemu-pebble's own arrow-key handling; tap/shake are unbound
// by default (the emulator has no default key for them — user-bindable only).
//
// EmulatorView consumes these at runtime (keydown → resolveAction → fire IPC).
// SettingsPane (Wave 2b) edits them, persists via saveBindings, and notifies
// EmulatorView by dispatching a `pebble-studio:keybindings-changed` window event.

/** The bindable emulator actions. */
export type KeyAction = "back" | "up" | "select" | "down" | "tap" | "shake" | "light";

/** Ordered list of actions (drives the Settings UI rows). */
export const ACTIONS: readonly KeyAction[] = ["back", "up", "select", "down", "tap", "shake", "light"] as const;

/** A binding maps each action to a KeyboardEvent.key value, or null if unbound. */
export type Bindings = Record<KeyAction, string | null>;

const STORAGE_KEY = "pebble-studio:keybindings";

/**
 * Default bindings (qemu-pebble): ←=Back, ↑=Up, →=Select, ↓=Down. Tap and Shake
 * have no emulator-default key, so they start unbound.
 */
export const DEFAULT_BINDINGS: Bindings = {
  back: "ArrowLeft",
  up: "ArrowUp",
  select: "ArrowRight",
  down: "ArrowDown",
  tap: null,
  shake: null,
  light: null,
};

/** True for a record that has exactly the action keys with string|null values. */
function isPartialBindings(v: unknown): v is Partial<Bindings> {
  if (!v || typeof v !== "object") return false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!(ACTIONS as readonly string[]).includes(k)) continue;
    if (val !== null && typeof val !== "string") return false;
  }
  return true;
}

/**
 * Load the persisted bindings, MERGED over the defaults so any action missing
 * from storage (e.g. a newly-added action) falls back to its default. Returns a
 * fresh object; safe to mutate.
 */
export function loadBindings(): Bindings {
  const merged: Bindings = { ...DEFAULT_BINDINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isPartialBindings(parsed)) {
        for (const a of ACTIONS) {
          if (a in (parsed as object)) merged[a] = (parsed as Partial<Bindings>)[a] ?? null;
        }
      }
    }
  } catch {
    // Corrupt/unavailable storage → defaults.
  }
  return merged;
}

/** Persist the given bindings to localStorage. */
export function saveBindings(b: Bindings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    // Ignore quota / unavailable storage.
  }
}

/**
 * Resolve a pressed key (KeyboardEvent.key) to the action it's bound to, or null
 * if the key matches no binding. The first matching action (in ACTIONS order)
 * wins if the same key is bound twice.
 */
export function resolveAction(key: string, bindings: Bindings): KeyAction | null {
  for (const a of ACTIONS) {
    if (bindings[a] !== null && bindings[a] === key) return a;
  }
  return null;
}
