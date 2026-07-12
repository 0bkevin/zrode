import type { DiffsEditorSelection } from "@pierre/diffs";

import type { FileRevealPosition, FileRevealTarget } from "~/rightPanelStore";

interface SourceLine {
  readonly length: number;
}

function sourceLines(contents: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let lineStart = 0;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character !== 10 && character !== 13) continue;
    lines.push({ length: index - lineStart });
    if (character === 13 && contents.charCodeAt(index + 1) === 10) index += 1;
    lineStart = index + 1;
  }
  lines.push({ length: contents.length - lineStart });
  return lines;
}

function clampPosition(
  lines: readonly SourceLine[],
  position: FileRevealPosition,
): FileRevealPosition {
  const line = Math.min(Math.max(1, position.line), lines.length);
  // A position may sit immediately after the last UTF-16 code unit. This is
  // required for an exclusive match end and for a caret at end-of-line.
  const column = Math.min(Math.max(1, position.column), (lines[line - 1]?.length ?? 0) + 1);
  return { line, column };
}

/** Clamp a persisted/search reveal against the live document text. */
export function clampFileRevealTarget(
  contents: string,
  target: FileRevealTarget,
): FileRevealTarget {
  const lines = sourceLines(contents);
  if (target.kind === "line") {
    return { kind: "line", line: Math.min(Math.max(1, target.line), lines.length) };
  }
  return {
    kind: "range",
    start: clampPosition(lines, target.start),
    end: clampPosition(lines, target.end),
  };
}

/** Convert one-based UTF-16 search coordinates into Pierre's zero-based range. */
export function fileRevealTargetToEditorSelection(
  contents: string,
  target: FileRevealTarget,
): DiffsEditorSelection | null {
  const clamped = clampFileRevealTarget(contents, target);
  if (clamped.kind !== "range") return null;
  return {
    start: { line: clamped.start.line - 1, character: clamped.start.column - 1 },
    end: { line: clamped.end.line - 1, character: clamped.end.column - 1 },
    direction: "none",
  };
}

export function fileRevealTargetLine(
  contents: string,
  target: FileRevealTarget | null,
): number | null {
  if (target === null) return null;
  const clamped = clampFileRevealTarget(contents, target);
  return clamped.kind === "line" ? clamped.line : clamped.start.line;
}

/**
 * Line links are passive highlights and need the file virtualizer to reveal
 * them. Range targets are editor selections: Pierre already centers those
 * when `Editor.setSelections` runs. Letting both paths scroll the same range
 * makes the two virtual-scroll corrections fight and visibly oscillate.
 */
export function shouldManuallyScrollFileReveal(target: FileRevealTarget | null): boolean {
  return target?.kind === "line";
}
