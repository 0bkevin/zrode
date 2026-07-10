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
      ) : (
        <>
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
            onShowSearch={showSearch}
          />
        </>
      )}
    </div>
  );
}

export default memo(WorkspaceExplorerSidebar);
