import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDown, ChevronRight, X, XCircle } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import {
  selectOrderedFileSurfaces,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";

type FileSurface = Extract<RightPanelSurface, { kind: "file" }>;

interface WorkspaceOpenEditorsProps {
  threadRef: ScopedThreadRef;
  pendingSurfaceIds: ReadonlySet<string>;
  onCloseFile: (surface: FileSurface) => void;
  onCloseAllFiles: () => void;
}

export interface OpenEditorListItem {
  readonly id: string;
  readonly relativePath: string;
}

interface OpenEditorsSectionProps<TFile extends OpenEditorListItem> {
  readonly files: readonly TFile[];
  readonly activeFileId: string | null;
  readonly pendingFileIds: ReadonlySet<string>;
  readonly onActivateFile: (file: TFile) => void;
  readonly onCloseFile: (file: TFile) => void;
  readonly onCloseAllFiles: () => void;
}

export function OpenEditorsSection<TFile extends OpenEditorListItem>({
  files,
  activeFileId,
  pendingFileIds,
  onActivateFile,
  onCloseFile,
  onCloseAllFiles,
}: OpenEditorsSectionProps<TFile>) {
  const { resolvedTheme } = useTheme();
  const [expanded, setExpanded] = useState(true);

  return (
    <section className="shrink-0" aria-label="Open editors">
      <div className="group flex h-8 items-center border-b border-border/60 px-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-foreground hover:bg-accent/50"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="truncate">Open Editors</span>
          <span className="font-normal text-muted-foreground">{files.length}</span>
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label="Close all editors"
          title="Close All Editors"
          disabled={files.length === 0}
          onClick={onCloseAllFiles}
        >
          <XCircle className="size-3.5" />
        </button>
      </div>
      {expanded ? (
        <div className="max-h-48 overflow-y-auto border-b border-border/60 py-0.5">
          {files.length === 0 ? (
            <div className="px-5 py-2 text-[11px] text-muted-foreground">No open editors</div>
          ) : (
            files.map((file) => {
              const active = activeFileId === file.id;
              const dirty = pendingFileIds.has(file.id);
              const title = file.relativePath.slice(file.relativePath.lastIndexOf("/") + 1);
              return (
                <div
                  key={file.id}
                  className={cn(
                    "group/editor flex h-6 items-center gap-1.5 border-l-2 pl-2 pr-1 text-xs",
                    active
                      ? "border-primary bg-accent text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    title={file.relativePath}
                    onClick={() => onActivateFile(file)}
                  >
                    <PierreEntryIcon
                      pathValue={file.relativePath}
                      kind="file"
                      theme={resolvedTheme}
                      className="size-3.5 shrink-0"
                    />
                    <span className="truncate">{title}</span>
                    <span className="ml-auto truncate text-[10px] text-muted-foreground/70">
                      {file.relativePath === title
                        ? ""
                        : file.relativePath.slice(0, -(title.length + 1))}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted",
                      dirty
                        ? "opacity-100"
                        : "opacity-0 group-hover/editor:opacity-100 focus:opacity-100",
                    )}
                    aria-label={`Close ${title}`}
                    onClick={() => onCloseFile(file)}
                  >
                    {dirty ? (
                      <>
                        <span className="size-2 rounded-full bg-current group-hover/editor:hidden" />
                        <X className="hidden size-3 group-hover/editor:block" />
                      </>
                    ) : (
                      <X className="size-3" />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceOpenEditors({
  threadRef,
  pendingSurfaceIds,
  onCloseFile,
  onCloseAllFiles,
}: WorkspaceOpenEditorsProps) {
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const files = useMemo(
    () => selectOrderedFileSurfaces(panelState.surfaces),
    [panelState.surfaces],
  );

  return (
    <OpenEditorsSection
      files={files}
      activeFileId={panelState.activeSurfaceId}
      pendingFileIds={pendingSurfaceIds}
      onActivateFile={(surface) =>
        useRightPanelStore.getState().activateSurface(threadRef, surface.id)
      }
      onCloseFile={onCloseFile}
      onCloseAllFiles={onCloseAllFiles}
    />
  );
}

export default memo(WorkspaceOpenEditors);
