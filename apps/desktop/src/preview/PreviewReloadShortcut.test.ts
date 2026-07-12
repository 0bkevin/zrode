import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewReloadShortcut } from "./PreviewReloadShortcut.ts";

const input = (
  overrides: Partial<Parameters<typeof resolvePreviewReloadShortcut>[0]> = {},
): Parameters<typeof resolvePreviewReloadShortcut>[0] => ({
  type: "keyDown",
  key: "r",
  meta: false,
  control: false,
  shift: false,
  alt: false,
  isAutoRepeat: false,
  ...overrides,
});

describe("preview reload shortcut", () => {
  it("uses Cmd+R on macOS and Ctrl+R on Windows/Linux", () => {
    expect(resolvePreviewReloadShortcut(input({ meta: true }), "darwin")).toBe("reload");
    expect(resolvePreviewReloadShortcut(input({ control: true }), "win32")).toBe("reload");
    expect(resolvePreviewReloadShortcut(input({ control: true }), "linux")).toBe("reload");

    expect(resolvePreviewReloadShortcut(input({ control: true }), "darwin")).toBeNull();
    expect(resolvePreviewReloadShortcut(input({ meta: true }), "win32")).toBeNull();
    expect(resolvePreviewReloadShortcut(input({ meta: true }), "linux")).toBeNull();
  });

  it("hard reloads the preview when Shift is also held", () => {
    expect(resolvePreviewReloadShortcut(input({ meta: true, shift: true }), "darwin")).toBe(
      "hardReload",
    );
    expect(resolvePreviewReloadShortcut(input({ control: true, shift: true }), "linux")).toBe(
      "hardReload",
    );
  });

  it("consumes auto-repeat without restarting navigation", () => {
    expect(
      resolvePreviewReloadShortcut(input({ control: true, isAutoRepeat: true }), "linux"),
    ).toBe("suppress");
  });

  it("ignores unmodified, ambiguous, and unrelated input", () => {
    expect(resolvePreviewReloadShortcut(input(), "darwin")).toBeNull();
    expect(resolvePreviewReloadShortcut(input({ meta: true, control: true }), "darwin")).toBeNull();
    expect(resolvePreviewReloadShortcut(input({ meta: true, alt: true }), "darwin")).toBeNull();
    expect(resolvePreviewReloadShortcut(input({ meta: true, key: "x" }), "darwin")).toBeNull();
    expect(resolvePreviewReloadShortcut(input({ meta: true, type: "keyUp" }), "darwin")).toBeNull();
  });
});
