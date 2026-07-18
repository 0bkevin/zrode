import type { FileTreeDirectoryHandle, FileTreeItemHandle } from "@pierre/trees";
import type { EnvironmentId, ProjectEntry, ProjectListDirectoryResult } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  ChevronsDownUp,
  Eye,
  FilePlus2,
  FolderPlus,
  ListFilter,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { ZRODE_PIERRE_ICONS, ZRODE_PIERRE_ICON_TREE_CSS } from "~/pierre-icons";

import {
  resetFileTreePathsPreservingExpansion,
  revealActiveFile,
  shouldRevealActiveFile,
} from "./fileBrowserTreeState";
import {
  clearFailedPierreCreation,
  type OptimisticWorkspaceEntry,
  queueUnchangedPierreCreationCommit,
  reconcileOptimisticWorkspaceEntries,
  type WorkspaceCreationKind,
  type WorkspaceCreationSession,
} from "./fileBrowserCreation";
import { directoriesNeedingLazyLoad, mergeWorkspaceEntries } from "./fileBrowserLazyEntries";
import { useProjectDirectoryQuery, useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  activeRelativePath: string | null;
  onOpenFile: (relativePath: string) => void;
  onCreateFile: (relativePath: string) => Promise<void>;
  onCreateDirectory: (relativePath: string) => Promise<void>;
  onDeleteEntry: (
    relativePath: string,
    kind: ProjectEntry["kind"],
  ) => Promise<{ readonly status: "deleted" | "canceled" }>;
  onShowSearch: () => void;
  visible: boolean;
}

const OPTIMISTIC_ENTRY_TTL_MS = 10_000;
const LAZY_DIRECTORY_QUERY_CONCURRENCY = 8;

interface ProjectDirectoryLoaderProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly refreshVersion: number;
  readonly onData: (relativePath: string, result: ProjectListDirectoryResult) => void;
  readonly onError: (relativePath: string, error: string | null) => void;
}

function ProjectDirectoryLoader(props: ProjectDirectoryLoaderProps) {
  const query = useProjectDirectoryQuery(props.environmentId, props.cwd, props.relativePath);
  const previousRefreshVersionRef = useRef(props.refreshVersion);

  useEffect(() => {
    if (previousRefreshVersionRef.current === props.refreshVersion) return;
    previousRefreshVersionRef.current = props.refreshVersion;
    query.refresh();
  }, [props.refreshVersion, query.refresh]);

  useEffect(() => {
    if (query.data !== null) props.onData(props.relativePath, query.data);
  }, [props.onData, props.relativePath, query.data]);

  useEffect(() => {
    props.onError(props.relativePath, query.error);
  }, [props.onError, props.relativePath, query.error]);

  return null;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --trees-font-size-override: 12px;
    ${ZRODE_PIERRE_ICON_TREE_CSS}
    --zrode-folder-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    --zrode-folder-open-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  }
  button[data-type='item'] { border-radius: 0; }
  [data-item-section='icon'] {
    width: calc(var(--trees-icon-width) * 2);
    justify-content: flex-start;
  }
  [data-item-type='file'] > [data-item-section='icon'] > svg {
    width: 12px;
    height: 12px;
    flex: 0 0 12px;
    margin-inline: calc(var(--trees-icon-width) + 2px) 2px;
  }
  [data-icon-name='file-tree-icon-file'] { color: var(--trees-fg-muted); }
  [data-item-type='folder'] > [data-item-section='icon'] > svg {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    margin-inline: 1px;
    opacity: 0.7;
  }
  [data-item-type='folder'] > [data-item-section='icon']::after {
    content: '';
    width: 12px;
    height: 12px;
    flex: 0 0 12px;
    margin-inline: 2px;
    background: currentColor;
    opacity: 0.5;
    -webkit-mask: var(--zrode-folder-mask) center / contain no-repeat;
    mask: var(--zrode-folder-mask) center / contain no-repeat;
  }
  [data-item-type='folder'][aria-expanded='true'] > [data-item-section='icon']::after {
    -webkit-mask-image: var(--zrode-folder-open-mask);
    mask-image: var(--zrode-folder-open-mask);
  }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function directoryPathsForEntries(entries: ReadonlyArray<ProjectEntry>): string[] {
  const directoryPaths = new Set<string>();

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    const directoryDepth = entry.kind === "directory" ? segments.length : segments.length - 1;

    for (let index = 1; index <= directoryDepth; index += 1) {
      directoryPaths.add(segments.slice(0, index).join("/"));
    }
  }

  return [...directoryPaths];
}

function isFileTreeDirectoryHandle(
  item: FileTreeItemHandle | null,
): item is FileTreeDirectoryHandle {
  return item?.isDirectory() === true;
}

function withoutTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function parentDirectory(path: string): string {
  const normalized = withoutTrailingSlash(path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

function joinWorkspacePath(parent: string, basename: string): string {
  return parent.length === 0 ? basename : `${parent}/${basename}`;
}

function creationParent(model: ReturnType<typeof useFileTree>["model"]): string {
  const focused = model.getFocusedItem();
  if (!focused) return "";
  return focused.isDirectory()
    ? withoutTrailingSlash(focused.getPath())
    : parentDirectory(focused.getPath());
}

function nextPlaceholderPath(
  model: ReturnType<typeof useFileTree>["model"],
  kind: WorkspaceCreationKind,
): string {
  const parent = creationParent(model);
  const label = kind === "file" ? "New File" : "New Folder";
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const basename = suffix === 0 ? label : `${label} ${suffix + 1}`;
    const barePath = joinWorkspacePath(parent, basename);
    const path = kind === "directory" ? `${barePath}/` : barePath;
    if (model.getItem(path) === null) return path;
  }
  return joinWorkspacePath(parent, `${label} ${Date.now()}`) + (kind === "directory" ? "/" : "");
}

function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  activeRelativePath,
  onOpenFile,
  onCreateFile,
  onCreateDirectory,
  onDeleteEntry,
  onShowSearch,
  visible,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const refreshEntries = entriesQuery.refresh;
  const indexedEntries = entriesQuery.data?.entries ?? [];
  const [showIgnoredFiles, setShowIgnoredFiles] = useState(false);
  const [requestedDirectories, setRequestedDirectories] = useState<ReadonlySet<string>>(new Set());
  const [lazyDirectoryResults, setLazyDirectoryResults] = useState<
    ReadonlyMap<string, ProjectListDirectoryResult>
  >(new Map());
  const [lazyDirectoryErrors, setLazyDirectoryErrors] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [lazyRefreshVersion, setLazyRefreshVersion] = useState(0);
  const [filterVisible, setFilterVisible] = useState(false);
  const [filterValue, setFilterValue] = useState("");
  const [creationSession, setCreationSession] = useState<WorkspaceCreationSession | null>(null);
  const [optimisticEntries, setOptimisticEntries] = useState<readonly OptimisticWorkspaceEntry[]>(
    [],
  );
  const [creationError, setCreationError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<ProjectEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const creationSessionRef = useRef<WorkspaceCreationSession | null>(creationSession);
  const modelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const commitCreationRef = useRef<(session: WorkspaceCreationSession) => void>(() => undefined);
  const nextOptimisticEntryIdRef = useRef(0);
  const createFileRef = useRef(onCreateFile);
  const createDirectoryRef = useRef(onCreateDirectory);
  createFileRef.current = onCreateFile;
  createDirectoryRef.current = onCreateDirectory;

  const entries = useMemo(
    () =>
      showIgnoredFiles
        ? mergeWorkspaceEntries(
            indexedEntries,
            [...lazyDirectoryResults.values()].map((result) => result.entries),
          )
        : indexedEntries,
    [indexedEntries, lazyDirectoryResults, showIgnoredFiles],
  );
  const loadedDirectories = useMemo(
    () => new Set(lazyDirectoryResults.keys()),
    [lazyDirectoryResults],
  );
  const lazyLoading = useMemo(
    () =>
      showIgnoredFiles &&
      [...requestedDirectories].some(
        (path) => !loadedDirectories.has(path) && !lazyDirectoryErrors.has(path),
      ),
    [lazyDirectoryErrors, loadedDirectories, requestedDirectories, showIgnoredFiles],
  );
  const lazyListingTruncated = useMemo(
    () => [...lazyDirectoryResults.values()].some((result) => result.truncated),
    [lazyDirectoryResults],
  );
  const lazyListingError = lazyDirectoryErrors.values().next().value ?? null;
  const mountedDirectoryLoaders = useMemo(() => {
    let pendingCount = 0;
    return [...requestedDirectories].filter((path) => {
      if (loadedDirectories.has(path) || lazyDirectoryErrors.has(path)) return true;
      pendingCount += 1;
      return pendingCount <= LAZY_DIRECTORY_QUERY_CONCURRENCY;
    });
  }, [lazyDirectoryErrors, loadedDirectories, requestedDirectories]);

  const handleLazyDirectoryData = useCallback(
    (relativePath: string, result: ProjectListDirectoryResult) => {
      setLazyDirectoryResults((current) => {
        if (current.get(relativePath) === result) return current;
        const next = new Map(current);
        next.set(relativePath, result);
        return next;
      });
      setLazyDirectoryErrors((current) => {
        if (!current.has(relativePath)) return current;
        const next = new Map(current);
        next.delete(relativePath);
        return next;
      });
    },
    [],
  );

  const handleLazyDirectoryError = useCallback((relativePath: string, error: string | null) => {
    setLazyDirectoryErrors((current) => {
      if (error === null && !current.has(relativePath)) return current;
      if (error !== null && current.get(relativePath) === error) return current;
      const next = new Map(current);
      if (error === null) next.delete(relativePath);
      else next.set(relativePath, error);
      return next;
    });
  }, []);

  const refreshAllEntries = useCallback(() => {
    refreshEntries();
    if (!showIgnoredFiles) return;
    setLazyDirectoryErrors(new Map());
    setLazyRefreshVersion((version) => version + 1);
  }, [refreshEntries, showIgnoredFiles]);

  useEffect(() => {
    setShowIgnoredFiles(false);
    setRequestedDirectories(new Set());
    setLazyDirectoryResults(new Map());
    setLazyDirectoryErrors(new Map());
  }, [cwd, environmentId]);

  const entryKinds = useMemo(
    () =>
      new Map([
        ...entries.map((entry) => [entry.path, entry.kind] as const),
        ...optimisticEntries.map((entry) => [entry.path, entry.kind] as const),
      ]),
    [entries, optimisticEntries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const activeRelativePathRef = useRef(activeRelativePath);
  const onOpenFileRef = useRef(onOpenFile);
  const suppressSelectionChangeRef = useRef(false);
  entryKindsRef.current = entryKinds;
  activeRelativePathRef.current = activeRelativePath;
  onOpenFileRef.current = onOpenFile;

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: ZRODE_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      if (suppressSelectionChangeRef.current) return;
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      setSelectedEntry(
        selectedPath && entryKindsRef.current.has(selectedPath)
          ? { path: selectedPath, kind: entryKindsRef.current.get(selectedPath)! }
          : null,
      );
      if (
        selectedPath &&
        selectedPath !== activeRelativePathRef.current &&
        entryKindsRef.current.get(selectedPath) === "file"
      ) {
        onOpenFileRef.current(selectedPath);
      }
    },
    paths: [],
    renaming: {
      canRename: (item) => creationSessionRef.current?.path.replace(/\/$/, "") === item.path,
      onError: (message) => {
        clearFailedPierreCreation({
          session: creationSessionRef.current,
          remove: (path, recursive) =>
            modelRef.current?.remove(path, recursive ? { recursive: true } : undefined),
          clearSession: () => {
            creationSessionRef.current = null;
            setCreationSession(null);
          },
          reportError: setCreationError,
          message,
        });
      },
      onRename: ({ sourcePath, destinationPath, isFolder }) => {
        const current = creationSessionRef.current;
        if (!current || withoutTrailingSlash(current.path) !== sourcePath) return;
        const path = isFolder ? `${withoutTrailingSlash(destinationPath)}/` : destinationPath;
        commitCreationRef.current({ ...current, path, status: "editing" });
      },
    },
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  modelRef.current = model;

  useEffect(() => {
    if (!showIgnoredFiles) return;

    const requestFocusedDirectory = () => {
      const focused = model.getFocusedItem();
      if (!isFileTreeDirectoryHandle(focused) || !focused.isExpanded()) return;
      const needed = directoriesNeedingLazyLoad({
        expandedDirectories: [withoutTrailingSlash(focused.getPath())],
        loadedDirectories,
        requestedDirectories,
      });
      if (needed.length === 0) return;
      setRequestedDirectories((current) => new Set([...current, ...needed]));
    };

    requestFocusedDirectory();
    return model.subscribe(requestFocusedDirectory);
  }, [loadedDirectories, model, requestedDirectories, showIgnoredFiles]);

  const commitCreation = useCallback(
    (session: WorkspaceCreationSession) => {
      if (creationSessionRef.current?.status !== "editing") return;
      const committing = { ...session, status: "committing" as const };
      creationSessionRef.current = committing;
      setCreationSession(committing);
      setCreationError(null);
      const persist = session.kind === "file" ? createFileRef.current : createDirectoryRef.current;
      void persist(withoutTrailingSlash(session.path)).then(
        () => {
          nextOptimisticEntryIdRef.current += 1;
          const optimistic: OptimisticWorkspaceEntry = {
            id: nextOptimisticEntryIdRef.current,
            kind: session.kind,
            path: withoutTrailingSlash(session.path),
            expiresAt: Date.now() + OPTIMISTIC_ENTRY_TTL_MS,
          };
          creationSessionRef.current = null;
          setCreationSession(null);
          setOptimisticEntries((current) => [...current, optimistic]);
          refreshAllEntries();
          if (session.kind === "file") onOpenFileRef.current(optimistic.path);
        },
        (error: unknown) => {
          creationSessionRef.current = null;
          setCreationSession(null);
          setCreationError(error instanceof Error ? error.message : "Could not create the item.");
          refreshAllEntries();
        },
      );
    },
    [refreshAllEntries],
  );
  commitCreationRef.current = commitCreation;

  const authoritativeTreePaths = useMemo(() => entries.map(treePath), [entries]);
  const treePaths = useMemo(() => {
    const paths = new Set(authoritativeTreePaths);
    for (const optimistic of optimisticEntries) {
      paths.add(optimistic.kind === "directory" ? `${optimistic.path}/` : optimistic.path);
    }
    if (creationSession) paths.add(creationSession.path);
    return [...paths];
  }, [authoritativeTreePaths, creationSession, optimisticEntries]);
  const directoryPaths = useMemo(() => {
    const directories = directoryPathsForEntries(entries);
    for (const optimistic of optimisticEntries) {
      if (optimistic.kind === "directory") directories.push(optimistic.path);
    }
    if (creationSession?.kind === "directory") {
      directories.push(withoutTrailingSlash(creationSession.path));
    }
    return [...new Set(directories)];
  }, [creationSession, entries, optimisticEntries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);
  const previousDirectoryPathsRef = useRef<readonly string[]>([]);
  const previousActivePathRef = useRef<string | null>(null);
  const previousVisibleRef = useRef(visible);

  useEffect(() => {
    suppressSelectionChangeRef.current = true;
    try {
      const pathsChanged = resetFileTreePathsPreservingExpansion({
        model,
        previousDirectoryPaths: previousDirectoryPathsRef.current,
        previousTreePaths: previousTreePathsRef.current,
        treePaths,
      });
      const activePathChanged = previousActivePathRef.current !== activeRelativePath;

      previousTreePathsRef.current = treePaths;
      previousDirectoryPathsRef.current = directoryPaths;
      previousActivePathRef.current = activeRelativePath;
      const previouslyVisible = previousVisibleRef.current;
      previousVisibleRef.current = visible;

      if (
        shouldRevealActiveFile({
          activePathChanged,
          pathsChanged,
          previouslyVisible,
          visible,
        })
      ) {
        revealActiveFile({ activeRelativePath, entryKinds, model });
      }
    } finally {
      suppressSelectionChangeRef.current = false;
    }
  }, [activeRelativePath, directoryPaths, entryKinds, model, treePaths, visible]);

  useEffect(() => {
    if (optimisticEntries.length === 0) return;
    const authoritativePaths = new Set(entries.map((entry) => entry.path));
    const now = Date.now();
    const reconciled = reconcileOptimisticWorkspaceEntries(
      optimisticEntries,
      authoritativePaths,
      now,
    );
    if (reconciled.length !== optimisticEntries.length) {
      setOptimisticEntries(reconciled);
      return;
    }
    const nextExpiry = Math.min(...optimisticEntries.map((entry) => entry.expiresAt));
    const timeout = window.setTimeout(
      () =>
        setOptimisticEntries((current) =>
          reconcileOptimisticWorkspaceEntries(current, authoritativePaths, Date.now()),
        ),
      Math.max(0, nextExpiry - now),
    );
    return () => window.clearTimeout(timeout);
  }, [entries, optimisticEntries]);

  useEffect(
    () =>
      model.onMutation("remove", (event) => {
        const current = creationSessionRef.current;
        if (!current || current.status !== "editing") return;
        if (withoutTrailingSlash(event.path) !== withoutTrailingSlash(current.path)) return;
        creationSessionRef.current = null;
        setCreationSession(null);
      }),
    [model],
  );

  useEffect(() => {
    model.setSearch(filterValue.trim().length > 0 ? filterValue : null);
  }, [filterValue, model]);

  useEffect(() => {
    if (filterVisible) filterInputRef.current?.focus();
  }, [filterVisible]);

  const startCreate = useCallback(
    (kind: WorkspaceCreationKind) => {
      if (creationSessionRef.current !== null) return;
      setFilterValue("");
      model.setSearch(null);
      const path = nextPlaceholderPath(model, kind);
      const parent = parentDirectory(path);
      if (parent) {
        const parentItem = model.getItem(parent);
        if (isFileTreeDirectoryHandle(parentItem)) parentItem.expand();
      }
      const session = { kind, path, status: "editing" as const };
      creationSessionRef.current = session;
      setCreationSession(session);
      setCreationError(null);
      model.add(path);
      if (!model.startRenaming(path, { removeIfCanceled: true })) {
        model.remove(path, kind === "directory" ? { recursive: true } : undefined);
        creationSessionRef.current = null;
        setCreationSession(null);
        setCreationError("Could not start inline creation.");
      }
    },
    [model],
  );

  const queueUnchangedCreationCommit = useCallback(() => {
    queueUnchangedPierreCreationCommit(() => creationSessionRef.current, commitCreation);
  }, [commitCreation]);

  const collapseAllFiles = useCallback(() => {
    for (const directoryPath of directoryPaths) {
      const item = model.getItem(directoryPath);
      if (isFileTreeDirectoryHandle(item)) item.collapse();
    }
  }, [directoryPaths, model]);

  const toggleIgnoredFiles = useCallback(() => {
    const next = !showIgnoredFiles;
    setShowIgnoredFiles(next);
    setRequestedDirectories(() => {
      if (!next) return new Set();
      const expandedDirectories = directoryPaths.filter((path) => {
        const item = model.getItem(path);
        return isFileTreeDirectoryHandle(item) && item.isExpanded();
      });
      return new Set([".", ...expandedDirectories]);
    });
    setLazyDirectoryResults(new Map());
    setLazyDirectoryErrors(new Map());
    setSelectedEntry(null);
  }, [directoryPaths, model, showIgnoredFiles]);

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );
  const creationBusy = creationSession?.status === "committing";

  const deleteSelectedEntry = useCallback(() => {
    if (!selectedEntry || deleting || creationSession !== null) return;
    setDeleting(true);
    setCreationError(null);
    void onDeleteEntry(selectedEntry.path, selectedEntry.kind).then(
      (outcome) => {
        if (outcome.status === "canceled") {
          setDeleting(false);
          return;
        }
        setSelectedEntry(null);
        refreshAllEntries();
        setDeleting(false);
      },
      (error: unknown) => {
        setCreationError(error instanceof Error ? error.message : "Could not delete the item.");
        setDeleting(false);
      },
    );
  }, [creationSession, deleting, onDeleteEntry, refreshAllEntries, selectedEntry]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      {showIgnoredFiles
        ? mountedDirectoryLoaders.map((relativePath) => (
            <ProjectDirectoryLoader
              key={relativePath}
              environmentId={environmentId}
              cwd={cwd}
              relativePath={relativePath}
              refreshVersion={lazyRefreshVersion}
              onData={handleLazyDirectoryData}
              onError={handleLazyDirectoryError}
            />
          ))
        : null}
      <div className="flex h-9 shrink-0 items-center gap-1 border-y border-border/60 px-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-foreground">
            {projectName}
          </div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {entriesQuery.isPending && entriesQuery.data === null
              ? "Indexing…"
              : `${fileCount.toLocaleString()} files`}
            {showIgnoredFiles ? " · ignored shown" : ""}
            {entriesQuery.data?.truncated || lazyListingTruncated ? " · partial" : ""}
          </div>
        </div>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
          aria-label="Permanently delete selected item"
          title="Delete Permanently"
          disabled={selectedEntry === null || creationSession !== null || deleting}
          onClick={deleteSelectedEntry}
        >
          <Trash2 className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          aria-label="New file"
          title="New File"
          disabled={creationSession !== null}
          onClick={() => startCreate("file")}
        >
          <FilePlus2 className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          aria-label="New folder"
          title="New Folder"
          disabled={creationSession !== null}
          onClick={() => startCreate("directory")}
        >
          <FolderPlus className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
            filterVisible && "bg-accent text-foreground",
          )}
          aria-label="Filter files"
          title="Filter Files"
          onClick={() => {
            if (filterVisible) setFilterValue("");
            setFilterVisible((visible) => !visible);
          }}
        >
          <ListFilter className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
            showIgnoredFiles && "bg-accent text-foreground",
          )}
          aria-label={
            showIgnoredFiles
              ? "Hide ignored and generated files"
              : "Show ignored and generated files"
          }
          aria-pressed={showIgnoredFiles}
          title={showIgnoredFiles ? "Hide Ignored Files" : "Show Ignored Files"}
          onClick={toggleIgnoredFiles}
        >
          <Eye className={cn("size-3.5", lazyLoading && "animate-pulse")} />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Search in files"
          title="Search in Files"
          onClick={onShowSearch}
        >
          <Search className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh workspace files"
          title="Refresh Explorer"
          onClick={refreshAllEntries}
        >
          <RefreshCw
            className={cn("size-3.5", (entriesQuery.isPending || lazyLoading) && "animate-spin")}
          />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          aria-label="Collapse all files"
          title="Collapse Folders"
          disabled={directoryPaths.length === 0}
          onClick={collapseAllFiles}
        >
          <ChevronsDownUp className="size-3.5" />
        </button>
      </div>
      {filterVisible ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
          <input
            ref={filterInputRef}
            value={filterValue}
            onChange={(event) => setFilterValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setFilterValue("");
                setFilterVisible(false);
              }
            }}
            placeholder="Filter files"
            aria-label="Filter files"
            className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 text-xs text-foreground outline-none focus:border-primary"
          />
          {filterValue ? (
            <button
              type="button"
              aria-label="Clear file filter"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setFilterValue("")}
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      ) : null}
      {creationBusy || deleting ? (
        <div className="shrink-0 px-2 py-1 text-[10px] text-muted-foreground">
          {deleting ? "Deleting permanently…" : "Creating…"}
        </div>
      ) : null}
      {creationError ? (
        <div className="shrink-0 border-b border-destructive/20 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
          {creationError}
        </div>
      ) : null}
      {lazyListingError ? (
        <div className="shrink-0 border-b border-destructive/20 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
          {lazyListingError}
        </div>
      ) : null}
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <div
          className="flex min-h-0 flex-1 overflow-hidden"
          onKeyDownCapture={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              queueUnchangedCreationCommit();
            }
          }}
          onBlurCapture={queueUnchangedCreationCommit}
        >
          <FileTree
            model={model}
            aria-label={`${projectName} files`}
            className="min-h-0 flex-1 overflow-hidden"
            style={{
              colorScheme: resolvedTheme,
              ["--trees-fg-override" as string]: "var(--foreground)",
            }}
          />
        </div>
      )}
    </div>
  );
}

export default memo(FileBrowserPanel);
