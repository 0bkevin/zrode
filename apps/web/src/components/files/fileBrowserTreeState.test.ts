import type { FileTreeDirectoryHandle, FileTreeFileHandle } from "@pierre/trees";
import { describe, expect, it, vi } from "vite-plus/test";

import type { FileBrowserTreeModel } from "./fileBrowserTreeState";
import {
  activeFileAncestorPaths,
  resetFileTreePathsPreservingExpansion,
  resolveFileTreeBulkFolderAction,
  revealActiveFile,
  shouldRevealActiveFile,
  toggleAllFileTreeDirectories,
} from "./fileBrowserTreeState";

function directoryHandle(path: string, expanded: boolean): FileTreeDirectoryHandle {
  return {
    collapse: vi.fn(),
    deselect: vi.fn(),
    expand: vi.fn(),
    focus: vi.fn(),
    getPath: () => path,
    isDirectory: () => true,
    isExpanded: () => expanded,
    isFocused: () => false,
    isSelected: () => false,
    select: vi.fn(),
    toggle: vi.fn(),
    toggleSelect: vi.fn(),
  };
}

function fileHandle(path: string, selected = false): FileTreeFileHandle {
  return {
    deselect: vi.fn(),
    focus: vi.fn(),
    getPath: () => path,
    isDirectory: () => false,
    isFocused: () => false,
    isSelected: () => selected,
    select: vi.fn(),
    toggleSelect: vi.fn(),
  };
}

function treeModel(
  items: ReadonlyMap<string, FileTreeDirectoryHandle | FileTreeFileHandle>,
  selectedPaths: readonly string[] = [],
): FileBrowserTreeModel {
  return {
    getItem: (path) =>
      items.get(path) ?? items.get(path.endsWith("/") ? path.slice(0, -1) : `${path}/`) ?? null,
    getSelectedPaths: () => selectedPaths,
    resetPaths: vi.fn(),
    scrollToPath: vi.fn(),
  };
}

describe("file browser tree state", () => {
  it("defers hidden reveals and forces one when the tree becomes visible", () => {
    expect(
      shouldRevealActiveFile({
        activePathChanged: true,
        pathsChanged: true,
        previouslyVisible: true,
        visible: false,
      }),
    ).toBe(false);
    expect(
      shouldRevealActiveFile({
        activePathChanged: false,
        pathsChanged: false,
        previouslyVisible: false,
        visible: true,
      }),
    ).toBe(true);
    expect(
      shouldRevealActiveFile({
        activePathChanged: false,
        pathsChanged: false,
        previouslyVisible: true,
        visible: true,
      }),
    ).toBe(false);
  });

  it("does not reset identical paths and preserves surviving expanded directories", () => {
    const src = directoryHandle("src/", true);
    const removed = directoryHandle("removed/", true);
    const model = treeModel(
      new Map<string, FileTreeDirectoryHandle | FileTreeFileHandle>([
        ["src/", src],
        ["removed/", removed],
      ]),
    );

    expect(
      resetFileTreePathsPreservingExpansion({
        model,
        previousDirectoryPaths: ["src", "removed"],
        previousTreePaths: ["src/", "src/index.ts", "removed/"],
        treePaths: ["src/", "src/index.ts"],
      }),
    ).toBe(true);
    expect(model.resetPaths).toHaveBeenCalledWith(["src/", "src/index.ts"], {
      initialExpandedPaths: ["src/"],
    });

    vi.mocked(model.resetPaths).mockClear();
    expect(
      resetFileTreePathsPreservingExpansion({
        model,
        previousDirectoryPaths: ["src"],
        previousTreePaths: ["src/", "src/index.ts"],
        treePaths: ["src/", "src/index.ts"],
      }),
    ).toBe(false);
    expect(model.resetPaths).not.toHaveBeenCalled();
  });

  it("expands, selects, and scrolls to an indexed active file", () => {
    const src = directoryHandle("src/", false);
    const components = directoryHandle("src/components/", false);
    const previous = fileHandle("README.md", true);
    const active = fileHandle("src/components/App.tsx");
    const model = treeModel(
      new Map<string, FileTreeDirectoryHandle | FileTreeFileHandle>([
        ["src/", src],
        ["src/components/", components],
        ["README.md", previous],
        ["src/components/App.tsx", active],
      ]),
      ["README.md"],
    );

    expect(activeFileAncestorPaths("src/components/App.tsx")).toEqual(["src/", "src/components/"]);
    expect(
      revealActiveFile({
        activeRelativePath: "src/components/App.tsx",
        entryKinds: new Map([["src/components/App.tsx", "file"]]),
        model,
      }),
    ).toBe(true);
    expect(src.expand).toHaveBeenCalledOnce();
    expect(components.expand).toHaveBeenCalledOnce();
    expect(previous.deselect).toHaveBeenCalledOnce();
    expect(active.select).toHaveBeenCalledOnce();
    expect(model.scrollToPath).toHaveBeenCalledWith("src/components/App.tsx", {
      focus: false,
      offset: "nearest",
    });
  });

  it("does nothing when the active path is absent from a partial index", () => {
    const model = treeModel(new Map());
    expect(
      revealActiveFile({
        activeRelativePath: "omitted.ts",
        entryKinds: new Map(),
        model,
      }),
    ).toBe(false);
    expect(model.scrollToPath).not.toHaveBeenCalled();
  });

  it("expands every closed folder when the tree is only partially expanded", () => {
    const open = directoryHandle("open/", true);
    const closed = directoryHandle("closed/", false);
    const model = treeModel(
      new Map<string, FileTreeDirectoryHandle | FileTreeFileHandle>([
        ["open/", open],
        ["closed/", closed],
      ]),
    );

    expect(resolveFileTreeBulkFolderAction({ directoryPaths: ["open", "closed"], model })).toBe(
      "expand",
    );
    expect(toggleAllFileTreeDirectories({ directoryPaths: ["open", "closed"], model })).toBe(
      "expand",
    );
    expect(open.expand).not.toHaveBeenCalled();
    expect(closed.expand).toHaveBeenCalledOnce();
  });

  it("collapses every folder once the entire tree is expanded", () => {
    const first = directoryHandle("first/", true);
    const second = directoryHandle("second/", true);
    const model = treeModel(
      new Map<string, FileTreeDirectoryHandle | FileTreeFileHandle>([
        ["first/", first],
        ["second/", second],
      ]),
    );

    expect(toggleAllFileTreeDirectories({ directoryPaths: ["first", "second"], model })).toBe(
      "collapse",
    );
    expect(first.collapse).toHaveBeenCalledOnce();
    expect(second.collapse).toHaveBeenCalledOnce();
  });

  it("disables the bulk folder action when the tree has no known directories", () => {
    const model = treeModel(new Map());
    expect(resolveFileTreeBulkFolderAction({ directoryPaths: [], model })).toBeNull();
    expect(toggleAllFileTreeDirectories({ directoryPaths: [], model })).toBeNull();
  });
});
