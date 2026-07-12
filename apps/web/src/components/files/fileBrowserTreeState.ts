import type {
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  FileTreeScrollToPathOptions,
} from "@pierre/trees";

export interface FileBrowserTreeModel {
  getItem(path: string): FileTreeItemHandle | null;
  getSelectedPaths(): readonly string[];
  resetPaths(
    paths: readonly string[],
    options?: { readonly initialExpandedPaths?: readonly string[] },
  ): void;
  scrollToPath(path: string, options?: FileTreeScrollToPathOptions): void;
}

function isDirectoryHandle(item: FileTreeItemHandle | null): item is FileTreeDirectoryHandle {
  return item?.isDirectory() === true;
}

export function areFileTreePathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

export function activeFileAncestorPaths(relativePath: string): string[] {
  const segments = relativePath.split("/").filter(Boolean);
  return segments.slice(0, -1).map((_, index) => `${segments.slice(0, index + 1).join("/")}/`);
}

export function shouldRevealActiveFile(input: {
  readonly activePathChanged: boolean;
  readonly pathsChanged: boolean;
  readonly previouslyVisible: boolean;
  readonly visible: boolean;
}): boolean {
  return (
    input.visible && (input.pathsChanged || input.activePathChanged || !input.previouslyVisible)
  );
}

/**
 * Rebuild the coarse tree snapshot only when its canonical path set changed.
 * Pierre preserves selection/focus itself; passing the currently expanded
 * directories prevents a refresh from collapsing the user's navigation state.
 */
export function resetFileTreePathsPreservingExpansion(input: {
  readonly model: FileBrowserTreeModel;
  readonly previousDirectoryPaths: readonly string[];
  readonly previousTreePaths: readonly string[];
  readonly treePaths: readonly string[];
}): boolean {
  if (areFileTreePathsEqual(input.previousTreePaths, input.treePaths)) return false;

  const nextPaths = new Set(input.treePaths);
  const initialExpandedPaths = input.previousDirectoryPaths.flatMap((directoryPath) => {
    const item = input.model.getItem(directoryPath);
    if (!isDirectoryHandle(item) || !item.isExpanded()) return [];
    const canonicalPath = item.getPath();
    return nextPaths.has(canonicalPath) ? [canonicalPath] : [];
  });

  input.model.resetPaths(input.treePaths, { initialExpandedPaths });
  return true;
}

/**
 * Reveal an indexed active file without moving keyboard focus. Callers suppress
 * selection callbacks around this operation so programmatic selection cannot
 * reopen the same file surface.
 */
export function revealActiveFile(input: {
  readonly activeRelativePath: string | null;
  readonly entryKinds: ReadonlyMap<string, "file" | "directory">;
  readonly model: FileBrowserTreeModel;
}): boolean {
  const activePath = input.activeRelativePath;
  if (!activePath || input.entryKinds.get(activePath) !== "file") return false;

  const activeItem = input.model.getItem(activePath);
  if (!activeItem || activeItem.isDirectory()) return false;

  for (const ancestorPath of activeFileAncestorPaths(activePath)) {
    const ancestor = input.model.getItem(ancestorPath);
    if (isDirectoryHandle(ancestor) && !ancestor.isExpanded()) {
      ancestor.expand();
    }
  }

  for (const selectedPath of input.model.getSelectedPaths()) {
    if (selectedPath !== activeItem.getPath()) {
      input.model.getItem(selectedPath)?.deselect();
    }
  }
  if (!activeItem.isSelected()) activeItem.select();
  input.model.scrollToPath(activePath, { focus: false, offset: "nearest" });
  return true;
}
