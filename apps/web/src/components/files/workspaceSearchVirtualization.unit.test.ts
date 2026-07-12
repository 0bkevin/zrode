import { describe, expect, it } from "vite-plus/test";

import {
  calculateWorkspaceSearchVirtualWindow,
  WORKSPACE_SEARCH_ROW_HEIGHT,
} from "./workspaceSearchVirtualization";

describe("workspace search result virtualization", () => {
  it("renders only the visible rows and bounded overscan", () => {
    const window = calculateWorkspaceSearchVirtualWindow({
      rowCount: 2_000,
      scrollTop: 24_000,
      viewportHeight: 240,
      overscanRows: 8,
    });

    expect(window).toEqual({
      startIndex: 992,
      endIndex: 1_018,
      offsetTop: 992 * WORKSPACE_SEARCH_ROW_HEIGHT,
      totalHeight: 2_000 * WORKSPACE_SEARCH_ROW_HEIGHT,
    });
    expect(window.endIndex - window.startIndex).toBe(26);
  });

  it("clamps a stale scroll offset after result rows shrink", () => {
    expect(
      calculateWorkspaceSearchVirtualWindow({
        rowCount: 3,
        scrollTop: 40_000,
        viewportHeight: 48,
        overscanRows: 0,
      }),
    ).toEqual({
      startIndex: 1,
      endIndex: 3,
      offsetTop: WORKSPACE_SEARCH_ROW_HEIGHT,
      totalHeight: 3 * WORKSPACE_SEARCH_ROW_HEIGHT,
    });
  });

  it("includes the partially visible row at the bottom of the viewport", () => {
    expect(
      calculateWorkspaceSearchVirtualWindow({
        rowCount: 10,
        scrollTop: WORKSPACE_SEARCH_ROW_HEIGHT - 1,
        viewportHeight: WORKSPACE_SEARCH_ROW_HEIGHT,
        overscanRows: 0,
      }),
    ).toMatchObject({ startIndex: 0, endIndex: 2 });
  });

  it("handles empty results and invalid negative layout inputs", () => {
    expect(
      calculateWorkspaceSearchVirtualWindow({
        rowCount: 0,
        scrollTop: -10,
        viewportHeight: -20,
      }),
    ).toEqual({ startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 });
  });
});
