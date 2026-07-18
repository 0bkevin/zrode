import type {
  ContextMenuItem,
  EnvironmentId,
  FileExplorerPosition,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Files, Search } from "lucide-react";
import { memo, type MouseEvent, type ReactNode, useCallback } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import {
  selectThreadRightPanelState,
  type FileRevealTarget,
  type RightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import FileBrowserPanel from "./FileBrowserPanel";
import type { FilePreviewLayoutMode } from "./fileExplorerLayout";
import WorkspaceOpenEditors from "./WorkspaceOpenEditors";
import WorkspaceSearchView from "./WorkspaceSearchView";
import { fileDocumentStore } from "./fileDocumentRuntime";
import { isFileDocumentSnapshotUnsafe } from "./fileDocumentStore";

type FileSurface = Extract<RightPanelSurface, { kind: "file" }>;

interface WorkspaceExplorerSidebarProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  layoutMode: FilePreviewLayoutMode;
  activeRelativePath: string | null;
  threadRef: ScopedThreadRef;
  pendingSurfaceIds: ReadonlySet<string>;
  onOpenFile: (relativePath: string, target?: FileRevealTarget) => void;
  fileExplorerPosition: FileExplorerPosition;
  onFileExplorerPositionChange: (position: FileExplorerPosition) => void;
  headerActions?: ReactNode;
  openEditors?: ReactNode;
  onCloseFile?: (surface: FileSurface) => void;
  onCloseAllFiles?: () => void;
}

function WorkspaceExplorerSidebar({
  environmentId,
  cwd,
  projectName,
  layoutMode,
  activeRelativePath,
  threadRef,
  pendingSurfaceIds,
  onOpenFile,
  fileExplorerPosition,
  onFileExplorerPositionChange,
  headerActions,
  openEditors,
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
  const handleExplorerContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const api = readLocalApi();
      if (!api) return;
      const nextPosition = fileExplorerPosition === "left" ? "right" : "left";
      const items: readonly ContextMenuItem<"move-explorer">[] = [
        {
          id: "move-explorer",
          label: `Move Explorer to the ${nextPosition}`,
        },
      ];
      void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then(
        (action) => {
          if (action === "move-explorer") onFileExplorerPositionChange(nextPosition);
        },
        () => undefined,
      );
    },
    [fileExplorerPosition, onFileExplorerPositionChange],
  );

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
        <div
          className="min-w-0 flex-1 cursor-default truncate text-[11px] font-semibold uppercase tracking-wide text-foreground"
          onContextMenu={handleExplorerContextMenu}
          title="Right-click for Explorer position"
        >
          {view === "search" ? "Search" : "Explorer"}
        </div>
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
          {headerActions}
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
        {openEditors ??
          (onCloseFile && onCloseAllFiles ? (
            <WorkspaceOpenEditors
              threadRef={threadRef}
              pendingSurfaceIds={pendingSurfaceIds}
              onCloseFile={onCloseFile}
              onCloseAllFiles={onCloseAllFiles}
            />
          ) : null)}
        <FileBrowserPanel
          key={`${environmentId}:${cwd}`}
          environmentId={environmentId}
          cwd={cwd}
          projectName={projectName}
          layoutMode={layoutMode}
          activeRelativePath={activeRelativePath}
          onOpenFile={(relativePath) => onOpenFile(relativePath)}
          onCreateFile={createFile}
          onCreateDirectory={createFolder}
          onDeleteEntry={permanentlyDeleteEntry}
          visible={view === "explorer"}
        />
      </div>
    </div>
  );
}

export default memo(WorkspaceExplorerSidebar);
