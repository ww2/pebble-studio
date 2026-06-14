import { describe, it, expect, vi } from "vitest";

// EmulatorView transitively imports vncClient -> @novnc/novnc (touches `window`).
vi.mock("@novnc/novnc", () => ({ default: class {} }));

import { actionDividerFlags } from "../../src/renderer/components/EmulatorView.js";

describe("actionDividerFlags", () => {
  it("never shows a divider before the first group", () => {
    expect(actionDividerFlags([10])[0]).toBe(false);
  });

  it("shows dividers between groups that share a row (single row)", () => {
    // All three groups at the same offsetTop → both followers get a divider.
    expect(actionDividerFlags([10, 10, 10])).toEqual([false, true, true]);
  });

  it("drops the divider for a group that wrapped to a new row", () => {
    // group3 wrapped to the next line → its leading divider is not needed.
    expect(actionDividerFlags([10, 10, 52])).toEqual([false, true, false]);
  });

  it("drops every divider when each group is on its own row", () => {
    expect(actionDividerFlags([10, 52, 94])).toEqual([false, false, false]);
  });

  it("keeps a divider only between the two groups sharing the second row", () => {
    // group1 alone on row 1; groups 2 and 3 together on row 2.
    expect(actionDividerFlags([10, 52, 52])).toEqual([false, false, true]);
  });

  it("handles empty and single-group rows", () => {
    expect(actionDividerFlags([])).toEqual([]);
    expect(actionDividerFlags([10])).toEqual([false]);
  });
});
