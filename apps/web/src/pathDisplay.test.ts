import { describe, expect, it } from "vite-plus/test";

import { formatPathTailForDisplay } from "./pathDisplay";

describe("formatPathTailForDisplay", () => {
  it.each([
    ["/Users/mike/dev-stuff/zrode", "zrode"],
    ["C:\\Users\\mike\\dev-stuff\\zrode", "zrode"],
    ["\\\\server\\share\\projects\\zrode\\", "zrode"],
    ["/Users/mike/dev-stuff\\zrode", "zrode"],
    ["/Users/mike/dev-stuff/zrode///", "zrode"],
    ["C:\\Users\\mike\\dev-stuff\\zrode\\\\", "zrode"],
    ["relative/path/to/file.ts", "file.ts"],
    ["single-segment", "single-segment"],
  ])("shows the final segment of %s", (path, expected) => {
    expect(formatPathTailForDisplay(path)).toBe(expected);
  });

  it.each(["/", "\\", "C:\\", "C:/"])("preserves the root path %s", (path) => {
    expect(formatPathTailForDisplay(path)).toBe(path);
  });

  it("trims surrounding whitespace without changing a root path", () => {
    expect(formatPathTailForDisplay("  C:\\  ")).toBe("C:\\");
  });

  it("preserves a whitespace-only fallback value", () => {
    expect(formatPathTailForDisplay("   ")).toBe("   ");
  });
});
