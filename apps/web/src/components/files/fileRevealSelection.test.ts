import { describe, expect, it } from "vite-plus/test";

import {
  clampFileRevealTarget,
  fileRevealTargetLine,
  fileRevealTargetToEditorSelection,
  shouldManuallyScrollFileReveal,
} from "./fileRevealSelection";

describe("file reveal selection", () => {
  it("clamps line targets to the live document", () => {
    expect(clampFileRevealTarget("first\r\nsecond\n", { kind: "line", line: 99 })).toEqual({
      kind: "line",
      line: 3,
    });
    expect(fileRevealTargetLine("first", { kind: "line", line: -20 })).toBe(1);
  });

  it("preserves one-based UTF-16 columns and exclusive range ends", () => {
    const target = {
      kind: "range" as const,
      start: { line: 1, column: 2 },
      end: { line: 1, column: 4 },
    };
    // The emoji occupies two UTF-16 code units, so columns 2..4 select it.
    expect(fileRevealTargetToEditorSelection("a😀b", target)).toEqual({
      start: { line: 0, character: 1 },
      end: { line: 0, character: 3 },
      direction: "none",
    });
  });

  it("clamps range positions to each current line", () => {
    expect(
      clampFileRevealTarget("a\r\nxyz", {
        kind: "range",
        start: { line: 1, column: 100 },
        end: { line: 20, column: 100 },
      }),
    ).toEqual({
      kind: "range",
      start: { line: 1, column: 2 },
      end: { line: 2, column: 4 },
    });
  });

  it("assigns exactly one scroll owner to every reveal kind", () => {
    expect(shouldManuallyScrollFileReveal({ kind: "line", line: 10 })).toBe(true);
    expect(
      shouldManuallyScrollFileReveal({
        kind: "range",
        start: { line: 10, column: 2 },
        end: { line: 10, column: 5 },
      }),
    ).toBe(false);
    expect(shouldManuallyScrollFileReveal(null)).toBe(false);
  });
});
