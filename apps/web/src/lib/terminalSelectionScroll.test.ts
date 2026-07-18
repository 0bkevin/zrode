import { describe, expect, it } from "vite-plus/test";

import { consumeTerminalSelectionWheelRows } from "./terminalSelectionScroll";

describe("consumeTerminalSelectionWheelRows", () => {
  it("preserves fractional pixel-wheel movement between events", () => {
    const state = { remainder: 0 };

    expect(
      consumeTerminalSelectionWheelRows(state, {
        deltaY: 5,
        deltaMode: 0,
        rows: 24,
        cellHeight: 10,
      }),
    ).toBe(0);
    expect(
      consumeTerminalSelectionWheelRows(state, {
        deltaY: 5,
        deltaMode: 0,
        rows: 24,
        cellHeight: 10,
      }),
    ).toBe(1);
  });

  it("supports line and page wheel modes in both directions", () => {
    const state = { remainder: 0 };

    expect(
      consumeTerminalSelectionWheelRows(state, {
        deltaY: -3,
        deltaMode: 1,
        rows: 20,
        cellHeight: 10,
      }),
    ).toBe(-3);
    expect(
      consumeTerminalSelectionWheelRows(state, {
        deltaY: 1,
        deltaMode: 2,
        rows: 20,
        cellHeight: 10,
      }),
    ).toBe(20);
  });

  it("does not poison accumulated scrolling when geometry is invalid", () => {
    const state = { remainder: Number.NaN };

    expect(
      consumeTerminalSelectionWheelRows(state, {
        deltaY: 3,
        deltaMode: 0,
        rows: Number.NaN,
        cellHeight: Number.NaN,
      }),
    ).toBe(3);
    expect(state.remainder).toBe(0);
  });
});
