export type DriverKind = "native" | "wsl";

export interface ProbeResult {
  platform: NodeJS.Platform;
  nativePebbleOnPath: boolean;
  nativeQemuOnPath: boolean;
  wslAvailable: boolean;
  override?: DriverKind;
}

export function selectDriverKind(p: ProbeResult): DriverKind {
  if (p.override) {
    if (p.override === "native" && !(p.nativePebbleOnPath && p.nativeQemuOnPath))
      throw new Error("Override 'native' requested but native tools not found");
    if (p.override === "wsl" && !p.wslAvailable)
      throw new Error("Override 'wsl' requested but WSL not available");
    return p.override;
  }
  if (p.nativePebbleOnPath && p.nativeQemuOnPath) return "native";
  if (p.wslAvailable) return "wsl";
  throw new Error("No usable emulator backend: install the Pebble SDK natively or enable WSL");
}
