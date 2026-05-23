import { type EnvironmentId, type ProjectDirEntry } from "@zrode/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  PanelRightCloseIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";

interface FileNavigatorPanelProps {
  environmentId: EnvironmentId;
  workspaceRoot: string;
  workspaceName: string | undefined;
  onOpenFile: (relativePath: string) => void;
  onClose: () => void;
}

interface DirectoryState {
  readonly entries: readonly ProjectDirEntry[];
  readonly loading: boolean;
  readonly error: string | null;
}

interface TreeRow {
  readonly entry: ProjectDirEntry;
  readonly depth: number;
}

const ROOT_PATH = "";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDescendantPath(pathValue: string, ancestorPath: string): boolean {
  return pathValue.startsWith(`${ancestorPath}/`);
}

export const FileNavigatorPanel = memo(function FileNavigatorPanel({
  environmentId,
  workspaceRoot,
  workspaceName,
  onOpenFile,
  onClose,
}: FileNavigatorPanelProps) {
  const { resolvedTheme } = useTheme();
  const [directoryCache, setDirectoryCache] = useState<Record<string, DirectoryState>>({});
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set([ROOT_PATH]));
  const rootState = directoryCache[ROOT_PATH];

  const loadDirectory = useCallback(
    async (relativePath: string) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        setDirectoryCache((current) => ({
          ...current,
          [relativePath]: { entries: [], loading: false, error: "Environment API is unavailable." },
        }));
        return;
      }
      setDirectoryCache((current) => ({
        ...current,
        [relativePath]: {
          entries: current[relativePath]?.entries ?? [],
          loading: true,
          error: null,
        },
      }));
      try {
        const result = await api.projects.readDir({ cwd: workspaceRoot, relativePath });
        setDirectoryCache((current) => ({
          ...current,
          [relativePath]: { entries: result.entries, loading: false, error: null },
        }));
      } catch (error) {
        setDirectoryCache((current) => ({
          ...current,
          [relativePath]: {
            entries: current[relativePath]?.entries ?? [],
            loading: false,
            error: toErrorMessage(error),
          },
        }));
      }
    },
    [environmentId, workspaceRoot],
  );

  useEffect(() => {
    setDirectoryCache({});
    setExpandedDirs(new Set([ROOT_PATH]));
  }, [environmentId, workspaceRoot]);

  useEffect(() => {
    void loadDirectory(ROOT_PATH);
  }, [loadDirectory]);

  const refresh = useCallback(() => {
    for (const pathValue of expandedDirs) {
      void loadDirectory(pathValue);
    }
  }, [expandedDirs, loadDirectory]);

  const rows = useMemo(() => {
    const nextRows: TreeRow[] = [];

    function appendRows(parentPath: string, depth: number): void {
      const entries = directoryCache[parentPath]?.entries ?? [];
      for (const entry of entries) {
        nextRows.push({ entry, depth });
        if (entry.kind === "directory" && expandedDirs.has(entry.relativePath)) {
          appendRows(entry.relativePath, depth + 1);
        }
      }
    }

    appendRows(ROOT_PATH, 0);
    return nextRows;
  }, [directoryCache, expandedDirs]);

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpandedDirs((current) => {
        const next = new Set(current);
        if (next.has(relativePath)) {
          next.delete(relativePath);
          for (const pathValue of current) {
            if (isDescendantPath(pathValue, relativePath)) {
              next.delete(pathValue);
            }
          }
          return next;
        }
        next.add(relativePath);
        return next;
      });
      if (!directoryCache[relativePath]) {
        void loadDirectory(relativePath);
      }
    },
    [directoryCache, loadDirectory],
  );

  const rootLoading = rootState?.loading === true && rows.length === 0;
  const rootError = rootState?.error ?? null;

  return (
    <aside className="flex h-full min-h-0 w-[min(340px,42vw)] min-w-[240px] max-w-[380px] shrink-0 flex-col border-l border-border bg-background text-foreground">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <FolderOpenIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {workspaceName ?? "Explorer"}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh explorer"
          disabled={rootState?.loading === true}
          onClick={refresh}
        >
          <RefreshCcwIcon
            className={cn("size-3.5", rootState?.loading === true && "animate-spin")}
          />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close explorer" onClick={onClose}>
          <PanelRightCloseIcon className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {rootLoading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Spinner className="size-4" />
          </div>
        ) : rootError ? (
          <div className="px-3 py-2 text-xs text-destructive">{rootError}</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No files</div>
        ) : (
          rows.map(({ entry, depth }) => {
            const expanded = entry.kind === "directory" && expandedDirs.has(entry.relativePath);
            const directoryState = directoryCache[entry.relativePath];
            return (
              <div key={entry.relativePath}>
                <button
                  type="button"
                  className="flex h-6 w-full items-center gap-1.5 px-2 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  style={{ paddingLeft: `${8 + depth * 14}px` }}
                  onClick={() => {
                    if (entry.kind === "directory") {
                      toggleDirectory(entry.relativePath);
                      return;
                    }
                    onOpenFile(entry.relativePath);
                  }}
                >
                  {entry.kind === "directory" ? (
                    expanded ? (
                      <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}
                  <VscodeEntryIcon
                    pathValue={entry.relativePath}
                    kind={entry.kind}
                    theme={resolvedTheme}
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {directoryState?.loading ? (
                    <Spinner className="size-3 shrink-0 text-muted-foreground" />
                  ) : null}
                </button>
                {expanded && directoryState?.error ? (
                  <div
                    className="truncate px-2 py-1 text-xs text-destructive"
                    style={{ paddingLeft: `${28 + depth * 14}px` }}
                  >
                    {directoryState.error}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
});
