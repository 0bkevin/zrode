/**
 * Sidebar section mirroring the split-pane layout: one entry per pane in
 * visual order (left→right, top→bottom), click to focus that pane, ✕ to
 * close it, and a header action to close the whole split. Threads stay
 * listed in their project groups — this is a second view of the layout,
 * not a move — and the section only renders while a split is active on a
 * viewport that can show it (splits are desktop-only).
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ChevronRightIcon, Columns2Icon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { collectLeaves, type PaneLeafNode } from "../paneLayout.logic";
import { closePaneLeaf, usePaneLayoutStore } from "../paneLayoutStore";
import { useProjects, useThreadShells } from "../state/entities";
import { resolveThreadRouteRef, threadRouteOptionsForKey } from "../threadRoutes";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

export function SidebarSplitViewSection() {
  const root = usePaneLayoutStore((state) => state.root);
  const focusedLeafId = usePaneLayoutStore((state) => state.focusedLeafId);
  const [collapsed, setCollapsed] = useState(false);
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const shells = useThreadShells();
  const projects = useProjects();
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);

  const routeRef = resolveThreadRouteRef(params);
  const routeThreadKey = routeRef === null ? null : scopedThreadKey(routeRef);

  const navigateToThreadKey = useCallback(
    (threadKey: string) => {
      const options = threadRouteOptionsForKey(threadKey);
      if (options === null) {
        return;
      }
      void navigate(options);
    },
    [navigate],
  );

  const handleFocusPane = useCallback(
    (leaf: PaneLeafNode) => {
      usePaneLayoutStore.getState().focusLeaf(leaf.id);
      navigateToThreadKey(leaf.threadKey);
    },
    [navigateToThreadKey],
  );

  const handleClosePane = useCallback(
    (leafId: string) => {
      const nextThreadKey = closePaneLeaf(leafId);
      // Keep the URL on a visible pane, but never yank the user off a
      // non-thread route (e.g. the index) just because a pane closed.
      if (routeThreadKey !== null && nextThreadKey !== null && nextThreadKey !== routeThreadKey) {
        navigateToThreadKey(nextThreadKey);
      }
    },
    [navigateToThreadKey, routeThreadKey],
  );

  const handleCloseAll = useCallback(() => {
    usePaneLayoutStore.getState().reset();
  }, []);

  // Splits never render on mobile; showing controls that mutate an
  // invisible layout would only confuse.
  if (root === null || isMobile) {
    return null;
  }

  const leaves = collectLeaves(root);

  return (
    <SidebarGroup className="px-2 pt-2 pb-0" data-testid="split-view-section">
      <div className="mb-1 flex items-center gap-1 pl-2 pr-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm text-left outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Split view
          </span>
          <ChevronRightIcon
            className={cn(
              "size-3 text-muted-foreground/60 transition-transform",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Close all split panes"
                data-testid="split-view-close-all"
                className="flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                onClick={handleCloseAll}
              >
                <XIcon className="size-3" />
              </button>
            }
          />
          <TooltipPopup side="top">Close all split panes</TooltipPopup>
        </Tooltip>
      </div>
      {!collapsed && (
        <SidebarMenu>
          {leaves.map((leaf) => {
            const ref = parseScopedThreadKey(leaf.threadKey);
            const shell =
              ref === null
                ? null
                : (shells.find(
                    (candidate) =>
                      candidate.environmentId === ref.environmentId &&
                      candidate.id === ref.threadId,
                  ) ?? null);
            const project =
              shell === null
                ? null
                : (projects.find(
                    (candidate) =>
                      candidate.environmentId === shell.environmentId &&
                      candidate.id === shell.projectId,
                  ) ?? null);
            const isDraft =
              shell === null &&
              ref !== null &&
              Object.values(draftThreadsByThreadKey).some(
                (draft) =>
                  draft.environmentId === ref.environmentId && draft.threadId === ref.threadId,
              );
            const title = shell?.title ?? (isDraft ? "Draft thread" : "Untitled thread");
            return (
              <SidebarMenuItem key={leaf.id}>
                <SidebarMenuButton
                  size="sm"
                  isActive={focusedLeafId === leaf.id}
                  data-testid={`split-view-entry-${leaf.id}`}
                  className="gap-1.5 pr-7"
                  onClick={() => handleFocusPane(leaf)}
                >
                  <Columns2Icon className="size-3 shrink-0 text-muted-foreground/70" />
                  {project !== null && (
                    <span className="max-w-24 shrink-0 truncate text-[11px] text-muted-foreground">
                      {project.title}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs">{title}</span>
                </SidebarMenuButton>
                <SidebarMenuAction
                  aria-label={`Close split pane for ${title}`}
                  showOnHover
                  onClick={() => handleClosePane(leaf.id)}
                >
                  <XIcon className="size-3.5" />
                </SidebarMenuAction>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
