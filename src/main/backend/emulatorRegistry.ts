import type { PlatformId, PlatformInfo } from "../../shared/types.js";

export const PLATFORMS: PlatformInfo[] = [
  { id: "aplite",  label: "Pebble Classic",     machine: "pebble-bb2",            width: 144, height: 168, round: false, color: false, touch: false },
  { id: "basalt",  label: "Pebble Time",        machine: "pebble-snowy-bb",       width: 144, height: 168, round: false, color: true,  touch: false },
  { id: "chalk",   label: "Pebble Time Round",  machine: "pebble-s4-bb",          width: 180, height: 180, round: true,  color: true,  touch: false },
  { id: "diorite", label: "Pebble 2",           machine: "pebble-silk-bb",        width: 144, height: 168, round: false, color: false, touch: false },
  { id: "emery",   label: "Pebble Time 2",      machine: "pebble-snowy-emery-bb", width: 200, height: 228, round: false, color: true,  touch: true  },
  { id: "flint",   label: "Pebble 2 Duo",       machine: "pebble-flint",          width: 144, height: 168, round: false, color: true,  touch: false },
  { id: "gabbro",  label: "Pebble Round 2",     machine: "pebble-gabbro",         width: 260, height: 260, round: true,  color: true,  touch: true  },
];

const BY_ID = new Map<PlatformId, PlatformInfo>(PLATFORMS.map((p) => [p.id, p]));

export function getPlatform(id: PlatformId): PlatformInfo {
  const info = BY_ID.get(id);
  if (!info) throw new Error(`Unknown platform: ${id}`);
  return info;
}

export function listPlatformIds(): PlatformId[] {
  return PLATFORMS.map((p) => p.id);
}
