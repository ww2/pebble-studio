import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createQuitHandler } from "../../src/main/quitHandler.js";

describe("createQuitHandler", () => {
  it("prevents the first quit, runs shutdown once, then exits", async () => {
    const order: string[] = [];
    let resolveShutdown!: () => void;
    const shutdown = vi.fn(
      () => new Promise<void>((r) => { resolveShutdown = () => { order.push("shutdown"); r(); }; }),
    );
    const exit = vi.fn(() => order.push("exit"));
    const handler = createQuitHandler(shutdown, exit);

    const e1 = { preventDefault: vi.fn() };
    handler(e1);
    expect(e1.preventDefault).toHaveBeenCalledTimes(1); // first quit deferred
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();                // not until shutdown resolves

    resolveShutdown();
    await Promise.resolve(); await Promise.resolve();    // let the .then chain flush
    expect(order).toEqual(["shutdown", "exit"]);
  });

  it("is idempotent: a second quit while cleaning does not re-run shutdown", () => {
    const shutdown = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();
    const handler = createQuitHandler(shutdown, exit);
    handler({ preventDefault: vi.fn() });
    handler({ preventDefault: vi.fn() });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("keeps deferring (preventDefault) a second quit attempt mid-teardown", () => {
    const shutdown = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();
    const handler = createQuitHandler(shutdown, exit);
    const e1 = { preventDefault: vi.fn() };
    const e2 = { preventDefault: vi.fn() };
    handler(e1);
    handler(e2);
    expect(e1.preventDefault).toHaveBeenCalledTimes(1);
    expect(e2.preventDefault).toHaveBeenCalledTimes(1); // still deferred, not orphaning children
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not block a quit once the deliberate exit is underway", async () => {
    let resolveShutdown!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((r) => { resolveShutdown = r; }));
    const exit = vi.fn();
    const handler = createQuitHandler(shutdown, exit);
    handler({ preventDefault: vi.fn() });
    resolveShutdown();
    await Promise.resolve(); await Promise.resolve();
    expect(exit).toHaveBeenCalledTimes(1);
    const e = { preventDefault: vi.fn() };
    handler(e);
    expect(e.preventDefault).not.toHaveBeenCalled(); // exiting → let the quit proceed
    expect(exit).toHaveBeenCalledTimes(1);            // and no re-exit
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("exits after the timeout even if shutdown hangs (End-task grace window)", () => {
      const exit = vi.fn();
      const shutdown = vi.fn(() => new Promise<void>(() => {})); // never resolves
      const handler = createQuitHandler(shutdown, exit, 3000);
      handler({ preventDefault: vi.fn() });
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3000);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it("exits at most once even if shutdown resolves after the timeout fired", async () => {
      const exit = vi.fn();
      let resolveShutdown!: () => void;
      const shutdown = vi.fn(() => new Promise<void>((r) => { resolveShutdown = r; }));
      const handler = createQuitHandler(shutdown, exit, 1000);
      handler({ preventDefault: vi.fn() });
      vi.advanceTimersByTime(1000);
      resolveShutdown();
      await Promise.resolve(); await Promise.resolve();
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });
});
