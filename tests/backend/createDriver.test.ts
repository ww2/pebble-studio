import { describe, it, expect } from "vitest";
import { createDriver } from "../../src/main/backend/createDriver.js";

describe("createDriver", () => {
  it("returns kind 'native' on this linux dev machine (pebble + sdk qemu present)", async () => {
    const { kind } = await createDriver();
    expect(kind).toBe("native");
  });
});
