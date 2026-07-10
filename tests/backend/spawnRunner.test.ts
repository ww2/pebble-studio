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
  it("kills the child and resolves a nonzero code when timeoutMs elapses", async () => {
    const t0 = Date.now();
    const r = await spawnRunner("node", ["-e", "setInterval(() => {}, 1000)"], undefined, 200);
    expect(r.code).not.toBe(0);        // resolves (never rejects/hangs) with a nonzero code
    expect(Date.now() - t0).toBeLessThan(2000); // returned promptly, not after the child's own life
  });
  it("clears the timeout on a normal fast exit (no double-settle, real code wins)", async () => {
    const r = await spawnRunner("node", ["-e", "process.stdout.write('ok')"], undefined, 5000);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });
});
