/**
 * sdkController.ts — user-facing Pebble SDK management for the native-Windows
 * track: report the active SDK version, install an uploaded SDK ("Replace &
 * persist"), and reset back to the bundled one.
 *
 * Pebble SDKs ship as an `sdk-core` tree (a `manifest.json` of type "sdk-core"
 * plus per-board firmware), distributed as a `.tar.bz2` archive (e.g.
 * `sdk-core-4.3.tar.bz2`). We accept either an archive (.tar.bz2/.tar.gz/.zip/…)
 * or an already-extracted folder, locate the sdk-core inside it, copy it into the
 * writable persist dir as `SDKs\<version>\sdk-core`, and write the `.active-sdk`
 * override marker that winSdkProvision honours over the bundled SDK. Then we
 * re-run provisioning (which seeds keymaps + points the `current` junction at the
 * new version). A missing/corrupt override silently falls back to the bundle, so
 * a bad upload can never wedge boot, and "Reset to bundled" just drops the marker.
 *
 * The PURE helpers (locateSdkCore) are unit-tested; the orchestrator takes an
 * injectable runner + reprovision fn so it is testable against a tmp dir.
 */

import { win32 as winPath } from "node:path";
import { mkdir, readdir, readFile, rm, cp, stat, writeFile } from "node:fs/promises";
import type { WinRuntimeCtx } from "./winRuntime.js";
import { pebbleDataDir, pebblePyExe, sdkBundleRoot } from "./winRuntime.js";
import type { RunResult } from "./BackendDriver.js";
import {
  ACTIVE_SDK_MARKER,
  FW_REFRESH_BOARDS,
  FW_REFRESH_BLOBS,
  isSdkCoreManifestValid,
  parseSdkCoreManifest,
  pickSdkVersion,
  provisionWinSdk,
  readActiveSdkOverride,
  realProvisionFs,
  _resetProvisionState,
  type ProvisionFs,
} from "./winSdkProvision.js";

export type SdkSource = "custom" | "bundled";

export interface SdkInfo {
  /** The SDK version pebble-tool will resolve via `SDKs\current`. */
  version: string;
  /** Whether that version is a user upload (`.active-sdk`) or the shipped bundle. */
  source: SdkSource;
  /** True when the active SDK carries Pebble Studio's full-launcher firmware
   * (unlocked PebbleOS — Settings/Health/full menu). The bundle always has it;
   * a custom upload has it once the overlay below runs (`.full-launcher` marker). */
  fullLauncher: boolean;
}

/** Marker written into a custom SDK version dir once the full-launcher firmware
 * overlay has been applied to it. */
export const FULL_LAUNCHER_MARKER = ".full-launcher";

/** Paths the full-launcher firmware overlay touches (PURE — resolved by caller). */
export interface FullLauncherPaths {
  /** Bundled (full-launcher) sdk-core to copy firmware FROM. */
  bundleSdkCore: string;
  /** The uploaded SDK's sdk-core to copy firmware INTO (replace-only). */
  targetSdkCore: string;
  /** `<persistSdkRoot>\SDKs\<ver>\.full-launcher` marker to stamp on success. */
  marker: string;
  /** pebble-tool's decompressed spi for a board (deleted so it regenerates). */
  decompressedSpi: (board: string) => string;
}

/**
 * Overlay Pebble Studio's bundled full-launcher firmware (the unlocked-PebbleOS
 * `qemu_micro_flash.bin` + `qemu_spi_flash.bin.bz2` per board) onto an uploaded
 * SDK, so a stock upload doesn't downgrade the watch to the locked sdkshell
 * launcher (no Settings/Health). REPLACE-ONLY: a board is overlaid only when BOTH
 * the bundle has the firmware AND the uploaded SDK already ships that board, so we
 * never inject a board the SDK doesn't know about. Best-effort per board (a
 * missing board is skipped, not fatal). Returns the boards actually overlaid and
 * stamps the `.full-launcher` marker when any were. Injectable fs for testing —
 * mirrors refreshWinSdkFirmware.
 */
export async function applyFullLauncherFirmware(
  fs: ProvisionFs,
  p: FullLauncherPaths,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const { win32: wp } = await import("node:path");
  const done: string[] = [];
  for (const board of FW_REFRESH_BOARDS) {
    const src = wp.join(p.bundleSdkCore, "pebble", board, "qemu");
    const dst = wp.join(p.targetSdkCore, "pebble", board, "qemu");
    if (!(await fs.exists(wp.join(src, FW_REFRESH_BLOBS[0])))) continue; // bundle lacks this board
    if (!(await fs.exists(dst))) continue; // uploaded SDK lacks this board → replace-only
    for (const blob of FW_REFRESH_BLOBS) {
      const s = wp.join(src, blob);
      if (await fs.exists(s)) await fs.copyFile(s, wp.join(dst, blob));
    }
    // Drop the stale decompressed spi so pebble-tool regenerates it from the new template.
    await fs.remove(p.decompressedSpi(board));
    done.push(board);
  }
  if (done.length > 0) {
    await fs.writeText(p.marker, "1");
    log(`Applied full PebbleOS launcher firmware (${done.join(", ")}).`);
  }
  return done;
}

// ---------------------------------------------------------------------------
// Pure: locate the sdk-core inside an uploaded folder/extracted archive
// ---------------------------------------------------------------------------

/** Minimal directory probe so locateSdkCore is unit-testable without disk. */
export interface SdkFsProbe {
  /** Directory entry NAMES (not paths); resolve [] when missing/not a dir. */
  list(p: string): Promise<string[]>;
  /** True when the path is a directory. */
  isDir(p: string): Promise<boolean>;
  /** Read a text file; resolve "" when missing. */
  readText(p: string): Promise<string>;
}

/** Real fs implementation of SdkFsProbe. */
export function realSdkFsProbe(): SdkFsProbe {
  return {
    list: async (p) => readdir(p).catch(() => [] as string[]),
    isDir: async (p) => stat(p).then((s) => s.isDirectory()).catch(() => false),
    readText: async (p) => readFile(p, "utf8").catch(() => ""),
  };
}

/**
 * Breadth-first search `root` (up to `maxDepth` levels deep) for the directory
 * that holds an sdk-core `manifest.json` (type "sdk-core"). Returns its path +
 * declared version, or null when none is found. Handles the common shapes: the
 * picked folder IS the sdk-core, or contains `sdk-core\`, or a full
 * `SDKs\<ver>\sdk-core\` tree, or an archive that extracted to any of those.
 */
export async function locateSdkCore(
  probe: SdkFsProbe,
  root: string,
  maxDepth = 5,
): Promise<{ sdkCoreDir: string; version: string } | null> {
  // queue of [dir, depth]; check shallow dirs first so the outermost sdk-core wins.
  const queue: Array<[string, number]> = [[root, 0]];
  while (queue.length > 0) {
    const [dir, depth] = queue.shift()!;
    const parsed = parseSdkCoreManifest(await probe.readText(winPath.join(dir, "manifest.json")));
    if (parsed) return { sdkCoreDir: dir, version: parsed.version };
    if (depth >= maxDepth) continue;
    for (const name of await probe.list(dir)) {
      const child = winPath.join(dir, name);
      if (await probe.isDir(child)) queue.push([child, depth + 1]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Archive extraction via the bundled interpreter (handles .tar.bz2/.gz/.zip)
// ---------------------------------------------------------------------------

/** True when the picked path looks like an archive we should extract (vs a folder). */
export function looksLikeArchive(p: string): boolean {
  return /\.(tar\.bz2|tbz2|tar\.gz|tgz|tar|bz2|gz|zip)$/i.test(p);
}

/**
 * Python one-liner that extracts an archive to a dir. `tarfile.open` auto-detects
 * bzip2/gzip; `.zip` goes through zipfile. The `filter='data'` arg (Python ≥3.12)
 * is the safe extraction mode; older interpreters that lack it fall back to the
 * legacy behaviour. SDK tarballs are plain files, so either path is fine.
 */
export const EXTRACT_PY = [
  "import sys,tarfile,zipfile,os",
  "src,dst=sys.argv[1],sys.argv[2]",
  "os.makedirs(dst,exist_ok=True)",
  "if zipfile.is_zipfile(src):",
  "    zipfile.ZipFile(src).extractall(dst)",
  "else:",
  "    t=tarfile.open(src)",
  "    try: t.extractall(dst, filter='data')",
  "    except TypeError: t.extractall(dst)",
  "    t.close()",
  "print('ok')",
].join("\n");

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export type RunFn = (cmd: string, args: string[], env?: Record<string, string>) => Promise<RunResult>;

export interface InstallSdkDeps {
  run: RunFn;
  /** Injectable so tests skip the (cached) real provisioning. Defaults to the
   * real reset-cache + provisionWinSdk(ctx). */
  reprovision?: (ctx: WinRuntimeCtx) => Promise<void>;
  onProgress?: (msg: string) => void;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false);
}

/**
 * Install an uploaded SDK from `pickedPath` (an archive file or an extracted
 * folder) as the active "Replace & persist" SDK. Returns the installed version.
 * Throws a short, user-facing message when the upload doesn't contain a Pebble
 * SDK or a step fails (callers surface `err.message`).
 */
export async function installCustomSdk(
  ctx: WinRuntimeCtx,
  pickedPath: string,
  deps: InstallSdkDeps,
): Promise<SdkInfo> {
  const log = deps.onProgress ?? (() => {});
  const persistSdkRoot = winPath.join(pebbleDataDir(ctx), "pebble-sdk");
  const tmpDir = winPath.join(persistSdkRoot, ".upload-tmp");

  // 1. Resolve a search root: a folder is searched in place; an archive is
  //    extracted to a scratch dir first (cleaned before + after).
  let searchRoot = pickedPath;
  const isDir = await stat(pickedPath).then((s) => s.isDirectory()).catch(() => false);
  if (!isDir) {
    if (!looksLikeArchive(pickedPath)) {
      throw new Error("Unsupported file — pick a Pebble SDK archive (.tar.bz2 / .zip) or its folder.");
    }
    log("Extracting SDK…");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(tmpDir, { recursive: true });
    const r = await deps.run(pebblePyExe(ctx), ["-c", EXTRACT_PY, pickedPath, tmpDir]);
    if (r.code !== 0 || !/\bok\b/.test(r.stdout)) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Couldn't extract the SDK archive: ${(r.stderr || r.stdout || "").split("\n")[0].trim()}`);
    }
    searchRoot = tmpDir;
  }

  try {
    // 2. Locate the sdk-core inside the upload.
    const found = await locateSdkCore(realSdkFsProbe(), searchRoot);
    if (!found) {
      throw new Error("No Pebble SDK found in the upload (missing sdk-core/manifest.json).");
    }
    const { sdkCoreDir, version } = found;

    // 3. Copy it into the persist dir as SDKs\<version>\sdk-core (replace any prior).
    log(`Installing Pebble SDK ${version}…`);
    const target = winPath.join(persistSdkRoot, "SDKs", version, "sdk-core");
    await rm(target, { recursive: true, force: true }).catch(() => {});
    await mkdir(winPath.dirname(target), { recursive: true });
    await cp(sdkCoreDir, target, { recursive: true });

    // 4. Validate the landed copy before committing the override.
    const ok = isSdkCoreManifestValid(await readFile(winPath.join(target, "manifest.json"), "utf8").catch(() => ""), version);
    if (!ok) throw new Error(`SDK copy failed validation (${version}).`);

    // 5. Write the override marker so provisioning prefers this SDK from now on.
    await writeFile(winPath.join(persistSdkRoot, ACTIVE_SDK_MARKER), version);

    // 6. Overlay the bundled full-launcher firmware so the upload keeps unlocked
    //    PebbleOS (Settings/Health/full menu) instead of the stock sdkshell
    //    launcher. Best-effort — never fail the install on a firmware hiccup.
    try {
      const bundleVersion = pickSdkVersion(await realProvisionFs().list(winPath.join(sdkBundleRoot(ctx), "SDKs")));
      if (bundleVersion) {
        const boards = await applyFullLauncherFirmware(realProvisionFs(), {
          bundleSdkCore: winPath.join(sdkBundleRoot(ctx), "SDKs", bundleVersion, "sdk-core"),
          targetSdkCore: target,
          marker: winPath.join(persistSdkRoot, "SDKs", version, FULL_LAUNCHER_MARKER),
          decompressedSpi: (board) => winPath.join(persistSdkRoot, version, board, "qemu_spi_flash.bin"),
        }, log);
        if (boards.length === 0) log("No full-launcher firmware to apply (uploaded SDK keeps its own firmware).");
      }
    } catch (e) {
      log(`Full-launcher overlay skipped (non-fatal): ${(e as Error)?.message ?? e}`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // 6. Re-provision (seeds keymaps, points `current` at the new version).
  const reprovision = deps.reprovision ?? (async (c: WinRuntimeCtx) => {
    _resetProvisionState();
    await provisionWinSdk(c, { onProgress: log });
  });
  await reprovision(ctx);

  return currentSdkInfo(ctx);
}

/** Report the active SDK version, whether it's a user upload or the bundle, and
 * whether it carries the full-launcher firmware. */
export async function currentSdkInfo(ctx: WinRuntimeCtx): Promise<SdkInfo> {
  const persistSdkRoot = winPath.join(pebbleDataDir(ctx), "pebble-sdk");
  const fs = realProvisionFs();
  const override = await readActiveSdkOverride(fs, persistSdkRoot);
  if (override) {
    const fullLauncher = await fs.exists(winPath.join(persistSdkRoot, "SDKs", override, FULL_LAUNCHER_MARKER));
    return { version: override, source: "custom", fullLauncher };
  }
  // The bundled SDK always ships the full-launcher firmware.
  const bundleVersion = pickSdkVersion(await fs.list(winPath.join(sdkBundleRoot(ctx), "SDKs")));
  return { version: bundleVersion ?? "unknown", source: "bundled", fullLauncher: true };
}

/**
 * Drop the user override and return to the bundled SDK. Removes the marker and
 * re-provisions so `current` points back at the bundled version.
 */
export async function resetToBundledSdk(
  ctx: WinRuntimeCtx,
  deps: { reprovision?: (ctx: WinRuntimeCtx) => Promise<void>; onProgress?: (msg: string) => void } = {},
): Promise<SdkInfo> {
  const log = deps.onProgress ?? (() => {});
  const persistSdkRoot = winPath.join(pebbleDataDir(ctx), "pebble-sdk");
  const marker = winPath.join(persistSdkRoot, ACTIVE_SDK_MARKER);
  if (await exists(marker)) await rm(marker, { force: true }).catch(() => {});
  const reprovision = deps.reprovision ?? (async (c: WinRuntimeCtx) => {
    _resetProvisionState();
    await provisionWinSdk(c, { onProgress: log });
  });
  await reprovision(ctx);
  return currentSdkInfo(ctx);
}
