import type { FileTreeDirectoryHandle, FileTreeItemHandle } from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  ChevronsDownUp,
  FilePlus2,
  FolderPlus,
  ListFilter,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { ZRODE_PIERRE_ICONS } from "~/pierre-icons";

import { resetFileTreePathsPreservingExpansion, revealActiveFile } from "./fileBrowserTreeState";
import {
  clearFailedPierreCreation,
  type OptimisticWorkspaceEntry,
  queueUnchangedPierreCreationCommit,
  reconcileOptimisticWorkspaceEntries,
  type WorkspaceCreationKind,
  type WorkspaceCreationSession,
} from "./fileBrowserCreation";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  activeRelativePath: string | null;
  onOpenFile: (relativePath: string) => void;
  onCreateFile: (relativePath: string) => Promise<void>;
  onCreateDirectory: (relativePath: string) => Promise<void>;
  onShowSearch: () => void;
}

const OPTIMISTIC_ENTRY_TTL_MS = 10_000;

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 0; }
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
  onShowSearch,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const refreshEntries = entriesQuery.refresh;
  const entries = entriesQuery.data?.entries ?? [];
  const [filterVisible, setFilterVisible] = useState(false);
  const [filterValue, setFilterValue] = useState("");
  const [creationSession, setCreationSession] = useState<WorkspaceCreationSession | null>(null);
  const [optimisticEntries, setOptimisticEntries] = useState<readonly OptimisticWorkspaceEntry[]>(
    [],
  );
  const [creationError, setCreationError] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const creationSessionRef = useRef<WorkspaceCreationSession | null>(creationSession);
  const modelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const commitCreationRef = useRef<(session: WorkspaceCreationSession) => void>(() => undefined);
  const nextOptimisticEntryIdRef = useRef(0);
  const createFileRef = useRef(onCreateFile);
  const createDirectoryRef = useRef(onCreateDirectory);
  createFileRef.current = onCreateFile;
  createDirectoryRef.current = onCreateDirectory;

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
          refreshEntries();
          if (session.kind === "file") onOpenFileRef.current(optimistic.path);
        },
        (error: unknown) => {
          creationSessionRef.current = null;
          setCreationSession(null);
          setCreationError(error instanceof Error ? error.message : "Could not create the item.");
          refreshEntries();
        },
      );
    },
    [refreshEntries],
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

      if (pathsChanged || activePathChanged) {
        revealActiveFile({ activeRelativePath, entryKinds, model });
      }
    } finally {
      suppressSelectionChangeRef.current = false;
    }
  }, [activeRelativePath, directoryPaths, entryKinds, model, treePaths]);

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

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );
  const creationBusy = creationSession?.status === "committing";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-y border-border/60 px-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-foreground">
            {projectName}
          </div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {entriesQuery.isPending && entriesQuery.data === null
              ? "Indexing…"
              : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data?.truncated ? " · partial" : ""}
          </div>
        </div>
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
          onClick={entriesQuery.refresh}
        >
          <RefreshCw className={cn("size-3.5", entriesQuery.isPending && "animate-spin")} />
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
      {creationBusy ? (
        <div className="shrink-0 px-2 py-1 text-[10px] text-muted-foreground">Creating…</div>
      ) : null}
      {creationError ? (
        <div className="shrink-0 border-b border-destructive/20 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
          {creationError}
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
