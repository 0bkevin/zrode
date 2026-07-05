import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";

export interface FileCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileCommentAnnotationGroup {
  entries: FileCommentAnnotationEntry[];
}

export type FileCommentLineAnnotation = LineAnnotation<FileCommentAnnotationGroup>;

let fileCommentSequence = 0;

export function nextFileCommentId(): string {
  fileCommentSequence += 1;
  return `file-comment-${Date.now()}-${fileCommentSequence}`;
}

export function normalizeFileCommentRange(range: SelectedLineRange): {
  startLine: number;
  endLine: number;
} {
  return {
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

export function formatFileCommentRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine} to L${endLine}`;
}

export function areFileCommentAnnotationsEqual(
  left: ReadonlyArray<FileCommentLineAnnotation>,
  right: ReadonlyArray<FileCommentLineAnnotation>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.lineNumber !== b.lineNumber) return false;
    const aEntries = a.metadata.entries;
    const bEntries = b.metadata.entries;
    if (aEntries.length !== bEntries.length) return false;
    for (let entryIndex = 0; entryIndex < aEntries.length; entryIndex += 1) {
      const aEntry = aEntries[entryIndex]!;
      const bEntry = bEntries[entryIndex]!;
      if (
        aEntry.id !== bEntry.id ||
        aEntry.kind !== bEntry.kind ||
        aEntry.startLine !== bEntry.startLine ||
        aEntry.endLine !== bEntry.endLine ||
        aEntry.text !== bEntry.text
      ) {
        return false;
      }
    }
  }
  return true;
}

export function remapFileCommentAnnotations(
  annotations: ReadonlyArray<FileCommentLineAnnotation>,
): FileCommentLineAnnotation[] {
  return annotations.map((annotation) => ({
    ...annotation,
    metadata: {
      entries: annotation.metadata.entries.map((entry) => {
        const lineCount = entry.endLine - entry.startLine;
        return {
          ...entry,
          endLine: annotation.lineNumber,
          startLine: Math.max(1, annotation.lineNumber - lineCount),
        };
      }),
    },
  }));
}
