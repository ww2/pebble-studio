import { describe, it, expect } from "vitest";
import { ARTIFACT_NAME, WORKFLOW_NAME, DEST_DIR } from "../../scripts/fetch-arm64-qemu.mjs";

describe("fetch-arm64-qemu constants", () => {
  it("targets the Phase-0 arm64 artifact + workflow and stages into the gitignored vendor dir", () => {
    expect(ARTIFACT_NAME).toBe("qemu-pebble-win-arm64");
    expect(WORKFLOW_NAME).toBe("qemu-arm64.yml");
    expect(DEST_DIR).toMatch(/vendor[\\/]qemu-pebble-win-arm64$/);
  });
});
