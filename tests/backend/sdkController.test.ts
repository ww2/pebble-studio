import { describe, it, expect } from "vitest";
import { win32 as winPath } from "node:path";
import {
  locateSdkCore,
  looksLikeArchive,
  applyFullLauncherFirmware,
  revertFullLauncherFirmware,
  isPathInside,
  isVersionNewer,
  invalidateVersionSnapshots,
  EXTRACT_PY,
  EXTRACT_OK_TOKEN,
  type SdkFsProbe,
} from "../../src/main/backend/sdkController.js";
import {
  FW_REFRESH_BOARDS,
  FW_REFRESH_BLOBS,
  type ProvisionFs,
} from "../../src/main/backend/winSdkProvision.js";

/** In-memory probe. `dirs` maps a dir path → its entry names; `files` maps a
 * file path → its text. Paths are win32 (backslash), matching winPath.join. */
function probe(model: { dirs?: Record<string, string[]>; files?: Record<string, string> }): SdkFsProbe {
  const dirs = model.dirs ?? {};
  const files = model.files ?? {};
  return {
    list: async (p) => dirs[p] ?? [],
    isDir: async (p) => p in dirs,
    readText: async (p) => files[p] ?? "",
  };
}

const sdkCoreManifest = (ver: string) => JSON.stringify({ type: "sdk-core", version: ver });

describe("looksLikeArchive", () => {
  it("accepts the formats Pebble SDKs ship as", () => {
    for (const f of ["sdk-core-4.3.tar.bz2", "x.tbz2", "x.tar.gz", "x.tgz", "x.tar", "x.zip", "X.TAR.BZ2"]) {
      expect(looksLikeArchive(f)).toBe(true);
    }
  });
  it("rejects non-archives (a folder path or a stray file)", () => {
    for (const f of ["C:\\Users\\me\\sdk-folder", "manifest.json", "readme.txt", "app.pbw"]) {
      expect(looksLikeArchive(f)).toBe(false);
    }
  });
});

describe("isPathInside (self-delete / containment guard)", () => {
  it("treats an identical path as inside (source === target must be rejected)", () => {
    expect(isPathInside("C:\\data\\SDKs\\4.3\\sdk-core", "C:\\data\\SDKs\\4.3\\sdk-core")).toBe(true);
  });
  it("detects a nested child", () => {
    expect(isPathInside("C:\\data\\pebble-sdk", "C:\\data\\pebble-sdk\\SDKs\\4.3\\sdk-core")).toBe(true);
  });
  it("is case-insensitive and separator-tolerant (win32)", () => {
    expect(isPathInside("C:\\Data\\Pebble-SDK", "c:\\data\\pebble-sdk\\SDKs")).toBe(true);
  });
  it("rejects a sibling / unrelated path", () => {
    expect(isPathInside("C:\\data\\pebble-sdk", "C:\\data\\other")).toBe(false);
    expect(isPathInside("C:\\data\\SDKs\\4.3", "C:\\Downloads\\sdk")).toBe(false);
  });
  it("rejects a parent (child is above, not inside)", () => {
    expect(isPathInside("C:\\data\\pebble-sdk\\SDKs", "C:\\data\\pebble-sdk")).toBe(false);
  });
});

describe("EXTRACT_PY (hardened archive extraction)", () => {
  it("prints the unique success token and requires it, not a loose 'ok'", () => {
    expect(EXTRACT_OK_TOKEN).toBe("PB_EXTRACT_OK");
    expect(EXTRACT_PY).toContain(`print('${EXTRACT_OK_TOKEN}')`);
  });
  it("has NO unfiltered extractall fallback (drops the zip-slip path)", () => {
    // The old code had `except TypeError: t.extractall(dst)` — an unfiltered
    // extraction. It must be gone; only the filtered form remains.
    expect(EXTRACT_PY).not.toContain("except TypeError");
    expect(EXTRACT_PY).toContain("filter='data'");
  });
  it("fails loudly on an interpreter too old for the tar data filter", () => {
    expect(EXTRACT_PY).toContain("hasattr(tarfile,'data_filter')");
    expect(EXTRACT_PY).toContain("Python too old");
  });
  it("closes both archive handles via `with` and guards zip size", () => {
    expect(EXTRACT_PY).toContain("with zipfile.ZipFile(src) as z:");
    expect(EXTRACT_PY).toContain("with tarfile.open(src) as t:");
    expect(EXTRACT_PY).toContain("possible zip bomb");
  });
});

describe("locateSdkCore", () => {
  it("finds the sdk-core when the picked folder IS the sdk-core", async () => {
    const root = "C:\\up";
    const p = probe({
      dirs: { [root]: [] },
      files: { [winPath.join(root, "manifest.json")]: sdkCoreManifest("4.3") },
    });
    expect(await locateSdkCore(p, root)).toEqual({ sdkCoreDir: root, version: "4.3" });
  });

  it("finds a nested SDKs\\<ver>\\sdk-core tree (what an archive extracts to)", async () => {
    const root = "C:\\up";
    const sdks = winPath.join(root, "SDKs");
    const verDir = winPath.join(sdks, "4.9.169");
    const core = winPath.join(verDir, "sdk-core");
    const p = probe({
      dirs: { [root]: ["SDKs"], [sdks]: ["4.9.169"], [verDir]: ["sdk-core"], [core]: [] },
      files: { [winPath.join(core, "manifest.json")]: sdkCoreManifest("4.9.169") },
    });
    expect(await locateSdkCore(p, root)).toEqual({ sdkCoreDir: core, version: "4.9.169" });
  });

  it("returns null when there is no sdk-core manifest anywhere", async () => {
    const root = "C:\\up";
    const sub = winPath.join(root, "docs");
    const p = probe({
      dirs: { [root]: ["docs"], [sub]: [] },
      files: { [winPath.join(sub, "manifest.json")]: JSON.stringify({ type: "toolchain", version: "1.0" }) },
    });
    expect(await locateSdkCore(p, root)).toBeNull();
  });

  it("respects the depth bound (deeply buried sdk-core past maxDepth is not found)", async () => {
    // root/a/b/c/sdk-core/manifest.json is 4 levels deep; maxDepth 2 → not found.
    const root = "C:\\up";
    const a = winPath.join(root, "a");
    const b = winPath.join(a, "b");
    const c = winPath.join(b, "c");
    const core = winPath.join(c, "sdk-core");
    const p = probe({
      dirs: { [root]: ["a"], [a]: ["b"], [b]: ["c"], [c]: ["sdk-core"], [core]: [] },
      files: { [winPath.join(core, "manifest.json")]: sdkCoreManifest("4.3") },
    });
    expect(await locateSdkCore(p, root, 2)).toBeNull();
    // With a generous bound it IS found.
    expect(await locateSdkCore(p, root, 5)).toEqual({ sdkCoreDir: core, version: "4.3" });
  });
});

// ---------------------------------------------------------------------------
// applyFullLauncherFirmware (overlay bundled full-launcher fw onto an upload)
// ---------------------------------------------------------------------------

/** Minimal ProvisionFs recording copyFile/remove/writeText; `present` seeds
 * existing files+dirs. Only the methods applyFullLauncherFirmware uses are real. */
function fakeFwFs(present: string[]): ProvisionFs & { calls: string[]; has: (p: string) => boolean } {
  const set = new Set(present);
  const calls: string[] = [];
  return {
    calls,
    has: (p) => set.has(p),
    async exists(p) { return set.has(p); },
    async copyFile(s, d) { calls.push(`copy ${s} -> ${d}`); set.add(d); },
    async remove(p) { calls.push(`remove ${p}`); set.delete(p); },
    async writeText(p, _c) { calls.push(`write ${p}`); set.add(p); },
    async readText() { return ""; },
    async list() { return []; },
    async mkdirp() {},
    async copyTree() {},
    async ensureJunction() {},
  };
}

describe("applyFullLauncherFirmware", () => {
  const BUNDLE = "C:\\b\\sdk-core";
  const TARGET = "C:\\t\\sdk-core";
  const MARKER = "C:\\t\\.full-launcher";
  const paths = {
    bundleSdkCore: BUNDLE,
    targetSdkCore: TARGET,
    marker: MARKER,
    decompressedSpi: (board: string) => `C:\\spi\\${board}\\qemu_spi_flash.bin`,
    stashQemuDir: (board: string) => `C:\\t\\.stock-fw\\${board}`,
  };
  const STASH = (b: string) => winPath.join("C:\\t\\.stock-fw", b);
  const srcQemu = (b: string) => winPath.join(BUNDLE, "pebble", b, "qemu");
  const dstQemu = (b: string) => winPath.join(TARGET, "pebble", b, "qemu");
  /** Seed: bundle has both blobs for every board; target ships every board's qemu dir. */
  const fullPresent = (): string[] => {
    const ps: string[] = [];
    for (const b of FW_REFRESH_BOARDS) {
      for (const blob of FW_REFRESH_BLOBS) ps.push(winPath.join(srcQemu(b), blob));
      ps.push(dstQemu(b)); // dst qemu dir exists (replace-only requires it)
    }
    return ps;
  };

  it("overlays both blobs onto every board, drops stale spi, and stamps the marker", async () => {
    const fs = fakeFwFs(fullPresent());
    const r = await applyFullLauncherFirmware(fs, paths);
    expect(r.applied).toEqual([...FW_REFRESH_BOARDS]);
    for (const b of FW_REFRESH_BOARDS) {
      for (const blob of FW_REFRESH_BLOBS) {
        expect(fs.calls).toContain(`copy ${winPath.join(srcQemu(b), blob)} -> ${winPath.join(dstQemu(b), blob)}`);
      }
      expect(fs.calls).toContain(`remove C:\\spi\\${b}\\qemu_spi_flash.bin`);
    }
    expect(fs.calls).toContain(`write ${MARKER}`);
    expect(fs.has(MARKER)).toBe(true);
  });

  it("is REPLACE-ONLY: skips a board the uploaded SDK doesn't ship (dst qemu dir absent)", async () => {
    // Drop emery's dst qemu dir → emery should be skipped, the rest overlaid.
    const present = fullPresent().filter((p) => p !== dstQemu("emery"));
    const fs = fakeFwFs(present);
    const r = await applyFullLauncherFirmware(fs, paths);
    expect(r.applied).not.toContain("emery");
    expect(r.skippedMissing).toContain("emery");
    expect(r.applied.length).toBe(FW_REFRESH_BOARDS.length - 1);
    expect(fs.calls.some((c) => c.includes(`\\emery\\`))).toBe(false);
  });

  it("skips a board the bundle lacks firmware for, without failing", async () => {
    // Remove chalk's bundle micro-flash blob → chalk skipped.
    const present = fullPresent().filter((p) => p !== winPath.join(srcQemu("chalk"), FW_REFRESH_BLOBS[0]));
    const fs = fakeFwFs(present);
    const r = await applyFullLauncherFirmware(fs, paths);
    expect(r.applied).not.toContain("chalk");
    expect(r.skippedMissing).toContain("chalk");
  });

  it("writes no marker and returns [] when nothing can be overlaid", async () => {
    const fs = fakeFwFs([]); // empty: no bundle blobs, no dst dirs
    const r = await applyFullLauncherFirmware(fs, paths);
    expect(r.applied).toEqual([]);
    expect(fs.calls.some((c) => c.startsWith("write"))).toBe(false);
  });

  // ── #8/#11 fix: never DOWNGRADE an upload that is newer than the bundled fw ──
  // The overlay exists to keep the unlocked launcher, but the bundled blobs are
  // pinned versions (modern boards 4.13.0, legacy boards 4.9.169). An SDK upload
  // NEWER than a board's bundled firmware must keep its own (newer) firmware, or
  // .pbws built with the new SDK hit "requires a newer version of the firmware".
  it("skips EVERY board when the upload is newer than all bundled firmware (4.17)", async () => {
    const fs = fakeFwFs(fullPresent());
    const r = await applyFullLauncherFirmware(fs, { ...paths, uploadVersion: "4.17" });
    expect(r.applied).toEqual([]);
    expect(r.skippedNewer.sort()).toEqual([...FW_REFRESH_BOARDS].sort());
    expect(fs.calls.some((c) => c.startsWith("copy"))).toBe(false);
    expect(fs.has(MARKER)).toBe(false);
  });

  it("overlays only the boards whose bundled fw is >= the upload (4.11: modern yes, legacy no)", async () => {
    const fs = fakeFwFs(fullPresent());
    const r = await applyFullLauncherFirmware(fs, { ...paths, uploadVersion: "4.11" });
    // modern boards carry 4.13.0 (>= 4.11) → overlaid; legacy carry 4.9.169 (< 4.11) → kept.
    expect(r.applied.sort()).toEqual(["emery", "flint", "gabbro"]);
    expect(fs.calls.some((c) => c.includes("\\basalt\\"))).toBe(false);
    expect(fs.has(MARKER)).toBe(true); // some boards did get the launcher
  });

  it("still overlays everything for a same-or-older upload (4.9.169)", async () => {
    const fs = fakeFwFs(fullPresent());
    const r = await applyFullLauncherFirmware(fs, { ...paths, uploadVersion: "4.9.169" });
    expect(r.applied).toEqual([...FW_REFRESH_BOARDS]);
  });

  it("treats an unparseable upload version like today (overlay everything)", async () => {
    const fs = fakeFwFs(fullPresent());
    const r = await applyFullLauncherFirmware(fs, { ...paths, uploadVersion: "weird" });
    expect(r.applied).toEqual([...FW_REFRESH_BOARDS]);
  });

  it("stashes the SDK's own blobs before overwriting (reversible)", async () => {
    const present = fullPresent();
    for (const b of FW_REFRESH_BOARDS) for (const blob of FW_REFRESH_BLOBS) present.push(winPath.join(dstQemu(b), blob));
    const fs = fakeFwFs(present);
    const r = await applyFullLauncherFirmware(fs, paths);
    expect(r.applied).toEqual([...FW_REFRESH_BOARDS]);
    for (const b of FW_REFRESH_BOARDS) for (const blob of FW_REFRESH_BLOBS) {
      expect(fs.calls).toContain(`copy ${winPath.join(dstQemu(b), blob)} -> ${winPath.join(STASH(b), blob)}`);
    }
  });

  it("does not re-stash a board that already has a stash (re-apply keeps the original)", async () => {
    const present = fullPresent();
    for (const b of FW_REFRESH_BOARDS) for (const blob of FW_REFRESH_BLOBS) present.push(winPath.join(dstQemu(b), blob));
    present.push(winPath.join(STASH("basalt"), FW_REFRESH_BLOBS[0])); // basalt already stashed
    const fs = fakeFwFs(present);
    await applyFullLauncherFirmware(fs, paths);
    expect(fs.calls).not.toContain(
      `copy ${winPath.join(dstQemu("basalt"), FW_REFRESH_BLOBS[0])} -> ${winPath.join(STASH("basalt"), FW_REFRESH_BLOBS[0])}`,
    );
    // a board WITHOUT a prior stash is still stashed
    expect(fs.calls).toContain(
      `copy ${winPath.join(dstQemu("emery"), FW_REFRESH_BLOBS[0])} -> ${winPath.join(STASH("emery"), FW_REFRESH_BLOBS[0])}`,
    );
  });

  it("force overlays newer boards too, still stashing (skippedNewer becomes empty)", async () => {
    // Seed dst blobs so the stash copy has something to copy (like the stash test).
    const present = fullPresent();
    for (const b of FW_REFRESH_BOARDS) for (const blob of FW_REFRESH_BLOBS) present.push(winPath.join(dstQemu(b), blob));
    const fs = fakeFwFs(present);
    const r = await applyFullLauncherFirmware(fs, { ...paths, uploadVersion: "4.17" }, undefined, { force: true });
    expect(r.applied).toEqual([...FW_REFRESH_BOARDS]);
    expect(r.skippedNewer).toEqual([]);
    expect(fs.has(MARKER)).toBe(true);
    // force MUST still stash + overlay (reversibility): prove both mutations ran for a newer board.
    expect(fs.calls).toContain(
      `copy ${winPath.join(dstQemu("emery"), FW_REFRESH_BLOBS[0])} -> ${winPath.join(STASH("emery"), FW_REFRESH_BLOBS[0])}`,
    );
    expect(fs.calls).toContain(
      `copy ${winPath.join(srcQemu("emery"), FW_REFRESH_BLOBS[0])} -> ${winPath.join(dstQemu("emery"), FW_REFRESH_BLOBS[0])}`,
    );
  });

  it("dryRun computes the report without mutating anything", async () => {
    const fs = fakeFwFs(fullPresent());
    const r = await applyFullLauncherFirmware(fs, paths, undefined, { dryRun: true });
    expect(r.applied).toEqual([...FW_REFRESH_BOARDS]); // would apply all
    expect(fs.calls).toEqual([]);                       // but recorded no copy/remove/write
    expect(fs.has(MARKER)).toBe(false);                 // no marker written
  });

  it("force + dryRun: reports newer boards as applied but mutates nothing", async () => {
    const fs = fakeFwFs(fullPresent());
    const r = await applyFullLauncherFirmware(fs, { ...paths, uploadVersion: "4.17" }, undefined, { force: true, dryRun: true });
    expect(r.applied).toEqual([...FW_REFRESH_BOARDS]); // force reaches them
    expect(r.skippedNewer).toEqual([]);
    expect(fs.calls).toEqual([]);                       // dryRun blocked all mutation
    expect(fs.has(MARKER)).toBe(false);
  });
});

describe("revertFullLauncherFirmware", () => {
  const TARGET = "C:\\t\\sdk-core";
  const MARKER = "C:\\t\\.full-launcher";
  const STASH = (b: string) => winPath.join("C:\\t\\.stock-fw", b);
  const dstQemu = (b: string) => winPath.join(TARGET, "pebble", b, "qemu");
  const paths = {
    bundleSdkCore: "C:\\b\\sdk-core",
    targetSdkCore: TARGET,
    marker: MARKER,
    decompressedSpi: (b: string) => `C:\\spi\\${b}\\qemu_spi_flash.bin`,
    stashQemuDir: (b: string) => STASH(b),
  };

  it("restores stashed blobs, drops the spi, and clears the marker", async () => {
    const present: string[] = [MARKER];
    for (const b of FW_REFRESH_BOARDS) for (const blob of FW_REFRESH_BLOBS) present.push(winPath.join(STASH(b), blob));
    const fs = fakeFwFs(present);
    const reverted = await revertFullLauncherFirmware(fs, paths);
    expect(reverted).toEqual([...FW_REFRESH_BOARDS]);
    for (const b of FW_REFRESH_BOARDS) {
      for (const blob of FW_REFRESH_BLOBS) {
        expect(fs.calls).toContain(`copy ${winPath.join(STASH(b), blob)} -> ${winPath.join(dstQemu(b), blob)}`);
      }
      expect(fs.calls).toContain(`remove C:\\spi\\${b}\\qemu_spi_flash.bin`);
    }
    expect(fs.calls).toContain(`remove ${MARKER}`);
  });

  it("skips a board with no stash but still clears the marker", async () => {
    const fs = fakeFwFs([MARKER]);
    const reverted = await revertFullLauncherFirmware(fs, paths);
    expect(reverted).toEqual([]);
    expect(fs.calls).toContain(`remove ${MARKER}`);
  });
});

// ---------------------------------------------------------------------------
// isVersionNewer (pure dotted-version comparator for the overlay gate)
// ---------------------------------------------------------------------------

describe("isVersionNewer", () => {
  it("compares dotted versions numerically", () => {
    expect(isVersionNewer("4.17", "4.13.0")).toBe(true);
    expect(isVersionNewer("4.13.0", "4.17")).toBe(false);
    expect(isVersionNewer("4.9.170", "4.9.169")).toBe(true);
    expect(isVersionNewer("4.10", "4.9.169")).toBe(true); // 10 > 9, not lexicographic
  });
  it("is false for equal versions (missing segments are zero)", () => {
    expect(isVersionNewer("4.13", "4.13.0")).toBe(false);
    expect(isVersionNewer("4.13.0", "4.13")).toBe(false);
  });
  it("is false when either side is unparseable (conservative: keep old behavior)", () => {
    expect(isVersionNewer("weird", "4.13.0")).toBe(false);
    expect(isVersionNewer("4.17", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invalidateVersionSnapshots (#8/#11 fix: SDK swap must drop stale snapshots)
// ---------------------------------------------------------------------------

describe("invalidateVersionSnapshots", () => {
  const ROOT = "C:\\persist\\pebble-sdk";
  /** Fake fs: `dirs` maps a dir path → entry names; remove() records. */
  function fakeSnapFs(dirs: Record<string, string[]>, present: string[] = []) {
    const removed: string[] = [];
    const set = new Set(present);
    return {
      removed,
      async list(p: string) { return dirs[p] ?? []; },
      async exists(p: string) { return set.has(p); },
      async remove(p: string) { removed.push(p); },
      // unused ProvisionFs members
      async copyFile() {}, async writeText() {}, async readText() { return ""; },
      async mkdirp() {}, async copyTree() {}, async ensureJunction() {},
    };
  }

  it("removes the .snapshot dir under every board dir of the version", async () => {
    const verDir = winPath.join(ROOT, "4.17");
    const fs = fakeSnapFs(
      { [verDir]: ["basalt", "emery", "robert.txt"] },
      [
        winPath.join(verDir, "basalt", ".snapshot"),
        winPath.join(verDir, "emery", ".snapshot"),
      ],
    );
    await invalidateVersionSnapshots(fs, ROOT, "4.17");
    expect(fs.removed.sort()).toEqual([
      winPath.join(verDir, "basalt", ".snapshot"),
      winPath.join(verDir, "emery", ".snapshot"),
    ]);
  });

  it("is a no-op when the version dir has no boards or no snapshots", async () => {
    const fs = fakeSnapFs({});
    await invalidateVersionSnapshots(fs, ROOT, "4.17");
    expect(fs.removed).toEqual([]);
  });

  it("rejects a version string that could escape the SDK store", async () => {
    const fs = fakeSnapFs({ [winPath.join(ROOT, "..")]: ["x"] }, [winPath.join(ROOT, "..", "x", ".snapshot")]);
    await invalidateVersionSnapshots(fs, ROOT, "..");
    expect(fs.removed).toEqual([]);
  });
});
