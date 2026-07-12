import { FileTree } from "@pierre/trees";
import { describe, expect, it, vi } from "@effect/vitest";

import {
  clearFailedPierreCreation,
  queueUnchangedPierreCreationCommit,
  reconcileOptimisticWorkspaceEntries,
  type WorkspaceCreationSession,
} from "./fileBrowserCreation";

describe("Pierre inline workspace creation adapter", () => {
  it("adds provisional files and folders and starts real inline renaming", () => {
    const tree = new FileTree({
      paths: ["src/", "src/index.ts"],
      renaming: true,
    });

    tree.add("src/New File");
    tree.add("src/New Folder/");

    expect(tree.getItem("src/New File")?.isDirectory()).toBe(false);
    expect(tree.getItem("src/New Folder")?.isDirectory()).toBe(true);
    expect(tree.startRenaming("src/New File", { removeIfCanceled: true })).toBe(true);
    tree.cleanUp();
  });

  it("exposes provisional cancellation through the remove mutation", () => {
    const onRemove = vi.fn();
    const tree = new FileTree({ paths: [], renaming: true });
    const unsubscribe = tree.onMutation("remove", onRemove);
    tree.add("New Folder/");
    tree.remove("New Folder/", { recursive: true });

    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ path: "New Folder/" }));
    unsubscribe();
    tree.cleanUp();
  });

  it("persists an unchanged default name after Pierre accepts Enter without onRename", async () => {
    const tree = new FileTree({ paths: [], renaming: true });
    tree.add("New File");
    expect(tree.startRenaming("New File", { removeIfCanceled: true })).toBe(true);

    let session: WorkspaceCreationSession | null = {
      kind: "file",
      path: "New File",
      status: "editing",
    };
    const commit = vi.fn((current: WorkspaceCreationSession) => {
      session = { ...current, status: "committing" };
    });
    queueUnchangedPierreCreationCommit(() => session, commit);
    await Promise.resolve();

    expect(commit).toHaveBeenCalledWith({ kind: "file", path: "New File", status: "editing" });
    expect(session?.status).toBe("committing");
    tree.cleanUp();
  });

  it("removes a validation-failed provisional row and clears the active session", () => {
    const tree = new FileTree({ paths: [], renaming: true });
    tree.add("New Folder/");
    let session: WorkspaceCreationSession | null = {
      kind: "directory",
      path: "New Folder/",
      status: "editing",
    };
    let error = "";

    clearFailedPierreCreation({
      session,
      remove: (path, recursive) => tree.remove(path, recursive ? { recursive: true } : undefined),
      clearSession: () => {
        session = null;
      },
      reportError: (message) => {
        error = message;
      },
      message: 'Name cannot include "/".',
    });

    expect(tree.getItem("New Folder/")).toBeNull();
    expect(session).toBeNull();
    expect(error).toBe('Name cannot include "/".');
    tree.cleanUp();
  });

  it("expires optimistic rows without coupling creation controls to index reconciliation", () => {
    const optimistic = [
      { id: 1, kind: "file" as const, path: "kept.ts", expiresAt: 2_000 },
      { id: 2, kind: "directory" as const, path: "indexed", expiresAt: 2_000 },
      { id: 3, kind: "file" as const, path: "expired.ts", expiresAt: 500 },
    ];

    expect(reconcileOptimisticWorkspaceEntries(optimistic, new Set(["indexed"]), 1_000)).toEqual([
      optimistic[0],
    ]);
  });
});
