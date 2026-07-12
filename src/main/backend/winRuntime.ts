import { win32 as winPath } from "node:path";
import { existsSync } from "node:fs";
import type { PebbleCommand } from "./pebbleCli.js";

// Bundled to CommonJS by esbuild, where `__dirname` is a native global. The
// ambient declare keeps it typechecking under the ESM (nodenext) tsconfig.
declare const __dirname: string;

/**
 * Resolves the bundled native-Windows runtime (qemu-pebble.exe + the relocatable
 * patched python that hosts pebble-tool + the read-only SDK bundle) and builds the
 * path-independent pebble-tool invocation contract.
 *
 * PURE by design: every resolver takes an explicit `WinRuntimeCtx` so it is
 * unit-testable on a non-Windows host with NO electron import. The production
 * caller builds the ctx from electron via `defaultCtx()` (which is only ever
 * reached on win32, so the electron dependency never loads in the unit tests of
 * the Linux dev machine). Paths are joined with `path.win32` so they come out as
 * Windows paths regardless of where the resolver runs.
 */
export interface WinRuntimeCtx {
  /** electron app.isPackaged — packaged bundles live under resourcesPath. */
  packaged: boolean;
  /** process.resourcesPath — the packaged app's resources dir. */
  resourcesPath: string;
  /** Repo root (dev only): bundles resolve under `<repoRoot>\vendor\…`. */
  repoRoot: string;
  /** electron app.getPath("userData") — the writable per-user app-data dir. */
  userDataDir: string;
  /**
   * Dev-only OPT-IN directory for the not-yet-staged python bundle. Populated from
   * PEBBLE_STUDIO_PY_DEV_DIR (unset in packaged builds and by default). Gating the
   * fallback behind this explicit env var closes a local-privilege hole: the old
   * hardcoded `C:\tmp\pebble-py-build\python` is world-creatable, so any user could
   * plant PebbleStudioEmu.exe there and have a dev machine execute it.
   */
  pyDevDir?: string;
  /** Existence predicate (injected in tests). Defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
  /**
   * Whether the REAL host CPU is ARM64. `process.arch` cannot tell us this — it
   * reports `x64` for an emulated x64 process on Windows-on-ARM — so this is
   * derived from the WOW64 env vars via hostIsArm64(process.env) in defaultCtx.
   * Optional (defaults to false when omitted) so existing ctx literals compile.
   */
  hostArm64?: boolean;
}

/** Bundle dir names under resources/ (packaged) or vendor/ (dev). */
const QEMU_BUNDLE = "qemu-pebble-win";
const QEMU_BUNDLE_ARM64 = "qemu-pebble-win-arm64";
const PY_BUNDLE = "pebble-py";
const SDK_BUNDLE = "pebble-sdk";
const TIMESHIM_WIN_BUNDLE = "timeshim-win";

/** Branded basename for the bundled interpreter so Task Manager shows the
 * emulator's Python (pypkjs/websockify, spawned via sys.executable) as a Pebble
 * Studio process rather than a generic python.exe. The relocatable CPython
 * locates its home from the containing directory, NOT the exe name, so renaming
 * is safe. The build script (build-pebble-py.ps1) emits this name. */
const PY_EXE_NAME = "PebbleStudioEmu.exe";

/**
 * True iff the REAL host CPU is ARM64. On Windows-on-ARM an emulated x64 process
 * sees `process.arch === "x64"`; the host arch surfaces only via the WOW64 env
 * vars: PROCESSOR_ARCHITEW6432 is "ARM64" when an x86/x64 process runs on an
 * ARM64 host, and PROCESSOR_ARCHITECTURE is "ARM64" for a natively-arm64 process.
 */
export function hostIsArm64(env: NodeJS.ProcessEnv): boolean {
  const wow = (env.PROCESSOR_ARCHITEW6432 ?? "").toUpperCase();
  const arch = (env.PROCESSOR_ARCHITECTURE ?? "").toUpperCase();
  return wow === "ARM64" || arch === "ARM64";
}

function exists(ctx: WinRuntimeCtx, p: string): boolean {
  return (ctx.exists ?? existsSync)(p);
}

/**
 * Resolve a bundle dir. Packaged → under resourcesPath. Dev → repo `vendor/<name>`.
 */
function bundleDir(ctx: WinRuntimeCtx, name: string): string {
  if (ctx.packaged) return winPath.join(ctx.resourcesPath, name);
  return winPath.join(ctx.repoRoot, "vendor", name);
}

/** Absolute path to the bundled qemu-pebble.exe.
 *
 * On a real ARM64 host, prefer the native-arm64 bundle when it is staged — an
 * x86-64 qemu crashes under Windows-on-ARM emulation (its TCG JIT re-JIT is the
 * worst case), so we spawn the native-arm64 exe instead. If the arm64 bundle is
 * absent (e.g. a mis-built x64-only package on ARM) we fall back to the x64 exe,
 * which reproduces today's behavior rather than pointing at a missing file. */
export function qemuExe(ctx: WinRuntimeCtx): string {
  if (ctx.hostArm64) {
    const arm64 = winPath.join(bundleDir(ctx, QEMU_BUNDLE_ARM64), "qemu-pebble.exe");
    if (exists(ctx, arm64)) {
      console.warn("[winRuntime] host is ARM64 — using native arm64 qemu bundle");
      return arm64;
    }
    console.warn("[winRuntime] host is ARM64 but arm64 qemu bundle is missing — falling back to x64 qemu (emulated; may fail)");
  }
  return winPath.join(bundleDir(ctx, QEMU_BUNDLE), "qemu-pebble.exe");
}

/** Directory of the relocatable bundled python (hosts pebble-tool). Packaged →
 * under resourcesPath. Dev → repo `vendor/pebble-py`, or the EXPLICIT opt-in dir
 * (PEBBLE_STUDIO_PY_DEV_DIR → ctx.pyDevDir) when the vendor bundle isn't staged. */
export function pebblePyDir(ctx: WinRuntimeCtx): string {
  if (ctx.packaged) return winPath.join(ctx.resourcesPath, PY_BUNDLE);
  const vendor = winPath.join(ctx.repoRoot, "vendor", PY_BUNDLE);
  if (exists(ctx, vendor)) return vendor;
  // Vendor bundle not staged. Only fall back to a dev dir if the developer
  // explicitly opted in — and log loudly, since we're about to execute an
  // interpreter from a non-standard location. With no opt-in we return the
  // (absent) vendor path, so bundledToolsPresent reads the native stack as
  // unavailable rather than silently running code from a world-writable path.
  if (ctx.pyDevDir) {
    console.warn(`[winRuntime] PEBBLE_STUDIO_PY_DEV_DIR set — using dev python bundle at ${ctx.pyDevDir}`);
    return ctx.pyDevDir;
  }
  return vendor;
}

/** Absolute path to the bundled interpreter (PebbleStudioEmu.exe). */
export function pebblePyExe(ctx: WinRuntimeCtx): string {
  return winPath.join(pebblePyDir(ctx), PY_EXE_NAME);
}

/** Read-only SDK bundle root (contains `SDKs\<ver>\sdk-core`). */
export function sdkBundleRoot(ctx: WinRuntimeCtx): string {
  return bundleDir(ctx, SDK_BUNDLE);
}

/** Directory of the bundled native-Windows time shim (timeshim-win.dll +
 * launcher.exe + probe.exe). Resolved under resourcesPath (packaged) or
 * vendor/timeshim-win (dev), like the other bundles. */
export function timeShimWinDir(ctx: WinRuntimeCtx): string {
  return bundleDir(ctx, TIMESHIM_WIN_BUNDLE);
}

/**
 * Whether the self-contained native stack is present: both the bundled qemu exe
 * AND the bundled python (which hosts pebble-tool) resolve on disk. Drives
 * driver selection independently of the system PATH.
 */
export function bundledToolsPresent(ctx: WinRuntimeCtx): boolean {
  return exists(ctx, qemuExe(ctx)) && exists(ctx, pebblePyExe(ctx));
}

/**
 * Writable app-data persist root. pebble-tool's get_persist_dir() joins
 * XDG_DATA_HOME + "pebble-sdk", so the SDK + state are provisioned under
 * `<pebbleDataDir>\pebble-sdk`.
 */
export function pebbleDataDir(ctx: WinRuntimeCtx): string {
  return winPath.join(ctx.userDataDir, "pebble-data");
}

/**
 * THE INVOCATION CONTRACT: invoke the bundled pebble-tool path-independently.
 * pip's generated `pebble.exe` bakes an absolute python path (non-portable), so
 * we drive run_tool() through the bundled interpreter directly and supply the
 * runtime env (qemu path + writable XDG_DATA_HOME).
 */
export function pebbleCmd(args: string[], ctx: WinRuntimeCtx): PebbleCommand {
  return {
    cmd: pebblePyExe(ctx),
    args: ["-c", "from pebble_tool import run_tool; run_tool()", ...args],
    env: {
      PEBBLE_QEMU_PATH: qemuExe(ctx),
      XDG_DATA_HOME: pebbleDataDir(ctx),
    },
  };
}

/**
 * Build the production ctx from electron + process. Reached ONLY on win32
 * (windows-native), so the electron dependency never loads in the Linux unit
 * tests — hence the lazy dynamic import rather than a static top-level one.
 *
 * In dev the bundled main runs from `dist/main/index.cjs`, so __dirname is
 * `<repo>\dist\main`; repoRoot resolves two levels up. Packaged mode ignores
 * repoRoot (bundles resolve under resourcesPath).
 */
export async function defaultCtx(): Promise<WinRuntimeCtx> {
  const { app } = await import("electron");
  return {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: winPath.resolve(__dirname, "..", ".."),
    userDataDir: app.getPath("userData"),
    // Opt-in only; unset (and ignored) in packaged builds, which short-circuit above.
    pyDevDir: process.env.PEBBLE_STUDIO_PY_DEV_DIR,
    hostArm64: hostIsArm64(process.env),
  };
}
