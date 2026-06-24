import { describe, it, expect } from "vitest";
import { win32 as winPath } from "node:path";
import {
  locateSdkCore,
  looksLikeArchive,
  applyFullLauncherFirmware,
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
  };
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
    const done = await applyFullLauncherFirmware(fs, paths);
    expect(done).toEqual([...FW_REFRESH_BOARDS]);
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
    const done = await applyFullLauncherFirmware(fs, paths);
    expect(done).not.toContain("emery");
    expect(done.length).toBe(FW_REFRESH_BOARDS.length - 1);
    expect(fs.calls.some((c) => c.includes(`\\emery\\`))).toBe(false);
  });

  it("skips a board the bundle lacks firmware for, without failing", async () => {
    // Remove chalk's bundle micro-flash blob → chalk skipped.
    const present = fullPresent().filter((p) => p !== winPath.join(srcQemu("chalk"), FW_REFRESH_BLOBS[0]));
    const fs = fakeFwFs(present);
    const done = await applyFullLauncherFirmware(fs, paths);
    expect(done).not.toContain("chalk");
  });

  it("writes no marker and returns [] when nothing can be overlaid", async () => {
    const fs = fakeFwFs([]); // empty: no bundle blobs, no dst dirs
    const done = await applyFullLauncherFirmware(fs, paths);
    expect(done).toEqual([]);
    expect(fs.calls.some((c) => c.startsWith("write"))).toBe(false);
  });
});
