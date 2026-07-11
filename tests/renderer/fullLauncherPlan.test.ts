import { describe, it, expect } from "vitest";
import { planFullLauncherApply } from "../../src/renderer/fullLauncherPlan.js";

const report = (o: Partial<{ applied: string[]; skippedNewer: string[]; skippedMissing: string[] }>) => ({
  applied: o.applied ?? [],
  skippedNewer: o.skippedNewer ?? [],
  skippedMissing: o.skippedMissing ?? [],
});

describe("planFullLauncherApply", () => {
  it("no newer boards → apply directly, no dialog, no force", () => {
    const plan = planFullLauncherApply(report({ applied: ["basalt", "emery"] }), "4.9.169");
    expect(plan.dialog).toBeNull();
    expect(plan.autoForce).toBe(false);
  });

  it("nothing eligible (only missing) → still no dialog, no force", () => {
    const plan = planFullLauncherApply(report({ skippedMissing: ["aplite"] }), "4.9.169");
    expect(plan.dialog).toBeNull();
    expect(plan.autoForce).toBe(false);
  });

  it("all boards newer (e.g. 4.17) → dialog, safe button never forces", () => {
    const plan = planFullLauncherApply(
      report({ skippedNewer: ["emery", "gabbro", "flint"] }),
      "4.17",
    );
    expect(plan.dialog).not.toBeNull();
    expect(plan.dialog!.safeForce).toBe(false);
    expect(plan.dialog!.safeLabel).toMatch(/keep/i);
    // A downgrade must remain possible, but only as an explicit opt-in.
    expect(plan.dialog!.downgradeLabel).toBeTruthy();
    // The version and the on-watch rejection reason are surfaced honestly.
    expect(plan.dialog!.lines.join(" ")).toContain("4.17");
    expect(plan.dialog!.lines.join(" ")).toMatch(/requires a newer version of the Pebble firmware/);
  });

  it("mixed (some appliable, some newer) → safe button adds only the safe boards", () => {
    const plan = planFullLauncherApply(
      report({ applied: ["basalt"], skippedNewer: ["emery"] }),
      "4.11",
    );
    expect(plan.dialog).not.toBeNull();
    expect(plan.dialog!.safeForce).toBe(false);
    expect(plan.dialog!.safeLabel).toContain("basalt");
    expect(plan.dialog!.downgradeLabel).toBeTruthy();
  });
});
