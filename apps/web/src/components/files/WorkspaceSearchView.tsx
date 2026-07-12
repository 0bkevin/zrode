import { useAtomValue } from "@effect/atom-react";
import {
  PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH,
  type EnvironmentId,
  type ProjectSearchTextInput,
  type ProjectSearchTextMatch,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Regex,
  Search,
  Square,
  WholeWord,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import { projectEnvironment } from "~/state/projects";
import type { FileRevealTarget } from "~/rightPanelStore";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import {
  normalizeWorkspaceSearchGlobInput,
  normalizeWorkspaceSearchQuery,
  parseWorkspaceSearchGlobs,
  WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH,
} from "./workspaceSearchInput";
import {
  calculateWorkspaceSearchVirtualWindow,
  WORKSPACE_SEARCH_ROW_HEIGHT,
} from "./workspaceSearchVirtualization";

interface WorkspaceSearchViewProps {
  environmentId: EnvironmentId;
  cwd: string;
  focusRequestId: number;
  onOpenFile: (relativePath: string, target: FileRevealTarget) => void;
}

interface SearchRequest {
  readonly id: number;
  readonly input: ProjectSearchTextInput;
}

function resultError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Workspace search failed.";
}

function MatchPreview({ match }: { match: ProjectSearchTextMatch }) {
  const start = Math.max(0, match.column - match.lineTextStartColumn);
  const end = Math.max(start, match.endColumn - match.lineTextStartColumn);
  const text = match.lineText.replace(/[\r\n]+$/, "");
  return (
    <span className="block min-w-0 truncate font-mono text-[11px] leading-5">
      {match.lineTextStartColumn > 1 ? <span aria-hidden="true">…</span> : null}
      <span>{text.slice(0, start)}</span>
      <mark className="rounded-sm bg-[color-mix(in_srgb,var(--primary)_28%,transparent)] text-inherit">
        {text.slice(start, end) || match.matchText}
      </mark>
      <span>{text.slice(end)}</span>
    </span>
  );
}

function SearchResults({
  environmentId,
  request,
  onOpenFile,
  onCancel,
}: {
  environmentId: EnvironmentId;
  request: SearchRequest;
  onOpenFile: WorkspaceSearchViewProps["onOpenFile"];
  onCancel: () => void;
}) {
  const result = useAtomValue(
    projectEnvironment.searchText({
      environmentId,
      input: request.input,
      requestKey: request.id,
    }),
  );
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const error = resultError(result);
  const groups = useMemo(() => {
    const grouped = new Map<string, ProjectSearchTextMatch[]>();
    for (const match of snapshot?.matches ?? []) {
      const current = grouped.get(match.relativePath);
      if (current) current.push(match);
      else grouped.set(match.relativePath, [match]);
    }
    return [...grouped.entries()];
  }, [snapshot?.matches]);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => {
    const flattened: SearchResultRow[] = [];
    for (const [relativePath, matches] of groups) {
      flattened.push({ kind: "group", relativePath, matches });
      if (collapsedPaths.has(relativePath)) continue;

      const occurrences = new Map<string, number>();
      for (const match of matches) {
        const signature = `${match.line}:${match.column}:${match.endColumn}:${match.lineTextStartColumn}:${match.matchText}:${match.lineText}`;
        const occurrence = occurrences.get(signature) ?? 0;
        occurrences.set(signature, occurrence + 1);
        flattened.push({
          kind: "match",
          key: `${relativePath}:${signature}:${occurrence}`,
          relativePath,
          match,
        });
      }
    }
    return flattened;
  }, [collapsedPaths, groups]);
  const running = error === null && snapshot?.complete !== true;
  const displayedCount = snapshot?.complete ? snapshot.matchCount : (snapshot?.matches.length ?? 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 px-2 text-[10px] text-muted-foreground">
        {running ? <LoaderCircle className="size-3 animate-spin" /> : null}
        <span className="min-w-0 flex-1 truncate" role="status" aria-live="polite">
          {running
            ? `${displayedCount.toLocaleString()} results…`
            : error
              ? "Search failed"
              : `${(snapshot?.matchCount ?? 0).toLocaleString()} results in ${(snapshot?.fileCount ?? 0).toLocaleString()} files`}
          {snapshot?.truncated ? ` · limit ${request.input.limit.toLocaleString()} reached` : ""}
        </span>
        {running ? (
          <button
            type="button"
            className="rounded p-1 hover:bg-accent hover:text-foreground"
            onClick={onCancel}
            aria-label="Cancel search"
            title="Cancel Search"
          >
            <Square className="size-2.5 fill-current" />
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="p-3 text-xs leading-relaxed text-destructive">{error}</div>
      ) : groups.length === 0 && !running ? (
        <div className="p-4 text-center text-xs text-muted-foreground">No results found.</div>
      ) : (
        <VirtualSearchResults
          rows={rows}
          collapsedPaths={collapsedPaths}
          onToggleGroup={(relativePath) => {
            setCollapsedPaths((current) => {
              const next = new Set(current);
              if (next.has(relativePath)) next.delete(relativePath);
              else next.add(relativePath);
              return next;
            });
          }}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}

type SearchResultRow =
  | {
      readonly kind: "group";
      readonly relativePath: string;
      readonly matches: readonly ProjectSearchTextMatch[];
    }
  | {
      readonly kind: "match";
      readonly key: string;
      readonly relativePath: string;
      readonly match: ProjectSearchTextMatch;
    };

function VirtualSearchResults({
  rows,
  collapsedPaths,
  onToggleGroup,
  onOpenFile,
}: {
  rows: readonly SearchResultRow[];
  collapsedPaths: ReadonlySet<string>;
  onToggleGroup: (relativePath: string) => void;
  onOpenFile: WorkspaceSearchViewProps["onOpenFile"];
}) {
  const { resolvedTheme } = useTheme();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) return;

    const measure = () => setViewportHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) window.cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  const virtualWindow = calculateWorkspaceSearchVirtualWindow({
    rowCount: rows.length,
    scrollTop,
    viewportHeight,
  });
  const visibleRows = rows.slice(virtualWindow.startIndex, virtualWindow.endIndex);

  return (
    <div
      ref={scrollContainerRef}
      className="min-h-0 flex-1 overflow-y-auto py-0.5"
      onScroll={() => {
        if (scrollRafRef.current !== null) return;
        scrollRafRef.current = window.requestAnimationFrame(() => {
          scrollRafRef.current = null;
          setScrollTop(scrollContainerRef.current?.scrollTop ?? 0);
        });
      }}
    >
      <div className="relative" style={{ height: virtualWindow.totalHeight }}>
        <div
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${virtualWindow.offsetTop}px)` }}
        >
          {visibleRows.map((row) =>
            row.kind === "group" ? (
              <SearchResultGroupRow
                key={`group:${row.relativePath}`}
                relativePath={row.relativePath}
                matchCount={row.matches.length}
                expanded={!collapsedPaths.has(row.relativePath)}
                theme={resolvedTheme}
                onToggle={() => onToggleGroup(row.relativePath)}
              />
            ) : (
              <SearchResultMatchRow key={row.key} row={row} onOpenFile={onOpenFile} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function SearchResultGroupRow({
  relativePath,
  matchCount,
  expanded,
  theme,
  onToggle,
}: {
  relativePath: string;
  matchCount: number;
  expanded: boolean;
  theme: "light" | "dark";
  onToggle: () => void;
}) {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const directory = relativePath === name ? "" : relativePath.slice(0, -(name.length + 1));
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-1 px-1.5 text-left text-xs hover:bg-accent/60"
      style={{ height: WORKSPACE_SEARCH_ROW_HEIGHT }}
      aria-expanded={expanded}
      onClick={onToggle}
      title={relativePath}
    >
      {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      <PierreEntryIcon pathValue={relativePath} kind="file" theme={theme} className="size-3.5" />
      <span className="truncate font-medium text-foreground">{name}</span>
      {directory ? (
        <span className="truncate text-[10px] text-muted-foreground">{directory}</span>
      ) : null}
      <span className="ml-auto rounded-full bg-muted px-1.5 text-[9px] text-muted-foreground">
        {matchCount}
      </span>
    </button>
  );
}

function SearchResultMatchRow({
  row,
  onOpenFile,
}: {
  row: Extract<SearchResultRow, { kind: "match" }>;
  onOpenFile: WorkspaceSearchViewProps["onOpenFile"];
}) {
  const { relativePath, match } = row;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 pl-7 pr-2 text-left text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      style={{ height: WORKSPACE_SEARCH_ROW_HEIGHT }}
      onClick={() =>
        onOpenFile(relativePath, {
          kind: "range",
          start: { line: match.line, column: match.column },
          end: { line: match.line, column: match.endColumn },
        })
      }
      title={`${relativePath}:${match.line}:${match.column}`}
    >
      <span className="w-8 shrink-0 text-right font-mono text-[10px] opacity-70">{match.line}</span>
      <MatchPreview match={match} />
    </button>
  );
}

function WorkspaceSearchView({
  environmentId,
  cwd,
  focusRequestId,
  onOpenFile,
}: WorkspaceSearchViewProps) {
  const [query, setQuery] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [request, setRequest] = useState<SearchRequest | null>(null);
  const nextRequestIdRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);
  const queryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusRequestId > 0) queryRef.current?.focus();
  }, [focusRequestId]);

  const runSearch = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const normalizedQuery = normalizeWorkspaceSearchQuery(query);
    if (normalizedQuery.length === 0) {
      setRequest(null);
      return;
    }
    nextRequestIdRef.current += 1;
    setRequest({
      id: nextRequestIdRef.current,
      input: {
        cwd,
        query: normalizedQuery,
        isRegex,
        matchCase,
        wholeWord,
        includes: parseWorkspaceSearchGlobs(include),
        excludes: parseWorkspaceSearchGlobs(exclude),
        limit: 2_000,
      },
    });
  }, [cwd, exclude, include, isRegex, matchCase, query, wholeWord]);

  useEffect(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    // Input changes immediately unmount the prior request so its RPC is
    // interrupted before the replacement debounce starts.
    setRequest(null);
    if (query.length === 0) {
      debounceTimerRef.current = null;
      return;
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      runSearch();
    }, 150);
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [query, runSearch]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="shrink-0 space-y-1.5 border-b border-border/60 p-2">
        <div className="flex items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center rounded-sm border border-border bg-background focus-within:border-primary">
            <input
              ref={queryRef}
              value={query}
              maxLength={PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH}
              onChange={(event) => {
                setQuery(normalizeWorkspaceSearchQuery(event.target.value));
                setRequest(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch();
                if (event.key === "Escape") {
                  if (query) setQuery("");
                  setRequest(null);
                }
              }}
              placeholder="Search"
              aria-label="Search workspace contents"
              className="h-7 min-w-0 flex-1 bg-transparent px-2 text-xs text-foreground outline-none"
            />
            {query ? (
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => {
                  setQuery("");
                  setRequest(null);
                }}
                aria-label="Clear search query"
              >
                <X className="size-3" />
              </button>
            ) : null}
            {[
              { label: "Match Case", active: matchCase, set: setMatchCase, Icon: CaseSensitive },
              { label: "Match Whole Word", active: wholeWord, set: setWholeWord, Icon: WholeWord },
              { label: "Use Regular Expression", active: isRegex, set: setIsRegex, Icon: Regex },
            ].map(({ label, active, set, Icon }) => (
              <button
                key={label}
                type="button"
                className={cn(
                  "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
                  active && "bg-accent text-foreground ring-1 ring-primary/50",
                )}
                aria-label={label}
                title={label}
                aria-pressed={active}
                onClick={() => {
                  set(!active);
                  setRequest(null);
                }}
              >
                <Icon className="size-3.5" />
              </button>
            ))}
          </div>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            disabled={query.length === 0}
            onClick={runSearch}
            aria-label="Search"
          >
            <Search className="size-3.5" />
          </button>
        </div>
        <button
          type="button"
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          Files to include/exclude
        </button>
        {detailsOpen ? (
          <div className="space-y-1">
            <input
              value={include}
              maxLength={WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH}
              onChange={(event) => {
                setInclude(normalizeWorkspaceSearchGlobInput(event.target.value));
                setRequest(null);
              }}
              placeholder="files to include (e.g. src/**, *.ts)"
              aria-label="Files to include"
              className="h-6 w-full rounded-sm border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary"
            />
            <input
              value={exclude}
              maxLength={WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH}
              onChange={(event) => {
                setExclude(normalizeWorkspaceSearchGlobInput(event.target.value));
                setRequest(null);
              }}
              placeholder="files to exclude (e.g. dist/**)"
              aria-label="Files to exclude"
              className="h-6 w-full rounded-sm border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary"
            />
          </div>
        ) : null}
      </div>
      {request ? (
        <SearchResults
          key={request.id}
          environmentId={environmentId}
          request={request}
          onOpenFile={onOpenFile}
          onCancel={() => setRequest(null)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-5 text-center text-xs leading-relaxed text-muted-foreground">
          Search saved files on disk in this workspace. Unsaved editor changes are not included.
        </div>
      )}
    </div>
  );
}

export default memo(WorkspaceSearchView);
