import {
  type EnvironmentId,
  type ProjectDirEntry,
  type ProjectEntry,
  type VcsStatusResult,
} from "@zrode/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FilePlusIcon,
  FilesIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  ListCollapseIcon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PencilIcon,
  RefreshCcwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { useTheme } from "../hooks/useTheme";
import { refreshGitStatus, useGitStatus } from "../lib/gitStatusState";
import { cn } from "../lib/utils";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

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

type FileSidebarTab = "explorer" | "search" | "source-control";

const ROOT_PATH = "";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDescendantPath(pathValue: string, ancestorPath: string): boolean {
  return pathValue.startsWith(`${ancestorPath}/`);
}

function isSelfOrDescendantPath(pathValue: string, ancestorPath: string): boolean {
  return pathValue === ancestorPath || isDescendantPath(pathValue, ancestorPath);
}

function parentPathOf(relativePath: string): string {
  const separatorIndex = relativePath.lastIndexOf("/");
  return separatorIndex === -1 ? ROOT_PATH : relativePath.slice(0, separatorIndex);
}

function joinRelativePath(parentPath: string, name: string): string {
  return parentPath.length === 0 ? name : `${parentPath}/${name}`;
}

function promptForName(message: string, initialValue = ""): string | null {
  const value = window.prompt(message, initialValue);
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && !trimmed.includes("/") ? trimmed : null;
}

function duplicateName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return `${name}-copy`;
  return `${name.slice(0, dotIndex)}-copy${name.slice(dotIndex)}`;
}

export const FileNavigatorPanel = memo(function FileNavigatorPanel({
  environmentId,
  workspaceRoot,
  workspaceName,
  onOpenFile,
  onClose,
}: FileNavigatorPanelProps) {
  const { resolvedTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<FileSidebarTab>("explorer");
  const [directoryCache, setDirectoryCache] = useState<Record<string, DirectoryState>>({});
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set([ROOT_PATH]));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const rootState = directoryCache[ROOT_PATH];
  const gitStatus = useGitStatus({ environmentId, cwd: workspaceRoot });

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
          [relativePath]: {
            entries: result.entries.toSorted((left, right) => {
              if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
              return left.name.localeCompare(right.name);
            }),
            loading: false,
            error: null,
          },
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

  const refreshDirectory = useCallback(
    (relativePath: string) => {
      void loadDirectory(relativePath);
    },
    [loadDirectory],
  );

  useEffect(() => {
    setDirectoryCache({});
    setExpandedDirs(new Set([ROOT_PATH]));
    setSelectedPath(null);
    setOperationError(null);
  }, [environmentId, workspaceRoot]);

  useEffect(() => {
    void loadDirectory(ROOT_PATH);
  }, [loadDirectory]);

  const refresh = useCallback(() => {
    for (const pathValue of expandedDirs) {
      void loadDirectory(pathValue);
    }
  }, [expandedDirs, loadDirectory]);

  const collapseAll = useCallback(() => {
    setExpandedDirs(new Set([ROOT_PATH]));
  }, []);

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

  const runPathMutation = useCallback(
    async (mutation: () => Promise<void>, parentPath: string) => {
      try {
        setOperationError(null);
        await mutation();
        setExpandedDirs((current) => new Set(current).add(parentPath));
        refreshDirectory(parentPath);
        return true;
      } catch (error) {
        setOperationError(toErrorMessage(error));
        return false;
      }
    },
    [refreshDirectory],
  );

  const createPath = useCallback(
    async (kind: "file" | "directory", parentPath: string) => {
      const name = promptForName(kind === "file" ? "New file name" : "New folder name");
      if (!name) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      const relativePath = joinRelativePath(parentPath, name);
      const created = await runPathMutation(async () => {
        if (kind === "file") {
          await api.projects.createFile({ cwd: workspaceRoot, relativePath });
        } else {
          await api.projects.createDirectory({ cwd: workspaceRoot, relativePath });
        }
      }, parentPath);
      if (!created) return;
      setSelectedPath(relativePath);
    },
    [environmentId, runPathMutation, workspaceRoot],
  );

  const renamePath = useCallback(
    async (entry: ProjectDirEntry) => {
      const name = promptForName("Rename", entry.name);
      if (!name || name === entry.name) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      const parentPath = parentPathOf(entry.relativePath);
      const newRelativePath = joinRelativePath(parentPath, name);
      const renamed = await runPathMutation(async () => {
        await api.projects.renamePath({
          cwd: workspaceRoot,
          oldRelativePath: entry.relativePath,
          newRelativePath,
        });
      }, parentPath);
      if (!renamed) return;
      setSelectedPath(newRelativePath);
    },
    [environmentId, runPathMutation, workspaceRoot],
  );

  const copyPath = useCallback(
    async (entry: ProjectDirEntry) => {
      const parentPath = parentPathOf(entry.relativePath);
      const name = promptForName("Duplicate as", duplicateName(entry.name));
      if (!name) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      const destinationRelativePath = joinRelativePath(parentPath, name);
      const copied = await runPathMutation(async () => {
        await api.projects.copyPath({
          cwd: workspaceRoot,
          sourceRelativePath: entry.relativePath,
          destinationRelativePath,
        });
      }, parentPath);
      if (!copied) return;
      setSelectedPath(destinationRelativePath);
    },
    [environmentId, runPathMutation, workspaceRoot],
  );

  const deletePath = useCallback(
    async (entry: ProjectDirEntry) => {
      const confirmed = window.confirm(`Delete ${entry.relativePath}?`);
      if (!confirmed) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      const parentPath = parentPathOf(entry.relativePath);
      const deleted = await runPathMutation(async () => {
        await api.projects.deletePath({
          cwd: workspaceRoot,
          relativePath: entry.relativePath,
          recursive: entry.kind === "directory",
        });
      }, parentPath);
      if (!deleted) return;
      if (entry.kind === "directory") {
        setExpandedDirs((current) => {
          const next = new Set(current);
          for (const pathValue of current) {
            if (isSelfOrDescendantPath(pathValue, entry.relativePath)) {
              next.delete(pathValue);
            }
          }
          return next;
        });
        setDirectoryCache((current) => {
          const next = { ...current };
          for (const pathValue of Object.keys(next)) {
            if (isSelfOrDescendantPath(pathValue, entry.relativePath)) {
              delete next[pathValue];
            }
          }
          return next;
        });
      }
      setSelectedPath((current) =>
        current && isSelfOrDescendantPath(current, entry.relativePath) ? null : current,
      );
    },
    [environmentId, runPathMutation, workspaceRoot],
  );

  const copyRelativePath = useCallback((pathValue: string) => {
    void navigator.clipboard?.writeText(pathValue);
  }, []);

  const rootLoading = rootState?.loading === true && rows.length === 0;
  const rootError = rootState?.error ?? null;
  const canCollapseAll = expandedDirs.size > 1;

  return (
    <aside className="flex h-full min-h-0 w-[min(380px,44vw)] min-w-[260px] max-w-[460px] shrink-0 border-l border-border bg-background text-foreground">
      <ActivityBar activeTab={activeTab} onChange={setActiveTab} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <PanelTitle activeTab={activeTab} workspaceName={workspaceName} />
          {activeTab === "explorer" ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Collapse all folders"
                      disabled={!canCollapseAll}
                      onClick={collapseAll}
                    >
                      <ListCollapseIcon className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">Collapse all</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
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
                  }
                />
                <TooltipPopup side="bottom">Refresh explorer</TooltipPopup>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button size="icon-xs" variant="ghost" aria-label="More explorer actions">
                      <MoreHorizontalIcon className="size-3.5" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem onClick={() => void createPath("file", ROOT_PATH)}>
                    <FilePlusIcon />
                    New File
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void createPath("directory", ROOT_PATH)}>
                    <FolderPlusIcon />
                    New Folder
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
          {activeTab === "source-control" ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh source control"
              onClick={() => void refreshGitStatus({ environmentId, cwd: workspaceRoot })}
            >
              <RefreshCcwIcon className={cn("size-3.5", gitStatus.isPending && "animate-spin")} />
            </Button>
          ) : null}
          <Button size="icon-xs" variant="ghost" aria-label="Close sidebar" onClick={onClose}>
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </header>

        {activeTab === "explorer" ? (
          <ExplorerRows
            rootLoading={rootLoading}
            rootError={rootError}
            rows={rows}
            directoryCache={directoryCache}
            expandedDirs={expandedDirs}
            operationError={operationError}
            selectedPath={selectedPath}
            resolvedTheme={resolvedTheme}
            onToggleDirectory={toggleDirectory}
            onOpenFile={(relativePath) => {
              setSelectedPath(relativePath);
              onOpenFile(relativePath);
            }}
            onCreatePath={createPath}
            onRenamePath={renamePath}
            onCopyPath={copyPath}
            onDeletePath={deletePath}
            onCopyRelativePath={copyRelativePath}
          />
        ) : null}
        {activeTab === "search" ? (
          <SearchPanel
            environmentId={environmentId}
            workspaceRoot={workspaceRoot}
            resolvedTheme={resolvedTheme}
            onOpenFile={(relativePath) => {
              setSelectedPath(relativePath);
              onOpenFile(relativePath);
            }}
          />
        ) : null}
        {activeTab === "source-control" ? (
          <SourceControlPanel
            isPending={gitStatus.isPending}
            error={gitStatus.error?.message ?? null}
            status={gitStatus.data}
            resolvedTheme={resolvedTheme}
            onOpenFile={(relativePath) => {
              setSelectedPath(relativePath);
              onOpenFile(relativePath);
            }}
          />
        ) : null}
      </div>
    </aside>
  );
});

function ActivityBar(props: {
  activeTab: FileSidebarTab;
  onChange: (tab: FileSidebarTab) => void;
}) {
  const items: ReadonlyArray<{
    id: FileSidebarTab;
    icon: typeof FilesIcon;
    label: string;
  }> = [
    { id: "explorer", icon: FilesIcon, label: "Explorer" },
    { id: "search", icon: SearchIcon, label: "Search" },
    { id: "source-control", icon: GitBranchIcon, label: "Source Control" },
  ];

  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/30 py-1.5">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={item.label}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    props.activeTab === item.id && "bg-accent text-foreground",
                  )}
                  onClick={() => props.onChange(item.id)}
                >
                  <Icon className="size-4" />
                </button>
              }
            />
            <TooltipPopup side="left">{item.label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

function PanelTitle(props: { activeTab: FileSidebarTab; workspaceName: string | undefined }) {
  const title =
    props.activeTab === "explorer"
      ? (props.workspaceName ?? "Explorer")
      : props.activeTab === "search"
        ? "Search"
        : "Source Control";
  const Icon =
    props.activeTab === "explorer"
      ? FolderOpenIcon
      : props.activeTab === "search"
        ? SearchIcon
        : GitBranchIcon;

  return (
    <>
      <Icon className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
    </>
  );
}

function ExplorerRows(props: {
  rootLoading: boolean;
  rootError: string | null;
  rows: TreeRow[];
  directoryCache: Record<string, DirectoryState>;
  expandedDirs: ReadonlySet<string>;
  operationError: string | null;
  selectedPath: string | null;
  resolvedTheme: "light" | "dark";
  onToggleDirectory: (relativePath: string) => void;
  onOpenFile: (relativePath: string) => void;
  onCreatePath: (kind: "file" | "directory", parentPath: string) => Promise<void>;
  onRenamePath: (entry: ProjectDirEntry) => Promise<void>;
  onCopyPath: (entry: ProjectDirEntry) => Promise<void>;
  onDeletePath: (entry: ProjectDirEntry) => Promise<void>;
  onCopyRelativePath: (relativePath: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {props.operationError ? (
        <div className="mx-2 mb-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {props.operationError}
        </div>
      ) : null}
      {props.rootLoading ? (
        <div className="flex h-24 items-center justify-center text-muted-foreground">
          <Spinner className="size-4" />
        </div>
      ) : props.rootError ? (
        <div className="px-3 py-2 text-xs text-destructive">{props.rootError}</div>
      ) : props.rows.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">No files</div>
      ) : (
        props.rows.map(({ entry, depth }) => {
          const expanded = entry.kind === "directory" && props.expandedDirs.has(entry.relativePath);
          const directoryState = props.directoryCache[entry.relativePath];
          const parentPath =
            entry.kind === "directory" ? entry.relativePath : parentPathOf(entry.relativePath);
          return (
            <div key={entry.relativePath}>
              <div
                className={cn(
                  "group flex h-6 items-center hover:bg-accent focus-within:bg-accent",
                  props.selectedPath === entry.relativePath && "bg-accent text-accent-foreground",
                )}
              >
                <button
                  type="button"
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-xs focus-visible:outline-none"
                  style={{ paddingLeft: `${8 + depth * 14}px` }}
                  onClick={() => {
                    if (entry.kind === "directory") {
                      props.onToggleDirectory(entry.relativePath);
                      return;
                    }
                    props.onOpenFile(entry.relativePath);
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
                    theme={props.resolvedTheme}
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {directoryState?.loading ? (
                    <Spinner className="size-3 shrink-0 text-muted-foreground" />
                  ) : null}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`More actions for ${entry.name}`}
                        className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-background/70 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100 data-[popup-open]:opacity-100"
                      >
                        <MoreHorizontalIcon className="size-3.5" />
                      </button>
                    }
                  />
                  <DropdownMenuContent align="end" className="min-w-40">
                    <DropdownMenuItem onClick={() => void props.onCreatePath("file", parentPath)}>
                      <FilePlusIcon />
                      New File
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void props.onCreatePath("directory", parentPath)}
                    >
                      <FolderPlusIcon />
                      New Folder
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void props.onRenamePath(entry)}>
                      <PencilIcon />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void props.onCopyPath(entry)}>
                      <CopyIcon />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => props.onCopyRelativePath(entry.relativePath)}>
                      <CopyIcon />
                      Copy Relative Path
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => void props.onDeletePath(entry)}
                    >
                      <Trash2Icon />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
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
  );
}

function SearchPanel(props: {
  environmentId: EnvironmentId;
  workspaceRoot: string;
  resolvedTheme: "light" | "dark";
  onOpenFile: (relativePath: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    entries: readonly ProjectEntry[];
    truncated: boolean;
    loading: boolean;
    error: string | null;
  }>({ entries: [], truncated: false, loading: false, error: null });

  useEffect(() => {
    const api = readEnvironmentApi(props.environmentId);
    if (!api || query.trim().length === 0) {
      setResult({ entries: [], truncated: false, loading: false, error: null });
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setResult((current) => ({ ...current, loading: true, error: null }));
      void api.projects
        .searchEntries({ cwd: props.workspaceRoot, query: query.trim(), limit: 80 })
        .then((nextResult) => {
          if (!cancelled) {
            setResult({
              ...nextResult,
              entries: nextResult.entries.filter((entry) => entry.kind === "file"),
              loading: false,
              error: null,
            });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setResult({
              entries: [],
              truncated: false,
              loading: false,
              error: toErrorMessage(error),
            });
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [props.environmentId, props.workspaceRoot, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-2">
        <input
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Search files"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {result.loading ? (
          <div className="flex h-20 items-center justify-center text-muted-foreground">
            <Spinner className="size-4" />
          </div>
        ) : result.error ? (
          <div className="px-3 py-2 text-xs text-destructive">{result.error}</div>
        ) : query.trim().length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Type to search workspace files
          </div>
        ) : result.entries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No results</div>
        ) : (
          <>
            {result.entries.map((entry) => (
              <button
                key={`${entry.kind}:${entry.path}`}
                type="button"
                className="flex h-7 w-full items-center gap-1.5 px-2 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => {
                  if (entry.kind === "file") {
                    props.onOpenFile(entry.path);
                  }
                }}
              >
                <span className="size-3.5 shrink-0" />
                <VscodeEntryIcon
                  pathValue={entry.path}
                  kind={entry.kind}
                  theme={props.resolvedTheme}
                  className="size-4 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate font-mono">{entry.path}</span>
              </button>
            ))}
            {result.truncated ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">Results truncated</div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SourceControlPanel(props: {
  isPending: boolean;
  error: string | null;
  status: VcsStatusResult | null;
  resolvedTheme: "light" | "dark";
  onOpenFile: (relativePath: string) => void;
}) {
  const status = props.status;
  if (props.isPending && !status) {
    return (
      <div className="flex h-24 items-center justify-center text-muted-foreground">
        <Spinner className="size-4" />
      </div>
    );
  }
  if (props.error) {
    return <div className="px-3 py-2 text-xs text-destructive">{props.error}</div>;
  }
  if (!status?.isRepo) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">No source control repository</div>
    );
  }

  const files = status.workingTree.files;
  return (
    <div className="min-h-0 flex-1 overflow-auto py-2">
      <div className="space-y-1 border-b border-border px-3 pb-2 text-xs text-muted-foreground">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate">Branch</span>
          <span className="min-w-0 truncate font-medium text-foreground">
            {status.refName ?? "Detached"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>Sync</span>
          <span className="font-mono text-[11px]">
            {status.aheadCount} ahead / {status.behindCount} behind
          </span>
        </div>
      </div>
      {files.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">No working tree changes</div>
      ) : (
        <div className="py-1">
          <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Changes
          </div>
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="flex h-7 w-full items-center gap-1.5 px-2 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => props.onOpenFile(file.path)}
            >
              <span className="size-3.5 shrink-0" />
              <VscodeEntryIcon
                pathValue={file.path}
                kind="file"
                theme={props.resolvedTheme}
                className="size-4 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums">
                <DiffStatLabel additions={file.insertions} deletions={file.deletions} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
