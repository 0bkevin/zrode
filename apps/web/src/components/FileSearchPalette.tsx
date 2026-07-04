"use client";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { ArrowDownIcon, ArrowUpIcon, FileIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useProject, useThreadShell } from "../state/entities";
import { useComposerPathSearch } from "../state/queries";
import { primaryServerKeybindingsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";
import { cn } from "~/lib/utils";

const FILE_SEARCH_RESULT_LIMIT = 50;

interface FileSearchProjectContext {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly projectTitle: string;
}

function fileEntryDisplayParts(relativePath: string): {
  readonly name: string;
  readonly directory: string | null;
} {
  const separatorIndex = relativePath.lastIndexOf("/");
  if (separatorIndex === -1) {
    return { name: relativePath, directory: null };
  }
  return {
    name: relativePath.slice(separatorIndex + 1),
    directory: relativePath.slice(0, separatorIndex),
  };
}

export function buildFileSearchItems(input: {
  relativePaths: ReadonlyArray<string>;
  openFile: (relativePath: string) => void;
}): CommandPaletteActionItem[] {
  return input.relativePaths.map((relativePath) => {
    const { name, directory } = fileEntryDisplayParts(relativePath);
    return {
      kind: "action",
      value: `file:${relativePath}`,
      searchTerms: [relativePath, name],
      title: name,
      ...(directory !== null ? { description: directory } : {}),
      icon: <FileIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        input.openFile(relativePath);
      },
    };
  });
}

export function FileSearchPalette() {
  const [open, setOpen] = useState(false);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const projectContext = useMemo<FileSearchProjectContext | null>(
    () =>
      threadRef && project && cwd !== null ? { threadRef, cwd, projectTitle: project.title } : null,
    [cwd, project, threadRef],
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
        },
      });
      if (command !== "fileSearch.toggle") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      {open ? (
        <OpenFileSearchPaletteDialog projectContext={projectContext} setOpen={setOpen} />
      ) : null}
    </CommandDialog>
  );
}

function OpenFileSearchPaletteDialog(props: {
  readonly projectContext: FileSearchProjectContext | null;
  readonly setOpen: (open: boolean) => void;
}) {
  const { projectContext, setOpen } = props;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);

  const search = useComposerPathSearch({
    environmentId: projectContext?.threadRef.environmentId ?? null,
    cwd: projectContext?.cwd ?? null,
    query: deferredQuery,
  });

  const openFileSurfacePaths = useRightPanelStore((state) => {
    if (!projectContext) return null;
    return selectThreadRightPanelState(state.byThreadKey, projectContext.threadRef).surfaces;
  });

  const openFile = useCallback(
    (relativePath: string) => {
      if (!projectContext) return;
      useRightPanelStore.getState().openFile(projectContext.threadRef, relativePath);
      setOpen(false);
    },
    [projectContext, setOpen],
  );

  const executeItem = useCallback((item: CommandPaletteActionItem) => {
    void item.run();
  }, []);

  const trimmedQuery = deferredQuery.trim();
  const groups = useMemo<CommandPaletteGroup[]>(() => {
    if (!projectContext) {
      return [];
    }

    if (trimmedQuery.length === 0) {
      const openPaths = (openFileSurfacePaths ?? []).flatMap((surface) =>
        surface.kind === "file" ? [surface.relativePath] : [],
      );
      if (openPaths.length === 0) {
        return [];
      }
      return [
        {
          value: "open-files",
          label: "Open Files",
          items: buildFileSearchItems({ relativePaths: openPaths, openFile }),
        },
      ];
    }

    const filePaths = search.entries
      .flatMap((entry) => (entry.kind === "file" ? [entry.path] : []))
      .slice(0, FILE_SEARCH_RESULT_LIMIT);
    if (filePaths.length === 0) {
      return [];
    }
    return [
      {
        value: "files",
        label: "Files",
        items: buildFileSearchItems({ relativePaths: filePaths, openFile }),
      },
    ];
  }, [openFile, openFileSurfacePaths, projectContext, search.entries, trimmedQuery]);

  const emptyStateMessage = !projectContext
    ? "Open a thread to search its project files."
    : trimmedQuery.length === 0
      ? "Type to search files in this project."
      : search.isPending
        ? "Searching files…"
        : (search.error ?? "No matching files.");

  return (
    <CommandDialogPopup
      aria-label="File search"
      className="overflow-hidden p-0"
      data-command-palette="true"
      data-testid="file-search-palette"
      onBackdropPointerDown={() => {
        setOpen(false);
      }}
    >
      <Command
        aria-label="File search"
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={setQuery}
        value={query}
      >
        <CommandInput
          placeholder={
            projectContext ? `Search files in ${projectContext.projectTitle}...` : "Search files..."
          }
          onKeyDown={(event) => {
            // Results arrive asynchronously, so the list may have no highlight
            // yet when the user presses Enter; open the top match in that case.
            if (event.key !== "Enter" || highlightedItemValue !== null) {
              return;
            }
            const firstItem = groups[0]?.items[0];
            if (!firstItem || firstItem.kind !== "action") {
              return;
            }
            event.preventDefault();
            executeItem(firstItem);
          }}
        />
        <CommandPanel className="max-h-[min(28rem,70vh)]">
          <CommandPaletteResults
            emptyStateMessage={emptyStateMessage}
            groups={groups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind !== "action") return;
              executeItem(item);
            }}
          />
        </CommandPanel>
        <CommandFooter>
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span className={cn("text-muted-foreground/80")}>Navigate</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Enter</Kbd>
              <span className={cn("text-muted-foreground/80")}>Open file</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span className={cn("text-muted-foreground/80")}>Close</span>
            </KbdGroup>
          </div>
        </CommandFooter>
      </Command>
    </CommandDialogPopup>
  );
}
