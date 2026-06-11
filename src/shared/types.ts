export type PlatformId =
  | "aplite" | "basalt" | "chalk" | "diorite" | "emery" | "flint" | "gabbro";

export interface PlatformInfo {
  id: PlatformId;
  label: string;        // human name, e.g. "Pebble Time"
  machine: string;      // qemu -machine value
  width: number;
  height: number;
  round: boolean;
  color: boolean;
  touch: boolean;       // emery + gabbro only
}

export type ButtonId = "back" | "up" | "select" | "down";
export type ButtonAction = "press" | "hold" | "release";

export interface UpscaleOptions {
  factor: 1 | 2 | 4 | 8;
}
