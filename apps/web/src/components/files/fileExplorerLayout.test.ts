import { describe, expect, it } from "vite-plus/test";

import {
  FILE_EXPLORER_MAX_WIDTH,
  FILE_EXPLORER_MIN_WIDTH,
  resolveFileExplorerMaxWidth,
  resolveFileExplorerPaneLayout,
  resolveFileExplorerSplitLayout,
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

describe("resolveFileExplorerPaneLayout", () => {
  it("lets Explorer fill a docked Files surface until a file opens", () => {
    expect(resolveFileExplorerPaneLayout("docked", false)).toEqual({
      showEditorPane: false,
      explorerOnly: true,
    });
    expect(resolveFileExplorerPaneLayout("docked", true)).toEqual({
      showEditorPane: true,
      explorerOnly: false,
    });
  });

  it("keeps the empty editor split in a dedicated Files window", () => {
    expect(resolveFileExplorerPaneLayout("standalone", false)).toEqual({
      showEditorPane: true,
      explorerOnly: false,
    });
    expect(resolveFileExplorerPaneLayout("standalone", true)).toEqual({
      showEditorPane: true,
      explorerOnly: false,
    });
  });
});

describe("resolveFileExplorerSplitLayout", () => {
  it("places the Explorer on the right with an inward-facing resize edge", () => {
    expect(resolveFileExplorerSplitLayout("right")).toEqual({
      editorOrderClassName: "order-first",
      explorerClassName: "order-last border-l",
      resizeEdge: "left",
      resizeHandleClassName: "-left-1",
      keyboardWidthDelta: { ArrowLeft: 16, ArrowRight: -16 },
    });
  });

  it("mirrors layout, drag edge, and keyboard resizing on the left", () => {
    expect(resolveFileExplorerSplitLayout("left")).toEqual({
      editorOrderClassName: "order-last",
      explorerClassName: "order-first border-r",
      resizeEdge: "right",
      resizeHandleClassName: "-right-1",
      keyboardWidthDelta: { ArrowLeft: -16, ArrowRight: 16 },
    });
  });
});
