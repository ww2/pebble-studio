import { describe, it, expect, vi } from "vitest";
import { WarmStandby } from "../../src/main/backend/warmStandby.js";
import type { BootToken } from "../../src/main/backend/bootEmulator.js";
import type { PlatformId } from "../../src/shared/types.js";

/** A controllable fake boot: resolves when `release()` is called (or rejects via
 * `fail()`), records every (id, token) it was invoked with, and honors the token
 * so a cancel mid-boot is observable. */
function makeFakeBoot() {
  const calls: Array<{ id: PlatformId; token: BootToken }> = [];
  let resolveOne: ((ep: unknown) => void) | null = null;
  let rejectOne: ((e: unknown) => void) | null = null;
  const boot = vi.fn(async (id: PlatformId, token: BootToken) => {
    calls.push({ id, token });
    return new Promise<{ host: string; port: number; wsPath: string }>((resolve, reject) => {
      resolveOne = resolve as (ep: unknown) => void;
      rejectOne = reject;
    });
  });
  return {
    boot,
    calls,
    release: (ep = { host: "127.0.0.1", port: 6080, wsPath: "/ws" }): void => resolveOne?.(ep),
    fail: (e: unknown = new Error("boot failed")): void => rejectOne?.(e),
  };
}

function makeStandby(over: Partial<{
  enabled: () => boolean;
  boot: ReturnType<typeof makeFakeBoot>["boot"];
  kill: () => Promise<void>;
  onError: (e: unknown) => void;
}> = {}) {
  const kill = over.kill ?? vi.fn(async () => {});
  const ws = new WarmStandby<{ host: string; port: number; wsPath: string }>({
    enabled: over.enabled ?? (() => true),
    boot: over.boot ?? (async () => ({ host: "h", port: 1, wsPath: "/w" })),
    kill,
    onError: over.onError,
  });
  return { ws, kill };
}

describe("WarmStandby", () => {
  it("starts idle", () => {
    const { ws } = makeStandby();
    expect(ws.state()).toBe("idle");
  });

  it("kick → booting, then ready once the boot resolves", async () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot });
    ws.kick("emery");
    expect(ws.state()).toBe("booting");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].id).toBe("emery");
    fake.release();
    await ws.claim("emery"); // settle the in-flight promise
    // claim consumed it → 'claimed'; re-check via a fresh standby for 'ready'
  });

  it("reaches 'ready' after the boot resolves when unclaimed", async () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot });
    ws.kick("emery");
    const p = ws.claim(null as unknown as PlatformId); // does NOT claim (wrong id) → still owned
    expect(p).toBeNull();
    fake.release();
    // Let the internal promise settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.state()).toBe("ready");
  });

  it("kick→claim(same id) returns the same boot result, booting only once", async () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot });
    ws.kick("emery");
    const claimed = ws.claim("emery");
    expect(claimed).not.toBeNull();
    expect(ws.state()).toBe("claimed");
    fake.release({ host: "127.0.0.1", port: 6080, wsPath: "/ws" });
    const ep = await claimed!;
    expect(ep).toEqual({ host: "127.0.0.1", port: 6080, wsPath: "/ws" });
    expect(fake.boot).toHaveBeenCalledTimes(1); // boot fn ran exactly once
  });

  it("claim(other id) returns null and does NOT consume the warm boot", () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot });
    ws.kick("emery");
    expect(ws.claim("basalt")).toBeNull();
    expect(ws.state()).toBe("booting"); // still owned by the emery boot
  });

  it("cancel() flips the boot token and awaits killAll before returning", async () => {
    const fake = makeFakeBoot();
    const order: string[] = [];
    const kill = vi.fn(async () => { order.push("kill"); });
    const { ws } = makeStandby({ boot: fake.boot, kill });
    ws.kick("emery");
    const token = fake.calls[0].token;
    expect(token.cancelled).toBe(false);
    await ws.cancel();
    expect(token.cancelled).toBe(true); // token flipped
    expect(kill).toHaveBeenCalledTimes(1); // killAll awaited
    expect(order).toEqual(["kill"]);
    expect(ws.state()).toBe("idle");
  });

  it("cancel() is a no-op (no kill) when idle", async () => {
    const { ws, kill } = makeStandby();
    await ws.cancel();
    expect(kill).not.toHaveBeenCalled();
    expect(ws.state()).toBe("idle");
  });

  it("cancel() does NOT kill an already-claimed (live) boot", async () => {
    const fake = makeFakeBoot();
    const kill = vi.fn(async () => {});
    const { ws } = makeStandby({ boot: fake.boot, kill });
    ws.kick("emery");
    const claimed = ws.claim("emery");
    fake.release();
    await claimed!;
    await ws.cancel();
    expect(kill).not.toHaveBeenCalled(); // claimed → cancel must not tear down the live watch
  });

  it("claim after 'claimed' returns null (single-shot)", async () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot });
    ws.kick("emery");
    const first = ws.claim("emery");
    expect(first).not.toBeNull();
    expect(ws.claim("emery")).toBeNull(); // already claimed
    fake.release();
    await first!;
  });

  it("disabled setting → kick no-ops (stays idle, boot never called)", () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ enabled: () => false, boot: fake.boot });
    ws.kick("emery");
    expect(ws.state()).toBe("idle");
    expect(fake.boot).not.toHaveBeenCalled();
    expect(ws.claim("emery")).toBeNull();
  });

  it("kick is single-shot: a second kick while booting is ignored", () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot });
    ws.kick("emery");
    ws.kick("basalt"); // ignored
    expect(fake.boot).toHaveBeenCalledTimes(1);
    expect(fake.calls[0].id).toBe("emery");
  });

  it("a boot failure resets to idle and reports via onError; a later claim returns null", async () => {
    const fake = makeFakeBoot();
    const onError = vi.fn();
    const { ws } = makeStandby({ boot: fake.boot, onError });
    ws.kick("emery");
    fake.fail(new Error("qemu died"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.state()).toBe("idle");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(ws.claim("emery")).toBeNull(); // failed boot is not claimable
  });

  it("kick errors do not surface as an unhandled rejection (init never awaits)", async () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot, onError: () => {} });
    ws.kick("emery"); // nobody awaits the internal promise
    fake.fail(new Error("boom"));
    // If the rejection were unhandled, this microtask flush would log/throw.
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.state()).toBe("idle");
  });

  it("a claimed boot that fails rejects the claimer (caller falls back to a cold boot)", async () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot, onError: () => {} });
    ws.kick("emery");
    const claimed = ws.claim("emery");
    fake.fail(new Error("nope"));
    await expect(claimed!).rejects.toThrow("nope");
  });

  it("currentToken() exposes the in-flight boot token for adoption, null when idle", () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot });
    expect(ws.currentToken()).toBeNull();
    ws.kick("emery");
    expect(ws.currentToken()).toBe(fake.calls[0].token);
  });

  it("currentBoard() reports the board being pre-booted, null when idle", () => {
    const fake = makeFakeBoot();
    const { ws } = makeStandby({ boot: fake.boot });
    expect(ws.currentBoard()).toBeNull();
    ws.kick("emery");
    expect(ws.currentBoard()).toBe("emery");
  });

  it("a warm-ready boot is claimed and resolves immediately (fast first Launch)", async () => {
    const { ws } = makeStandby({ boot: async () => ({ host: "127.0.0.1", port: 6080, wsPath: "/ws" }) });
    ws.kick("emery");
    await new Promise((r) => setTimeout(r, 0)); // let it reach 'ready'
    expect(ws.state()).toBe("ready");
    const claimed = ws.claim("emery");
    expect(claimed).not.toBeNull();
    const ep = await claimed!;
    expect(ep.port).toBe(6080);
  });

  it("reset() clears state and flips the token without killing", () => {
    const fake = makeFakeBoot();
    const kill = vi.fn(async () => {});
    const { ws } = makeStandby({ boot: fake.boot, kill });
    ws.kick("emery");
    const token = fake.calls[0].token;
    ws.reset();
    expect(token.cancelled).toBe(true);
    expect(ws.state()).toBe("idle");
    expect(kill).not.toHaveBeenCalled();
    expect(ws.claim("emery")).toBeNull();
  });
});
