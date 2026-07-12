import type { FileExplorerPosition } from "@t3tools/contracts";

export const FILE_EXPLORER_DEFAULT_WIDTH = 320;
export const FILE_EXPLORER_MIN_WIDTH = 240;
export const FILE_EXPLORER_MAX_WIDTH = 520;

export type FilePreviewLayoutMode = "docked" | "standalone";

const FILE_EXPLORER_MAX_CONTAINER_FRACTION = 0.46;

/**
 * Keep enough of the split container available for the file preview while
 * preserving a usable explorer minimum in unusually narrow panels.
 */
export function resolveFileExplorerMaxWidth(containerWidth: number | null): number {
  if (containerWidth === null || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return FILE_EXPLORER_MAX_WIDTH;
  }
  return Math.max(
    FILE_EXPLORER_MIN_WIDTH,
    Math.min(
      FILE_EXPLORER_MAX_WIDTH,
      Math.floor(containerWidth * FILE_EXPLORER_MAX_CONTAINER_FRACTION),
    ),
  );
}

export interface FileExplorerSplitLayout {
  readonly editorOrderClassName: "order-first" | "order-last";
  readonly explorerClassName: string;
  readonly resizeEdge: "left" | "right";
  readonly resizeHandleClassName: "-left-1" | "-right-1";
  readonly keyboardWidthDelta: Readonly<Record<"ArrowLeft" | "ArrowRight", number>>;
}

export interface FileExplorerPaneLayout {
  readonly showEditorPane: boolean;
  readonly explorerOnly: boolean;
}

/**
 * A docked Files surface gives its full width to Explorer until a file opens.
 * A dedicated Files window keeps the editor split visible as useful window
 * chrome, matching the normal file-open layout in that standalone context.
 */
export function resolveFileExplorerPaneLayout(
  mode: FilePreviewLayoutMode,
  hasOpenFile: boolean,
): FileExplorerPaneLayout {
  const explorerOnly = !hasOpenFile && mode === "docked";
  return {
    showEditorPane: hasOpenFile || mode === "standalone",
    explorerOnly,
  };
}

/**
 * Keep every directional detail of the split pane derived from one setting.
 * This avoids rendering two Explorer trees and preserves expansion/selection
 * state while the user moves the existing pane to the other side.
 */
export function resolveFileExplorerSplitLayout(
  position: FileExplorerPosition,
): FileExplorerSplitLayout {
  if (position === "left") {
    return {
      editorOrderClassName: "order-last",
      explorerClassName: "order-first border-r",
      resizeEdge: "right",
      resizeHandleClassName: "-right-1",
      keyboardWidthDelta: { ArrowLeft: -16, ArrowRight: 16 },
    };
  }

  return {
    editorOrderClassName: "order-first",
    explorerClassName: "order-last border-l",
    resizeEdge: "left",
    resizeHandleClassName: "-left-1",
    keyboardWidthDelta: { ArrowLeft: 16, ArrowRight: -16 },
  };
}
