import { describe, expect, it } from "vite-plus/test";

import {
  FILE_EXPLORER_MAX_WIDTH,
  FILE_EXPLORER_MIN_WIDTH,
  resolveFileExplorerMaxWidth,
} from "./fileExplorerLayout";

describe("resolveFileExplorerMaxWidth", () => {
  it("caps wide containers at the explorer maximum", () => {
    expect(resolveFileExplorerMaxWidth(1_600)).toBe(FILE_EXPLORER_MAX_WIDTH);
  });

  it("tracks the renderable fraction for medium containers", () => {
    expect(resolveFileExplorerMaxWidth(800)).toBe(368);
    expect(resolveFileExplorerMaxWidth(600)).toBe(276);
  });

  it("retains a usable minimum for narrow or unavailable measurements", () => {
    expect(resolveFileExplorerMaxWidth(400)).toBe(FILE_EXPLORER_MIN_WIDTH);
    expect(resolveFileExplorerMaxWidth(null)).toBe(FILE_EXPLORER_MAX_WIDTH);
    expect(resolveFileExplorerMaxWidth(Number.NaN)).toBe(FILE_EXPLORER_MAX_WIDTH);
  });
});
