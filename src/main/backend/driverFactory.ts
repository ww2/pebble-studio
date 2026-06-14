export type DriverKind = "native" | "wsl" | "windows-native";

export interface ProbeResult {
  platform: NodeJS.Platform;
  nativePebbleOnPath: boolean;
  nativeQemuOnPath: boolean;
  wslAvailable: boolean;
  override?: DriverKind;
}

export function selectDriverKind(p: ProbeResult): DriverKind {
  const winToolsPresent = p.nativePebbleOnPath && p.nativeQemuOnPath;

  if (p.override) {
    if (p.override === "native" && !winToolsPresent)
      throw new Error("Override 'native' requested but native tools not found");
    if (p.override === "windows-native" && !winToolsPresent)
      throw new Error("Override 'windows-native' requested but native tools not found");
    if (p.override === "wsl" && !p.wslAvailable)
      throw new Error("Override 'wsl' requested but WSL not available");
    return p.override;
  }

  // On a Windows host, prefer the native path when the bundled tools resolve.
  if (p.platform === "win32" && winToolsPresent) return "windows-native";
  // Non-Windows native (Linux/macOS dev) is unchanged.
  if (p.platform !== "win32" && winToolsPresent) return "native";
  // Windows without native tools: fall back to WSL (the v1.0.0 default).
  if (p.wslAvailable) return "wsl";
  throw new Error("No usable emulator backend: install the Pebble SDK natively or enable WSL");
}
