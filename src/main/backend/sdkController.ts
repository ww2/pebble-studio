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
import { mkdir, readdir, readFile, rm, cp, stat, writeFile, statfs } from "node:fs/promises";
import type { WinRuntimeCtx } from "./winRuntime.js";
import { pebbleDataDir, pebblePyExe, sdkBundleRoot } from "./winRuntime.js";
import type { RunResult } from "./BackendDriver.js";
import {
  ACTIVE_SDK_MARKER,
  SDK_COMPLETE_MARKER,
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

/** Per-board stash dir name for an uploaded SDK's ORIGINAL qemu firmware, so the
 * full-launcher overlay is reversible. Lives at
 * `<persistSdkRoot>\SDKs\<ver>\.stock-fw\<board>`. */
export const STOCK_FW_STASH = ".stock-fw";

/** Per-board outcome of a full-launcher overlay attempt. `applied` = boards now
 * running our launcher; `skippedNewer` = boards left alone because the SDK's own
 * firmware is newer than ours (never downgrade); `skippedMissing` = boards the
 * bundle or the SDK doesn't ship. */
export interface FullLauncherReport {
  applied: string[];
  skippedNewer: string[];
  skippedMissing: string[];
}

/**
 * Firmware version each board's BUNDLED overlay blobs actually are. The overlay
 * must never DOWNGRADE an uploaded SDK (#8/#11: a 4.17 upload overlaid with these
 * boots old firmware, and 4.17-built .pbws are rejected with "requires a newer
 * version of the Pebble firmware"). Modern boards carry the normal-shell v4.13.0
 * build (2026-06-15, coredevices/PebbleOS); legacy boards carry the 4.9.169
 * sdk-core firmware (health-seeded SPI). Update alongside vendor/pebble-sdk fw.
 */
export const BUNDLED_FW_VERSIONS: Readonly<Record<string, string>> = {
  emery: "4.13.0",
  gabbro: "4.13.0",
  flint: "4.13.0",
  basalt: "4.9.169",
  chalk: "4.9.169",
  diorite: "4.9.169",
};

/**
 * True when dotted version `a` is strictly newer than `b` (numeric per segment,
 * missing segments are 0). Unparseable input → false, so callers conservatively
 * keep today's behavior for weird version strings. PURE.
 */
export function isVersionNewer(a: string, b: string): boolean {
  const parse = (v: string): number[] | null =>
    /^\d+(\.\d+)*$/.test(v.trim()) ? v.trim().split(".").map(Number) : null;
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

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
  /** Per-board stash dir for the SDK's ORIGINAL qemu blobs (revert source).
   * Resolved by the caller to `<persistSdkRoot>\SDKs\<ver>\.stock-fw\<board>`. */
  stashQemuDir: (board: string) => string;
  /** The uploaded SDK's declared version. When set, a board is overlaid only if
   * its bundled firmware is same-or-newer (never downgrade an upload). Absent →
   * legacy behavior (overlay whatever is present). */
  uploadVersion?: string;
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
): Promise<FullLauncherReport> {
  const { win32: wp } = await import("node:path");
  const applied: string[] = [];
  const skippedNewer: string[] = [];
  const skippedMissing: string[] = [];
  for (const board of FW_REFRESH_BOARDS) {
    // Never downgrade: skip a board whose bundled blobs are OLDER than the upload.
    if (p.uploadVersion && isVersionNewer(p.uploadVersion, BUNDLED_FW_VERSIONS[board] ?? "")) {
      skippedNewer.push(board);
      continue;
    }
    const src = wp.join(p.bundleSdkCore, "pebble", board, "qemu");
    const dst = wp.join(p.targetSdkCore, "pebble", board, "qemu");
    if (!(await fs.exists(wp.join(src, FW_REFRESH_BLOBS[0])))) { skippedMissing.push(board); continue; }
    if (!(await fs.exists(dst))) { skippedMissing.push(board); continue; }
    // Stash the SDK's OWN blobs BEFORE overwriting so revert can restore them.
    // Guard: only stash when none exists yet, so a re-apply can't overwrite a good
    // stash (the SDK's firmware) with already-overlaid launcher bytes.
    const stashDir = p.stashQemuDir(board);
    if (!(await fs.exists(wp.join(stashDir, FW_REFRESH_BLOBS[0])))) {
      await fs.mkdirp(stashDir);
      for (const blob of FW_REFRESH_BLOBS) {
        const cur = wp.join(dst, blob);
        if (await fs.exists(cur)) await fs.copyFile(cur, wp.join(stashDir, blob));
      }
    }
    for (const blob of FW_REFRESH_BLOBS) {
      const s = wp.join(src, blob);
      if (await fs.exists(s)) await fs.copyFile(s, wp.join(dst, blob));
    }
    // Drop the stale decompressed spi so pebble-tool regenerates it.
    await fs.remove(p.decompressedSpi(board));
    applied.push(board);
  }
  if (applied.length > 0) {
    await fs.writeText(p.marker, "1");
    log(`Applied full PebbleOS launcher firmware (${applied.join(", ")}).`);
  }
  if (skippedNewer.length > 0) {
    log(
      `SDK ${p.uploadVersion} is newer than the bundled launcher firmware — ` +
      `keeping its own firmware on ${skippedNewer.join(", ")}.`,
    );
  }
  return { applied, skippedNewer, skippedMissing };
}

/**
 * Undo a full-launcher overlay by restoring the SDK's OWN firmware from the
 * `.stock-fw` stash. Per board: copy stashed blobs back over the overlaid ones
 * and drop the decompressed spi so it regenerates. Removes the `.full-launcher`
 * marker at the end (always, so state is clean even if no board had a stash). A
 * board with no stash is skipped. Returns the boards actually reverted.
 */
export async function revertFullLauncherFirmware(
  fs: ProvisionFs,
  p: Pick<FullLauncherPaths, "targetSdkCore" | "marker" | "decompressedSpi" | "stashQemuDir">,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const { win32: wp } = await import("node:path");
  const reverted: string[] = [];
  for (const board of FW_REFRESH_BOARDS) {
    const stashDir = p.stashQemuDir(board);
    if (!(await fs.exists(wp.join(stashDir, FW_REFRESH_BLOBS[0])))) continue; // nothing stashed
    const dst = wp.join(p.targetSdkCore, "pebble", board, "qemu");
    for (const blob of FW_REFRESH_BLOBS) {
      const s = wp.join(stashDir, blob);
      if (await fs.exists(s)) await fs.copyFile(s, wp.join(dst, blob));
    }
    await fs.remove(p.decompressedSpi(board));
    reverted.push(board);
  }
  await fs.remove(p.marker);
  if (reverted.length > 0) log(`Reverted to the SDK's own firmware (${reverted.join(", ")}).`);
  return reverted;
}

/**
 * Delete every board's QEMU snapshot bundle for a version
 * (`<persistSdkRoot>\<version>\<board>\.snapshot`). #8/#11: snapshot bundles are
 * keyed on {fwRev, sdkVer, exeStamp} — NOT firmware content — so swapping the
 * SDK in place (upload or reset) could otherwise serve an instant-launch restore
 * of the PREVIOUS firmware. Best-effort: enumerates whatever board dirs exist;
 * a version string that isn't a plain dotted number is refused (path safety).
 */
export async function invalidateVersionSnapshots(
  fs: Pick<ProvisionFs, "list" | "exists" | "remove">,
  persistSdkRoot: string,
  version: string,
): Promise<void> {
  if (!/^\d+(\.\d+)*$/.test(version)) return;
  const verDir = winPath.join(persistSdkRoot, version);
  for (const name of await fs.list(verDir)) {
    const snap = winPath.join(verDir, name, ".snapshot");
    if (await fs.exists(snap)) await fs.remove(snap);
  }
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
 * True when `child` is the same path as, or nested under, `parent` (win32,
 * case-insensitive). Used to keep the install's destructive `rm`+`cp` from
 * ever pointing source and target at the same tree. PURE.
 */
export function isPathInside(parent: string, child: string): boolean {
  const rel = winPath.relative(winPath.resolve(parent), winPath.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !winPath.isAbsolute(rel));
}

/** Unique success token the extractor prints on completion. Distinctive so a
 * stray "ok" in interpreter noise can't be mistaken for success. */
export const EXTRACT_OK_TOKEN = "PB_EXTRACT_OK";

/** Reject an archive whose declared uncompressed size exceeds this (zip-bomb
 * guard). A real Pebble SDK is a few hundred MB; this leaves generous headroom. */
export const MAX_EXTRACT_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Python snippet that safely extracts an archive to a dir. `tarfile.open`
 * auto-detects bzip2/gzip; `.zip` goes through zipfile. Extraction is hardened
 * against path traversal (zip-slip): tar uses the `filter='data'` mode (Python
 * ≥3.12) and REFUSES to run — rather than silently falling back to an unfiltered
 * extractall — on an interpreter too old to have it; zip sums declared sizes
 * against a ceiling before extracting. Both archive handles are closed via
 * `with`. Prints EXTRACT_OK_TOKEN on success.
 */
export const EXTRACT_PY = [
  "import sys,tarfile,zipfile,os",
  "src,dst=sys.argv[1],sys.argv[2]",
  `MAX=${MAX_EXTRACT_BYTES}`,
  "os.makedirs(dst,exist_ok=True)",
  "if zipfile.is_zipfile(src):",
  "    with zipfile.ZipFile(src) as z:",
  "        if sum(i.file_size for i in z.infolist()) > MAX:",
  "            sys.exit('archive too large to extract safely (possible zip bomb)')",
  "        z.extractall(dst)",
  "else:",
  "    if not hasattr(tarfile,'data_filter'):",
  "        sys.exit('Python too old to extract this archive safely (need >=3.12 tarfile data filter)')",
  "    with tarfile.open(src) as t:",
  "        t.extractall(dst, filter='data')",
  `print('${EXTRACT_OK_TOKEN}')`,
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

/** Free bytes an SDK install/extract should keep clear on the persist volume. A
 * Pebble SDK is a few hundred MB and `cp` briefly doubles it. */
const SDK_INSTALL_MIN_FREE_BYTES = 512 * 1024 * 1024;

/**
 * Best-effort free-space guard: throws a clear, user-facing error when the volume
 * holding `dir` has less than `minBytes` free, so a disk-full mid-copy can't leave
 * a torn SDK tree. Silently skips when statfs is unsupported or `dir` is missing —
 * it never blocks an install on an unknowable value.
 */
async function ensureFreeSpace(dir: string, minBytes: number, action: string): Promise<void> {
  let free: number;
  try {
    const s = await statfs(dir);
    free = s.bsize * s.bavail;
  } catch {
    return;
  }
  if (free < minBytes) {
    throw new Error(
      `Not enough free disk space to ${action} — ${Math.round(free / 1e6)}MB free, need ~${Math.round(minBytes / 1e6)}MB.`,
    );
  }
}

/**
 * Remove a persisted custom SDK version tree `SDKs\<version>`, asserting it is
 * confined to `<persistSdkRoot>\SDKs` before the recursive delete. A no-op for a
 * non-version-shaped name or a path that escapes the SDK store. Used on reset so a
 * same-version custom upload can't survive under the version dir bundled
 * provisioning re-uses.
 */
async function removeCustomVersionTree(persistSdkRoot: string, version: string): Promise<void> {
  if (!/^\d+(\.\d+)+$/.test(version)) return;
  const sdksRoot = winPath.join(persistSdkRoot, "SDKs");
  const tree = winPath.join(sdksRoot, version);
  // Containment assertion: never delete outside the SDK store.
  if (!isPathInside(sdksRoot, tree) || winPath.resolve(tree) === winPath.resolve(sdksRoot)) return;
  await rm(tree, { recursive: true, force: true }).catch(() => {});
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

  await ensureFreeSpace(pebbleDataDir(ctx), SDK_INSTALL_MIN_FREE_BYTES, "install the SDK");

  // 1. Resolve a search root: a folder is searched in place; an archive is
  //    extracted to a scratch dir first (cleaned before + after).
  let searchRoot = pickedPath;
  const isDir = await stat(pickedPath).then((s) => s.isDirectory()).catch(() => false);
  // A folder pick that lives inside our own persist SDK root would make
  // locateSdkCore resolve source === target, and the rm below would destroy the
  // source before the cp. Reject it up front. (An archive extracts to our own
  // scratch dir, which is expected to be inside the persist root.)
  if (isDir && isPathInside(persistSdkRoot, pickedPath)) {
    throw new Error("Pick an SDK from outside Pebble Studio's data folder (that folder is already the app's SDK store).");
  }
  if (!isDir) {
    if (!looksLikeArchive(pickedPath)) {
      throw new Error("Unsupported file — pick a Pebble SDK archive (.tar.bz2 / .zip) or its folder.");
    }
    log("Extracting SDK…");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(tmpDir, { recursive: true });
    const r = await deps.run(pebblePyExe(ctx), ["-c", EXTRACT_PY, pickedPath, tmpDir]);
    if (r.code !== 0 || !r.stdout.includes(EXTRACT_OK_TOKEN)) {
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
    // Defensive: refuse when the located source and the destination overlap, so
    // the rm below can never delete the very tree we're about to copy FROM.
    if (isPathInside(sdkCoreDir, target) || isPathInside(target, sdkCoreDir)) {
      throw new Error("The selected SDK is already installed here — nothing to copy.");
    }
    await ensureFreeSpace(persistSdkRoot, SDK_INSTALL_MIN_FREE_BYTES, "install the SDK");
    await rm(target, { recursive: true, force: true }).catch(() => {});
    await mkdir(winPath.dirname(target), { recursive: true });
    await cp(sdkCoreDir, target, { recursive: true });

    // 4. Validate the landed copy before committing the override.
    const ok = isSdkCoreManifestValid(await readFile(winPath.join(target, "manifest.json"), "utf8").catch(() => ""), version);
    if (!ok) throw new Error(`SDK copy failed validation (${version}).`);
    // Stamp the completeness sentinel so provisioning treats this upload as a
    // finished install and never re-copies the (non-existent) bundle over it.
    await writeFile(winPath.join(target, SDK_COMPLETE_MARKER), version);

    // 5. Write the override marker so provisioning prefers this SDK from now on.
    await writeFile(winPath.join(persistSdkRoot, ACTIVE_SDK_MARKER), version);

    // 6. Drop any QEMU snapshot bundles for this version: they may hold a
    //    restore image of DIFFERENT firmware bytes under the same {fwRev, sdkVer,
    //    exeStamp} key, and an instant-launch restore would boot the old
    //    firmware, bypassing this upload entirely. Best-effort.
    await invalidateVersionSnapshots(realProvisionFs(), persistSdkRoot, version).catch(() => {});
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // 6. Re-provision (seeds keymaps, points `current` at the new version). The
  //    override marker is written above because provisioning reads it to pick the
  //    version; if provisioning throws, roll the marker back so a failed install
  //    doesn't leave a live-but-broken override armed for the next launch.
  const reprovision = deps.reprovision ?? (async (c: WinRuntimeCtx) => {
    _resetProvisionState();
    await provisionWinSdk(c, { onProgress: log });
  });
  try {
    await reprovision(ctx);
  } catch (e) {
    await rm(winPath.join(persistSdkRoot, ACTIVE_SDK_MARKER), { force: true }).catch(() => {});
    throw e;
  }

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
 * Resolve the FullLauncherPaths for the currently-active CUSTOM SDK. Throws a
 * user-facing error when no custom SDK is active — the bundled SDK is always
 * full-launcher, so there is nothing to toggle.
 */
async function activeCustomSdkPaths(
  ctx: WinRuntimeCtx,
): Promise<{ version: string; persistSdkRoot: string; paths: FullLauncherPaths }> {
  const persistSdkRoot = winPath.join(pebbleDataDir(ctx), "pebble-sdk");
  const version = await readActiveSdkOverride(realProvisionFs(), persistSdkRoot);
  if (!version) {
    throw new Error("Upload a custom SDK first — the bundled SDK already has the full launcher.");
  }
  const bundleVersion = pickSdkVersion(await realProvisionFs().list(winPath.join(sdkBundleRoot(ctx), "SDKs")));
  const paths: FullLauncherPaths = {
    bundleSdkCore: bundleVersion ? winPath.join(sdkBundleRoot(ctx), "SDKs", bundleVersion, "sdk-core") : "",
    targetSdkCore: winPath.join(persistSdkRoot, "SDKs", version, "sdk-core"),
    marker: winPath.join(persistSdkRoot, "SDKs", version, FULL_LAUNCHER_MARKER),
    decompressedSpi: (board) => winPath.join(persistSdkRoot, version, board, "qemu_spi_flash.bin"),
    stashQemuDir: (board) => winPath.join(persistSdkRoot, "SDKs", version, STOCK_FW_STASH, board),
    uploadVersion: version,
  };
  return { version, persistSdkRoot, paths };
}

/** Apply the full-launcher overlay to the active custom SDK on demand, then drop
 * its snapshots (firmware changed). Returns the per-board report + refreshed info. */
export async function applyFullLauncherToActiveSdk(
  ctx: WinRuntimeCtx,
  deps: { onProgress?: (msg: string) => void } = {},
): Promise<{ report: FullLauncherReport; info: SdkInfo }> {
  const log = deps.onProgress ?? (() => {});
  const { version, persistSdkRoot, paths } = await activeCustomSdkPaths(ctx);
  const report = await applyFullLauncherFirmware(realProvisionFs(), paths, log);
  await invalidateVersionSnapshots(realProvisionFs(), persistSdkRoot, version).catch(() => {});
  return { report, info: await currentSdkInfo(ctx) };
}

/** Revert the active custom SDK to its own firmware, then drop its snapshots.
 * Returns the reverted boards + refreshed info. */
export async function revertFullLauncherOnActiveSdk(
  ctx: WinRuntimeCtx,
  deps: { onProgress?: (msg: string) => void } = {},
): Promise<{ reverted: string[]; info: SdkInfo }> {
  const log = deps.onProgress ?? (() => {});
  const { version, persistSdkRoot, paths } = await activeCustomSdkPaths(ctx);
  const reverted = await revertFullLauncherFirmware(realProvisionFs(), paths, log);
  await invalidateVersionSnapshots(realProvisionFs(), persistSdkRoot, version).catch(() => {});
  return { reverted, info: await currentSdkInfo(ctx) };
}

/**
 * Drop the user override and return to the bundled SDK. Removes the marker AND
 * the custom version tree it named, then re-provisions so `current` points back
 * at a FRESH bundled copy.
 *
 * Deleting the custom tree is essential, not just cleanup: an upload declaring
 * the SAME version as the bundle overwrote `SDKs\<bundleVer>\sdk-core` — the very
 * dir bundled provisioning re-uses. Left in place, provisioning would find a
 * valid same-version manifest, SKIP the copy, and keep serving custom files while
 * reporting `source: "bundled"`. Wiping it forces a clean re-provision from the
 * bundle (and reclaims the hundreds of MB of a non-colliding custom version too).
 */
export async function resetToBundledSdk(
  ctx: WinRuntimeCtx,
  deps: { reprovision?: (ctx: WinRuntimeCtx) => Promise<void>; onProgress?: (msg: string) => void } = {},
): Promise<SdkInfo> {
  const log = deps.onProgress ?? (() => {});
  const persistSdkRoot = winPath.join(pebbleDataDir(ctx), "pebble-sdk");
  const marker = winPath.join(persistSdkRoot, ACTIVE_SDK_MARKER);
  // Read the named version BEFORE dropping the marker so we know which tree to wipe.
  const customVersion = (await readFile(marker, "utf8").catch(() => "")).trim();
  if (await exists(marker)) await rm(marker, { force: true }).catch(() => {});
  if (customVersion) await removeCustomVersionTree(persistSdkRoot, customVersion);
  // Snapshots for the dropped custom version AND the bundle version we're
  // returning to may both hold pre-reset firmware images — drop them so the
  // next launch cold-boots the freshly provisioned firmware (see install).
  const snapFs = realProvisionFs();
  if (customVersion) await invalidateVersionSnapshots(snapFs, persistSdkRoot, customVersion).catch(() => {});
  const bundleVersion = pickSdkVersion(await snapFs.list(winPath.join(sdkBundleRoot(ctx), "SDKs")));
  if (bundleVersion) await invalidateVersionSnapshots(snapFs, persistSdkRoot, bundleVersion).catch(() => {});
  const reprovision = deps.reprovision ?? (async (c: WinRuntimeCtx) => {
    _resetProvisionState();
    await provisionWinSdk(c, { onProgress: log });
  });
  await reprovision(ctx);
  return currentSdkInfo(ctx);
}
