import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveCapturePath } from "../../src/main/ipc.js";

/**
 * resolveCapturePath is the pure path-resolution + validation logic behind
 * `capture:save`. It must honor a configured directory (not hardcoded Downloads),
 * keep the png/gif filename whitelist, and keep the resolved path INSIDE the
 * configured dir (traversal defense-in-depth).
 */
describe("resolveCapturePath", () => {
  const dir = path.resolve("/tmp/some capture dir");

  it("resolves a valid png/gif filename into the configured directory", () => {
    expect(resolveCapturePath(dir, "shot.png")).toBe(path.join(dir, "shot.png"));
    expect(resolveCapturePath(dir, "anim.gif")).toBe(path.join(dir, "anim.gif"));
  });

  it("strips any directory component from the name (basename only)", () => {
    expect(resolveCapturePath(dir, "/etc/evil.png")).toBe(path.join(dir, "evil.png"));
  });

  it("neutralizes traversal sequences instead of escaping the dir", () => {
    // basename() strips the leading "../../", so the result is safely confined to
    // the configured dir rather than escaping it.
    const out = resolveCapturePath(dir, "../../escape.png");
    expect(out).toBe(path.join(dir, "escape.png"));
    expect(out.startsWith(dir + path.sep)).toBe(true);
  });

  it("confines any embedded subpath to the configured dir (basename only)", () => {
    const out = resolveCapturePath(dir, "sub/dir/x.png");
    expect(out).toBe(path.join(dir, "x.png"));
    expect(out.startsWith(dir + path.sep)).toBe(true);
  });

  it("rejects non-png/gif extensions", () => {
    expect(() => resolveCapturePath(dir, "shot.exe")).toThrow(/invalid capture filename/);
    expect(() => resolveCapturePath(dir, "noext")).toThrow(/invalid capture filename/);
  });

  it("writes into the configured dir, not a hardcoded Downloads", () => {
    const other = path.resolve("/var/captures");
    expect(resolveCapturePath(other, "ok.png")).toBe(path.join(other, "ok.png"));
  });

  it("accepts a drive-root capture dir (trailing-separator prefix bug)", () => {
    // path.resolve keeps the trailing sep at a root, so the old `base + sep`
    // prefix became "D:\\\\" / "//" and startsWith failed on EVERY save. On win32
    // a drive root is "D:\\"; on posix the analogous root is "/".
    const root = process.platform === "win32" ? "D:\\" : "/";
    const out = resolveCapturePath(root, "shot.png");
    expect(out).toBe(path.join(path.resolve(root), "shot.png"));
  });

  it("rejects Windows reserved device names", () => {
    expect(() => resolveCapturePath(dir, "CON.png")).toThrow(/invalid capture filename/);
    expect(() => resolveCapturePath(dir, "nul.gif")).toThrow(/invalid capture filename/);
    expect(() => resolveCapturePath(dir, "COM1.png")).toThrow(/invalid capture filename/);
    // A name merely CONTAINING a reserved word is fine.
    expect(resolveCapturePath(dir, "console.png")).toBe(path.join(dir, "console.png"));
  });

  it("rejects a base name ending in a space or dot", () => {
    expect(() => resolveCapturePath(dir, "shot .png")).toThrow(/invalid capture filename/);
    expect(() => resolveCapturePath(dir, "shot..png")).toThrow(/invalid capture filename/);
  });
});
