import { describe, it, expect } from "vitest";
import { spawnRunner } from "../../src/main/backend/spawnRunner.js";

describe("spawnRunner", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await spawnRunner("node", ["-e", "process.stdout.write('hi')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hi");
  });
  it("captures a non-zero exit code", async () => {
    const r = await spawnRunner("node", ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
  });
});
