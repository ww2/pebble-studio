import { describe, it, expect } from "vitest";
import type { PlatformId } from "../src/shared/types.js";

describe("scaffold smoke", () => {
  it("imports shared types and runs", () => {
    const id: PlatformId = "basalt";
    expect(id).toBe("basalt");
  });
});
