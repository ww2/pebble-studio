import { describe, it, expect, beforeEach } from "vitest";
import {
  pickSdkVersion,
  isSdkCoreManifestValid,
  planWinSdkProvision,
  provisionWinSdk,
  ensureWinSdkProvisioned,
  _resetProvisionState,
  type ProvisionFs,
} from "../../src/main/backend/winSdkProvision.js";
import type { WinRuntimeCtx } from "../../src/main/backend/winRuntime.js";

const packaged: WinRuntimeCtx = {
  packaged: true,
  resourcesPath: "C:\\Program Files\\Pebble Studio\\resources",
  repoRoot: "C:\\repo",
  userDataDir: "C:\\Users\\Jason Lin\\AppData\\Roaming\\Pebble Studio",
  exists: () => true,
};

// ---------------------------------------------------------------------------
// pickSdkVersion
// ---------------------------------------------------------------------------

describe("pickSdkVersion", () => {
  it("returns the single version dir, ignoring the current link", () => {
    expect(pickSdkVersion(["4.9.169", "current"])).toBe("4.9.169");
  });

  it("returns the highest version when several are present", () => {
    expect(pickSdkVersion(["4.9.169", "4.10.2", "4.9.200", "current"])).toBe("4.10.2");
  });

  it("compares numerically, not lexically (10 > 9)", () => {
    expect(pickSdkVersion(["4.9.169", "4.9.9"])).toBe("4.9.169");
  });

  it("accepts two-segment versions", () => {
    expect(pickSdkVersion(["4.9"])).toBe("4.9");
  });

  it("ignores non-version entries", () => {
    expect(pickSdkVersion(["current", "README.md", ".gitkeep"])).toBeNull();
  });

  it("returns null on an empty bundle", () => {
    expect(pickSdkVersion([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isSdkCoreManifestValid
// ---------------------------------------------------------------------------

describe("isSdkCoreManifestValid", () => {
  const good = JSON.stringify({ type: "sdk-core", version: "4.9.169", channel: "" });

  it("accepts a well-formed sdk-core manifest of the expected version", () => {
    expect(isSdkCoreManifestValid(good, "4.9.169")).toBe(true);
  });

  it("rejects a manifest of a different version", () => {
    expect(isSdkCoreManifestValid(good, "4.10.0")).toBe(false);
  });

  it("rejects a non-sdk-core type", () => {
    expect(isSdkCoreManifestValid(JSON.stringify({ type: "toolchain", version: "4.9.169" }), "4.9.169")).toBe(false);
  });

  it("rejects empty / missing content", () => {
    expect(isSdkCoreManifestValid("", "4.9.169")).toBe(false);
  });

  it("rejects malformed JSON", () => {
    expect(isSdkCoreManifestValid("{ not json", "4.9.169")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planWinSdkProvision (pure path resolution)
// ---------------------------------------------------------------------------

describe("planWinSdkProvision", () => {
  const p = planWinSdkProvision(packaged, "4.9.169");

  it("copies sdk-core FROM the read-only bundle under resourcesPath", () => {
    expect(p.bundleSdkCore).toBe(
      "C:\\Program Files\\Pebble Studio\\resources\\pebble-sdk\\SDKs\\4.9.169\\sdk-core",
    );
  });

  it("sources keymaps from the qemu bundle's pc-bios\\keymaps", () => {
    expect(p.keymapsSrc).toBe(
      "C:\\Program Files\\Pebble Studio\\resources\\qemu-pebble-win\\pc-bios\\keymaps",
    );
  });

  it("targets the WRITABLE persist dir (XDG_DATA_HOME = userData\\pebble-data)", () => {
    const base = "C:\\Users\\Jason Lin\\AppData\\Roaming\\Pebble Studio\\pebble-data\\pebble-sdk\\SDKs";
    expect(p.persistSdks).toBe(base);
    expect(p.targetVersionDir).toBe(`${base}\\4.9.169`);
    expect(p.targetSdkCore).toBe(`${base}\\4.9.169\\sdk-core`);
    expect(p.targetManifest).toBe(`${base}\\4.9.169\\sdk-core\\manifest.json`);
    expect(p.targetKeymaps).toBe(`${base}\\4.9.169\\toolchain\\lib\\pc-bios\\keymaps`);
    expect(p.currentLink).toBe(`${base}\\current`);
  });
});

// ---------------------------------------------------------------------------
// provisionWinSdk (effectful runner, fake fs)
// ---------------------------------------------------------------------------

/** A fake fs that records every effect and serves a configurable file/dir model. */
function makeFakeFs(model: {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
}): ProvisionFs & { calls: string[] } {
  const files: Record<string, string> = { ...(model.files ?? {}) };
  const dirs: Record<string, string[]> = { ...(model.dirs ?? {}) };
  const calls: string[] = [];
  const present = new Set<string>([...Object.keys(files)]);
  return {
    calls,
    async exists(p) {
      return present.has(p) || p in dirs;
    },
    async readText(p) {
      return files[p] ?? "";
    },
    async list(p) {
      return dirs[p] ?? [];
    },
    async mkdirp(p) {
      calls.push(`mkdirp ${p}`);
      dirs[p] = dirs[p] ?? [];
    },
    async copyTree(src, dest) {
      calls.push(`copyTree ${src} -> ${dest}`);
      // Simulate a successful sdk-core copy by materialising a valid manifest.
      files[`${dest}\\manifest.json`] = JSON.stringify({ type: "sdk-core", version: "4.9.169" });
      present.add(`${dest}\\manifest.json`);
    },
    async copyFile(src, dest) {
      calls.push(`copyFile ${src} -> ${dest}`);
      files[dest] = "x";
      present.add(dest);
    },
    async ensureJunction(target, link) {
      calls.push(`junction ${link} -> ${target}`);
    },
  };
}

const BUNDLE_SDKS = "C:\\Program Files\\Pebble Studio\\resources\\pebble-sdk\\SDKs";
const KEYMAPS_SRC = "C:\\Program Files\\Pebble Studio\\resources\\qemu-pebble-win\\pc-bios\\keymaps";

describe("provisionWinSdk — clean first run", () => {
  beforeEach(() => _resetProvisionState());

  it("copies sdk-core, seeds keymaps, and creates the current junction", async () => {
    const fs = makeFakeFs({
      dirs: {
        [BUNDLE_SDKS]: ["4.9.169", "current"],
        [KEYMAPS_SRC]: ["en-us", "en-gb", "de"],
      },
    });
    const res = await provisionWinSdk(packaged, { fs });

    expect(res.version).toBe("4.9.169");
    expect(res.actions).toEqual({ copiedSdkCore: true, seededKeymaps: true, refreshedJunction: true });

    const p = planWinSdkProvision(packaged, "4.9.169");
    expect(fs.calls).toContain(`copyTree ${p.bundleSdkCore} -> ${p.targetSdkCore}`);
    expect(fs.calls).toContain(`copyFile ${KEYMAPS_SRC}\\en-us -> ${p.targetKeymaps}\\en-us`);
    expect(fs.calls).toContain(`junction ${p.currentLink} -> ${p.targetVersionDir}`);
  });
});

describe("provisionWinSdk — idempotent re-run", () => {
  beforeEach(() => _resetProvisionState());

  it("skips the sdk-core copy and keymap seeding when both already exist", async () => {
    const p = planWinSdkProvision(packaged, "4.9.169");
    const fs = makeFakeFs({
      dirs: { [BUNDLE_SDKS]: ["4.9.169", "current"], [KEYMAPS_SRC]: ["en-us"] },
      files: {
        [p.targetManifest]: JSON.stringify({ type: "sdk-core", version: "4.9.169" }),
        [`${p.targetKeymaps}\\en-us`]: "x",
      },
    });
    const res = await provisionWinSdk(packaged, { fs });

    expect(res.actions.copiedSdkCore).toBe(false);
    expect(res.actions.seededKeymaps).toBe(false);
    // The junction is always refreshed (cheap + self-healing).
    expect(res.actions.refreshedJunction).toBe(true);
    expect(fs.calls.some((c) => c.startsWith("copyTree"))).toBe(false);
    expect(fs.calls.some((c) => c.startsWith("copyFile"))).toBe(false);
  });

  it("re-copies sdk-core when the existing manifest is the wrong version", async () => {
    const p = planWinSdkProvision(packaged, "4.9.169");
    const fs = makeFakeFs({
      dirs: { [BUNDLE_SDKS]: ["4.9.169", "current"], [KEYMAPS_SRC]: ["en-us"] },
      files: {
        [p.targetManifest]: JSON.stringify({ type: "sdk-core", version: "4.0.0" }),
        [`${p.targetKeymaps}\\en-us`]: "x",
      },
    });
    const res = await provisionWinSdk(packaged, { fs });
    expect(res.actions.copiedSdkCore).toBe(true);
  });
});

describe("provisionWinSdk — failure modes", () => {
  beforeEach(() => _resetProvisionState());

  it("throws when the bundle has no SDK version", async () => {
    const fs = makeFakeFs({ dirs: { [BUNDLE_SDKS]: ["current", "README.md"] } });
    await expect(provisionWinSdk(packaged, { fs })).rejects.toThrow(/no SDK version/i);
  });

  it("throws when the bundle has no keymaps to seed", async () => {
    const fs = makeFakeFs({ dirs: { [BUNDLE_SDKS]: ["4.9.169"], [KEYMAPS_SRC]: [] } });
    await expect(provisionWinSdk(packaged, { fs })).rejects.toThrow(/no keymaps/i);
  });
});

describe("ensureWinSdkProvisioned — process cache", () => {
  beforeEach(() => _resetProvisionState());

  it("provisions once and reuses the cached result for concurrent callers", async () => {
    const fs = makeFakeFs({
      dirs: { [BUNDLE_SDKS]: ["4.9.169"], [KEYMAPS_SRC]: ["en-us"] },
    });
    const [a, b] = await Promise.all([
      ensureWinSdkProvisioned(packaged, { fs }),
      ensureWinSdkProvisioned(packaged, { fs }),
    ]);
    expect(a).toBe(b); // same cached promise result
    // Only ONE copyTree across both calls.
    expect(fs.calls.filter((c) => c.startsWith("copyTree")).length).toBe(1);
  });

  it("clears the cache on failure so a later call retries", async () => {
    const failing = makeFakeFs({ dirs: { [BUNDLE_SDKS]: [] } });
    await expect(ensureWinSdkProvisioned(packaged, { fs: failing })).rejects.toThrow();

    // A subsequent call with a healthy fs must run again (not return the failure).
    const healthy = makeFakeFs({
      dirs: { [BUNDLE_SDKS]: ["4.9.169"], [KEYMAPS_SRC]: ["en-us"] },
    });
    const res = await ensureWinSdkProvisioned(packaged, { fs: healthy });
    expect(res.version).toBe("4.9.169");
  });
});
