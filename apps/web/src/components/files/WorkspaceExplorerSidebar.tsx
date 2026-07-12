import type { EnvironmentId, FileExplorerPosition, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Files, PanelLeft, PanelRight, Search } from "lucide-react";
import { memo, useCallback } from "react";

import { cn } from "~/lib/utils";
import {
  selectThreadRightPanelState,
  type FileRevealTarget,
  type RightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import FileBrowserPanel from "./FileBrowserPanel";
import WorkspaceOpenEditors from "./WorkspaceOpenEditors";
import WorkspaceSearchView from "./WorkspaceSearchView";
import { fileDocumentStore } from "./fileDocumentRuntime";
import { isFileDocumentSnapshotUnsafe } from "./fileDocumentStore";

type FileSurface = Extract<RightPanelSurface, { kind: "file" }>;

interface WorkspaceExplorerSidebarProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  activeRelativePath: string | null;
  threadRef: ScopedThreadRef;
  pendingSurfaceIds: ReadonlySet<string>;
  onOpenFile: (relativePath: string, target?: FileRevealTarget) => void;
  fileExplorerPosition: FileExplorerPosition;
  onFileExplorerPositionChange: (position: FileExplorerPosition) => void;
  onCloseFile?: (surface: FileSurface) => void;
  onCloseAllFiles?: () => void;
}

function WorkspaceExplorerSidebar({
  environmentId,
  cwd,
  projectName,
  activeRelativePath,
  threadRef,
  pendingSurfaceIds,
  onOpenFile,
  fileExplorerPosition,
  onFileExplorerPositionChange,
  onCloseFile,
  onCloseAllFiles,
}: WorkspaceExplorerSidebarProps) {
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const view = panelState.workspaceSidebarView;
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const createDirectory = useAtomCommand(projectEnvironment.createDirectory, {
    reportFailure: false,
  });
  const deleteEntry = useAtomCommand(projectEnvironment.deleteEntry, { reportFailure: false });
  const prepareDeleteEntry = useAtomCommand(projectEnvironment.prepareDeleteEntry, {
    reportFailure: false,
  });

  const showExplorer = useCallback(() => {
    useRightPanelStore.getState().showWorkspaceExplorer(threadRef);
  }, [threadRef]);
  const showSearch = useCallback(() => {
    useRightPanelStore.getState().showWorkspaceSearch(threadRef);
  }, [threadRef]);

  const createFile = useCallback(
    async (relativePath: string) => {
      const result = await writeFile({
        environmentId,
        input: {
          cwd,
          relativePath,
          contents: "",
          precondition: { _tag: "must-not-exist" },
        },
      });
      if (result._tag === "Success") return;
      if (isAtomCommandInterrupted(result)) throw new Error("File creation was canceled.");
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error("Could not create the file.");
    },
    [cwd, environmentId, writeFile],
  );

  const createFolder = useCallback(
    async (relativePath: string) => {
      const result = await createDirectory({
        environmentId,
        input: { cwd, relativePath },
      });
      if (result._tag === "Success") return;
      if (isAtomCommandInterrupted(result)) throw new Error("Folder creation was canceled.");
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error("Could not create the folder.");
    },
    [createDirectory, cwd, environmentId],
  );

  const permanentlyDeleteEntry = useCallback(
    async (relativePath: string, kind: "file" | "directory") => {
      const includesPath = (candidate: string) =>
        candidate === relativePath ||
        (kind === "directory" && candidate.startsWith(`${relativePath}/`));
      const unsafe = fileDocumentStore
        .getUnsafeSnapshots()
        .filter(
          (snapshot) =>
            snapshot.key.environmentId === environmentId &&
            snapshot.key.cwd === cwd &&
            includesPath(snapshot.key.relativePath) &&
            isFileDocumentSnapshotUnsafe(snapshot),
        );
      if (unsafe.length > 0) {
        throw new Error(
          `Save or discard unsaved changes before deleting ${unsafe.length === 1 ? "this file" : "these files"}.`,
        );
      }

      const prepared = await prepareDeleteEntry({
        environmentId,
        input:
          kind === "directory"
            ? { cwd, relativePath, expectedKind: "directory", recursive: true }
            : { cwd, relativePath, expectedKind: "file", recursive: false },
      });
      if (prepared._tag !== "Success") {
        if (isAtomCommandInterrupted(prepared))
          throw new Error("Deletion preparation was canceled.");
        const error = squashAtomCommandFailure(prepared);
        throw error instanceof Error
          ? error
          : new Error("Could not inspect the item for deletion.");
      }

      const confirmed = window.confirm(
        kind === "directory"
          ? `Permanently delete “${relativePath}” and its ${prepared.value.descendantCount.toLocaleString()} descendant${prepared.value.descendantCount === 1 ? "" : "s"}? This cannot be undone.`
          : `Permanently delete “${relativePath}”? This cannot be undone.`,
      );
      if (!confirmed) return { status: "canceled" } as const;

      const result = await deleteEntry({
        environmentId,
        input:
          kind === "directory"
            ? {
                cwd,
                relativePath,
                expectedKind: "directory",
                recursive: true,
                entryRevision: prepared.value.entryRevision,
                permanentlyDelete: true,
              }
            : {
                cwd,
                relativePath,
                expectedKind: "file",
                recursive: false,
                entryRevision: prepared.value.entryRevision,
                permanentlyDelete: true,
              },
      });
      if (result._tag !== "Success") {
        if (isAtomCommandInterrupted(result)) throw new Error("Deletion was canceled.");
        const error = squashAtomCommandFailure(result);
        throw error instanceof Error ? error : new Error("Could not permanently delete the item.");
      }

      const affectedSurfaceIds = panelState.surfaces.flatMap((surface) => {
        if (surface.kind !== "file" || !includesPath(surface.relativePath)) return [];
        // A clean document can become dirty while the RPC is in flight. Keep
        // that view open as an orphan instead of discarding its in-memory text.
        const current = fileDocumentStore.getSnapshot({
          environmentId,
          cwd,
          relativePath: surface.relativePath,
        });
        return current && isFileDocumentSnapshotUnsafe(current) ? [] : [surface.id];
      });
      if (affectedSurfaceIds.length > 0) {
        useRightPanelStore.getState().closeFileSurfaces(threadRef, affectedSurfaceIds);
      }
      return { status: "deleted" } as const;
    },
    [cwd, deleteEntry, environmentId, panelState.surfaces, prepareDeleteEntry, threadRef],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-workspace-sidebar={view}>
      <div className="flex h-9 shrink-0 items-center border-b border-border/60 px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-foreground">
          {view === "search" ? "Search" : "Explorer"}
        </span>
        <div className="flex items-center gap-0.5">
          <div
            className="flex items-center gap-0.5"
            role="tablist"
            aria-label="Workspace sidebar view"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "explorer"}
              aria-label="Explorer"
              title="Explorer"
              className={cn(
                "rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                view === "explorer" && "bg-accent text-foreground",
              )}
              onClick={showExplorer}
            >
              <Files className="size-3.5" />
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "search"}
              aria-label="Search"
              title="Search in Files"
              className={cn(
                "rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                view === "search" && "bg-accent text-foreground",
              )}
              onClick={showSearch}
            >
              <Search className="size-3.5" />
            </button>
          </div>
          <button
            type="button"
            aria-label={`Move Explorer to the ${fileExplorerPosition === "left" ? "right" : "left"}`}
            title={`Move Explorer to the ${fileExplorerPosition === "left" ? "right" : "left"}`}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() =>
              onFileExplorerPositionChange(fileExplorerPosition === "left" ? "right" : "left")
            }
          >
            {fileExplorerPosition === "left" ? (
              <PanelRight className="size-3.5" />
            ) : (
              <PanelLeft className="size-3.5" />
            )}
          </button>
        </div>
      </div>
      {view === "search" ? (
        <WorkspaceSearchView
          environmentId={environmentId}
          cwd={cwd}
          focusRequestId={panelState.workspaceSidebarFocusRequestId}
          onOpenFile={(relativePath, target) => onOpenFile(relativePath, target)}
        />
      ) : null}
      <div
        className={cn("min-h-0 flex-1 flex-col", view === "explorer" ? "flex" : "hidden")}
        aria-hidden={view === "explorer" ? undefined : true}
      >
        {onCloseFile && onCloseAllFiles ? (
          <WorkspaceOpenEditors
            threadRef={threadRef}
            pendingSurfaceIds={pendingSurfaceIds}
            onCloseFile={onCloseFile}
            onCloseAllFiles={onCloseAllFiles}
          />
        ) : null}
        <FileBrowserPanel
          key={`${environmentId}:${cwd}`}
          environmentId={environmentId}
          cwd={cwd}
          projectName={projectName}
          activeRelativePath={activeRelativePath}
          onOpenFile={(relativePath) => onOpenFile(relativePath)}
          onCreateFile={createFile}
          onCreateDirectory={createFolder}
          onDeleteEntry={permanentlyDeleteEntry}
          onShowSearch={showSearch}
          visible={view === "explorer"}
        />
      </div>
    </div>
  );
}

export default memo(WorkspaceExplorerSidebar);
