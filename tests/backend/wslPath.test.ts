import { describe, it, expect } from "vitest";
import { toWslPath } from "../../src/main/backend/wslPath.js";

describe("toWslPath", () => {
  // Table-driven: each row is [input, expected].
  const cases: [string, string][] = [
    // Drive letters: lower-cased, backslashes -> forward slashes, /mnt/<drive> prefix.
    ["C:\\Users\\x\\a.pbw", "/mnt/c/Users/x/a.pbw"],
    ["D:\\Builds\\face.pbw", "/mnt/d/Builds/face.pbw"],
    // Spaces in the path are preserved verbatim (quoting is the caller's job).
    ["C:\\Users\\Jane Doe\\My Watch.pbw", "/mnt/c/Users/Jane Doe/My Watch.pbw"],
    // Mixed slashes still normalize to forward slashes.
    ["C:\\Users/x\\sub/a.pbw", "/mnt/c/Users/x/sub/a.pbw"],
    // Already-POSIX path is returned unchanged.
    ["/mnt/c/Users/x/a.pbw", "/mnt/c/Users/x/a.pbw"],
    ["/home/jason/app.pbw", "/home/jason/app.pbw"],
    // UNC / \\wsl$ / \\wsl.localhost paths already refer to the WSL filesystem;
    // only normalize backslashes to forward slashes.
    ["\\\\wsl$\\Ubuntu\\home\\jason\\a.pbw", "//wsl$/Ubuntu/home/jason/a.pbw"],
    ["\\\\wsl.localhost\\Ubuntu\\home\\jason\\a.pbw", "//wsl.localhost/Ubuntu/home/jason/a.pbw"],
    // Empty string is returned unchanged (defensive).
    ["", ""],
  ];

  it.each(cases)("converts %j -> %j", (input, expected) => {
    expect(toWslPath(input)).toBe(expected);
  });
});
