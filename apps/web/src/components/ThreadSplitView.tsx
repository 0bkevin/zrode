/**
 * Split-pane container for the thread route.
 *
 * Renders the pane tree from `usePaneLayoutStore`: each leaf hosts a full
 * ChatView, splits arrange children with draggable dividers, and while a
 * sidebar thread row is being dragged every pane shows a drop overlay
 * (edges split, center replaces). With no tree materialized it renders the
 * plain single ChatView the route always had.
 *
 * The URL stays the source of truth for the *focused* pane: focusing a pane
 * navigates to its thread, and navigating (e.g. clicking a sidebar row)
 * swaps the focused pane's thread.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DragEvent as ReactDragEvent,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import {
  collectLeaves,
  type DropRegion,
  findLeafById,
  findLeafByThreadKey,
  MIN_PANE_FRACTION,
  MIN_PANE_SIZE_PX,
  normalizeSizes,
  type PaneLeafNode,
  type PaneNode,
  type PaneSplitNode,
  resizeSplitPair,
  resolveDropRegion,
} from "../paneLayout.logic";
import {
  closePaneLeaf,
  THREAD_DRAG_MIME,
  usePaneLayoutStore,
  useThreadDragStore,
} from "../paneLayoutStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useThread, useThreadDetail, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { threadRouteOptionsForKey } from "../threadRoutes";
import ChatView from "./ChatView";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

interface PaneActions {
  focusPane: (leafId: string) => void;
  closePane: (leafId: string) => void;
  dropThread: (leafId: string, region: DropRegion, threadKey: string) => void;
}

const PaneActionsContext = createContext<PaneActions | null>(null);

/**
 * DOM node the focused pane portals its ChatView top bar into, so the top
 * bar renders once, full-width, above the splits instead of inside a pane.
 */
const PaneTopBarContext = createContext<HTMLElement | null>(null);

export default function ThreadSplitView({ threadRef }: { threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const root = usePaneLayoutStore((state) => state.root);
  const [topBarNode, setTopBarNode] = useState<HTMLElement | null>(null);
  const routeThreadKey = scopedThreadKey(threadRef);
  const routeThreadKeyRef = useRef(routeThreadKey);
  useEffect(() => {
    routeThreadKeyRef.current = routeThreadKey;
  }, [routeThreadKey]);

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

  // The URL follows the focused pane; navigation retargets the focused pane.
  useEffect(() => {
    const store = usePaneLayoutStore.getState();
    if (store.root === null) {
      return;
    }
    let focusedLeaf =
      store.focusedLeafId === null ? null : findLeafById(store.root, store.focusedLeafId);
    if (focusedLeaf === null) {
      focusedLeaf = collectLeaves(store.root)[0] ?? null;
      if (focusedLeaf !== null) {
        store.focusLeaf(focusedLeaf.id);
      }
    }
    if (focusedLeaf !== null && focusedLeaf.threadKey !== routeThreadKey) {
      // Already open in another pane? Focus that pane instead of creating a
      // duplicate — a thread can only be shown once (shared thread state).
      const existing = findLeafByThreadKey(store.root, routeThreadKey);
      if (existing !== null) {
        store.focusLeaf(existing.id);
      } else {
        store.setLeafThread(focusedLeaf.id, routeThreadKey);
      }
    }
  }, [routeThreadKey]);

  // Safety net: the drop overlays must never outlive the drag. `dragend`
  // covers the normal cases, but it is dispatched at the drag *source* — if
  // the sidebar row unmounted mid-drag (remote archive, list regroup) it
  // never fires. Mouse events are suppressed during a native drag, so the
  // first `mousemove` after attach means the drag is over; Escape is the
  // explicit cancel. Listeners exist only while a drag is active.
  useEffect(() => {
    let detach: (() => void) | null = null;
    const attach = () => {
      if (detach !== null) {
        return;
      }
      const attachedAt = Date.now();
      const end = () => useThreadDragStore.getState().endThreadDrag();
      const onMouseMove = () => {
        // Ignore a mousemove already queued when the drag started.
        if (Date.now() - attachedAt > 300) {
          end();
        }
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          end();
        }
      };
      window.addEventListener("dragend", end);
      window.addEventListener("drop", end);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("keydown", onKeyDown);
      detach = () => {
        window.removeEventListener("dragend", end);
        window.removeEventListener("drop", end);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("keydown", onKeyDown);
        detach = null;
      };
    };
    if (useThreadDragStore.getState().draggingThreadKey !== null) {
      attach();
    }
    const unsubscribe = useThreadDragStore.subscribe((state) => {
      if (state.draggingThreadKey !== null) {
        attach();
      } else {
        detach?.();
      }
    });
    return () => {
      unsubscribe();
      detach?.();
    };
  }, []);

  const focusPane = useCallback(
    (leafId: string) => {
      const store = usePaneLayoutStore.getState();
      if (store.root === null) {
        return;
      }
      if (store.focusedLeafId !== leafId) {
        store.focusLeaf(leafId);
      }
      const leaf = findLeafById(store.root, leafId);
      if (leaf !== null && leaf.threadKey !== routeThreadKeyRef.current) {
        navigateToThreadKey(leaf.threadKey);
      }
    },
    [navigateToThreadKey],
  );

  const closePane = useCallback(
    (leafId: string) => {
      const nextThreadKey = closePaneLeaf(leafId);
      if (nextThreadKey !== null && nextThreadKey !== routeThreadKeyRef.current) {
        navigateToThreadKey(nextThreadKey);
      }
    },
    [navigateToThreadKey],
  );

  const dropThread = useCallback(
    (leafId: string, region: DropRegion, threadKey: string) => {
      const store = usePaneLayoutStore.getState();
      if (store.root === null) {
        return;
      }
      const existing = findLeafByThreadKey(store.root, threadKey);
      if (existing !== null) {
        // Thread is already open in a pane — reveal it instead of duplicating.
        store.focusLeaf(existing.id);
        navigateToThreadKey(threadKey);
        return;
      }
      if (region === "center") {
        store.setLeafThread(leafId, threadKey);
        store.focusLeaf(leafId);
      } else {
        store.splitLeafPane(leafId, threadKey, region);
      }
      navigateToThreadKey(threadKey);
    },
    [navigateToThreadKey],
  );

  const actions = useMemo(
    () => ({ focusPane, closePane, dropThread }),
    [closePane, dropThread, focusPane],
  );

  const dropOnSingle = useCallback(
    (region: DropRegion, threadKey: string) => {
      // Dropping the thread that is already open just keeps the single view.
      if (region === "center" || threadKey === routeThreadKeyRef.current) {
        navigateToThreadKey(threadKey);
        return;
      }
      usePaneLayoutStore.getState().splitFromSingle(routeThreadKeyRef.current, threadKey, region);
      navigateToThreadKey(threadKey);
    },
    [navigateToThreadKey],
  );

  if (isMobile || root === null) {
    return (
      <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
        />
        {!isMobile && <PaneDropOverlay onDropThread={dropOnSingle} />}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
      {/* The focused pane's ChatView portals its top bar here. */}
      <div ref={setTopBarNode} className="shrink-0" />
      <div className="relative flex min-h-0 w-full min-w-0 flex-1">
        <PaneActionsContext.Provider value={actions}>
          <PaneTopBarContext.Provider value={topBarNode}>
            <PaneTree node={root} />
          </PaneTopBarContext.Provider>
        </PaneActionsContext.Provider>
      </div>
    </div>
  );
}

function PaneTree({ node }: { node: PaneNode }) {
  if (node.type === "leaf") {
    return <LeafPane leaf={node} />;
  }
  return <SplitContainer split={node} />;
}

const LeafPane = memo(function LeafPane({ leaf }: { leaf: PaneLeafNode }) {
  const actions = useContext(PaneActionsContext);
  const topBarNode = useContext(PaneTopBarContext);
  const isFocused = usePaneLayoutStore((state) => state.focusedLeafId === leaf.id);
  const threadRef = useMemo(() => parseScopedThreadKey(leaf.threadKey), [leaf.threadKey]);
  const thread = useThread(threadRef);
  const threadShell = useThreadShell(threadRef);
  const threadDetail = useThreadDetail(threadRef);
  const draftThread = useComposerDraftStore((store) =>
    threadRef === null ? null : store.getDraftThreadByRef(threadRef),
  );
  const shellQuery = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const bootstrapComplete = shellQuery.data?.snapshot._tag === "Some";
  const threadExists = threadShell !== null || threadDetail !== null || draftThread !== null;
  // Only declare a thread dead once its environment has bootstrapped —
  // before that, "not found" just means "not loaded yet".
  const threadMissing = threadRef === null || (bootstrapComplete && !threadExists);
  const title =
    thread?.title?.trim() || (draftThread !== null ? "Draft thread" : "Untitled thread");

  const focusPaneUnlessClosing = useCallback(
    (target: EventTarget | null) => {
      // Closing must not first refocus (and navigate to) the pane being closed.
      if (target instanceof HTMLElement && target.closest("[data-pane-close]")) {
        return;
      }
      actions?.focusPane(leaf.id);
    },
    [actions, leaf.id],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      focusPaneUnlessClosing(event.target);
    },
    [focusPaneUnlessClosing],
  );

  // Keyboard focus (Tab into a background pane's composer) must retarget the
  // URL and shared top bar the same way a click does.
  const handleFocusCapture = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      focusPaneUnlessClosing(event.target);
    },
    [focusPaneUnlessClosing],
  );

  const handleClose = useCallback(() => {
    actions?.closePane(leaf.id);
  }, [actions, leaf.id]);

  const handleDropThread = useCallback(
    (region: DropRegion, threadKey: string) => {
      actions?.dropThread(leaf.id, region, threadKey);
    },
    [actions, leaf.id],
  );

  return (
    <section
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background"
      data-testid={`thread-pane-${leaf.id}`}
      data-focused={isFocused || undefined}
      onPointerDownCapture={handlePointerDownCapture}
      onFocusCapture={handleFocusCapture}
    >
      <header
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 border-b border-border/60 px-2",
          isFocused ? "bg-accent/40" : "bg-background",
        )}
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[11px]",
            isFocused ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {title}
        </span>
        <button
          type="button"
          aria-label="Close pane"
          data-pane-close
          className="rounded-sm p-0.5 text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onClick={handleClose}
        >
          <X className="size-3" />
        </button>
      </header>
      {/* ChatView's root is `flex-1`; it needs a flex column with a bounded height. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {threadRef !== null && !threadMissing ? (
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            topBarSlot={isFocused ? topBarNode : null}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            <span className="text-xs text-muted-foreground">
              This thread is no longer available.
            </span>
            <button
              type="button"
              data-pane-close
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onClick={handleClose}
            >
              Close pane
            </button>
          </div>
        )}
      </div>
      <PaneDropOverlay onDropThread={handleDropThread} />
    </section>
  );
});

interface SplitDragState {
  pointerId: number;
  index: number;
  start: number;
  span: number;
  minFraction: number;
  startSizes: readonly number[];
  pending: number[] | null;
  rafId: number | null;
  target: HTMLElement;
}

/** Fraction of the container a single Arrow keypress moves a divider. */
const KEYBOARD_RESIZE_STEP = 0.02;

function minFractionForSpan(span: number): number {
  return span > 0 ? Math.max(MIN_PANE_FRACTION, MIN_PANE_SIZE_PX / span) : MIN_PANE_FRACTION;
}

function SplitContainer({ split }: { split: PaneSplitNode }) {
  const isRow = split.direction === "row";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setSplitSizes = usePaneLayoutStore((state) => state.setSplitSizes);
  const sizes = useMemo(
    () => normalizeSizes(split.sizes, split.children.length),
    [split.children.length, split.sizes],
  );
  const dragRef = useRef<SplitDragState | null>(null);

  const releasePointer = useCallback((pointerId: number) => {
    const state = dragRef.current;
    if (state === null) {
      return;
    }
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
    }
    try {
      if (state.target.hasPointerCapture(pointerId)) {
        state.target.releasePointerCapture(pointerId);
      }
    } catch {
      // pointer may already be released; harmless.
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    dragRef.current = null;
  }, []);

  const handlePointerDown = useCallback(
    (index: number, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      const container = containerRef.current;
      if (container === null) {
        return;
      }
      const rect = container.getBoundingClientRect();
      const span = isRow ? rect.width : rect.height;
      if (span <= 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      document.body.style.cursor = isRow ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      dragRef.current = {
        pointerId: event.pointerId,
        index,
        start: isRow ? event.clientX : event.clientY,
        span,
        minFraction: minFractionForSpan(span),
        startSizes: sizes,
        pending: null,
        rafId: null,
        target,
      };
    },
    [isRow, sizes],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragRef.current;
      if (state === null || state.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      const position = isRow ? event.clientX : event.clientY;
      const delta = (position - state.start) / state.span;
      state.pending = resizeSplitPair(
        state.startSizes,
        state.startSizes.length,
        state.index,
        delta,
        state.minFraction,
      );
      if (state.rafId !== null) {
        return;
      }
      state.rafId = requestAnimationFrame(() => {
        const active = dragRef.current;
        if (active === null) {
          return;
        }
        active.rafId = null;
        if (active.pending !== null) {
          setSplitSizes(split.id, active.pending);
        }
      });
    },
    [isRow, setSplitSizes, split.id],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragRef.current;
      if (state === null || state.pointerId !== event.pointerId) {
        return;
      }
      const finalSizes = state.pending;
      releasePointer(event.pointerId);
      if (finalSizes !== null) {
        setSplitSizes(split.id, finalSizes);
      }
    },
    [releasePointer, setSplitSizes, split.id],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragRef.current;
      if (state === null || state.pointerId !== event.pointerId) {
        return;
      }
      const startSizes = [...state.startSizes];
      releasePointer(event.pointerId);
      setSplitSizes(split.id, startSizes);
    },
    [releasePointer, setSplitSizes, split.id],
  );

  const handleSeparatorKeyDown = useCallback(
    (index: number, event: ReactKeyboardEvent<HTMLElement>) => {
      const decreaseKey = isRow ? "ArrowLeft" : "ArrowUp";
      const increaseKey = isRow ? "ArrowRight" : "ArrowDown";
      const delta =
        event.key === decreaseKey
          ? -KEYBOARD_RESIZE_STEP
          : event.key === increaseKey
            ? KEYBOARD_RESIZE_STEP
            : null;
      if (delta === null) {
        return;
      }
      event.preventDefault();
      const container = containerRef.current;
      const span = container === null ? 0 : isRow ? container.clientWidth : container.clientHeight;
      setSplitSizes(
        split.id,
        resizeSplitPair(sizes, sizes.length, index, delta, minFractionForSpan(span)),
      );
    },
    [isRow, setSplitSizes, sizes, split.id],
  );

  return (
    <div
      ref={containerRef}
      className={cn("flex h-full min-h-0 w-full min-w-0", isRow ? "flex-row" : "flex-col")}
    >
      {split.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && (
            <div
              role="separator"
              tabIndex={0}
              aria-label="Resize panes"
              aria-orientation={isRow ? "vertical" : "horizontal"}
              aria-valuenow={Math.round((sizes[index - 1] ?? 0) * 100)}
              aria-valuemin={Math.round(MIN_PANE_FRACTION * 100)}
              aria-valuemax={100 - Math.round(MIN_PANE_FRACTION * 100)}
              className={cn(
                "group relative z-20 shrink-0 select-none outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                isRow ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
              )}
              onPointerDown={(event) => handlePointerDown(index - 1, event)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onKeyDown={(event) => handleSeparatorKeyDown(index - 1, event)}
            >
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute bg-border transition-colors duration-150 group-hover:bg-primary/50 group-active:bg-primary/60 group-focus-visible:bg-primary/60",
                  isRow
                    ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
                    : "inset-x-0 top-1/2 h-px -translate-y-1/2",
                )}
              />
            </div>
          )}
          <div
            className="relative flex min-h-0 min-w-0 overflow-hidden"
            style={{ flexBasis: 0, flexGrow: sizes[index], flexShrink: 1 }}
          >
            <PaneTree node={child} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function computeDropRegion(event: ReactDragEvent<HTMLElement>, element: HTMLElement): DropRegion {
  const rect = element.getBoundingClientRect();
  return resolveDropRegion({
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    width: rect.width,
    height: rect.height,
  });
}

function dropHighlightClass(region: DropRegion): string {
  switch (region) {
    case "left":
      return "inset-y-0 left-0 w-1/2";
    case "right":
      return "inset-y-0 right-0 w-1/2";
    case "top":
      return "inset-x-0 top-0 h-1/2";
    case "bottom":
      return "inset-x-0 bottom-0 h-1/2";
    case "center":
      return "inset-0";
  }
}

/**
 * Full-pane drop target, mounted only while a sidebar thread row is being
 * dragged. Edge drops split the pane toward that edge; a center drop opens
 * the thread in this pane.
 */
function PaneDropOverlay({
  onDropThread,
}: {
  onDropThread: (region: DropRegion, threadKey: string) => void;
}) {
  const draggingThreadKey = useThreadDragStore((state) => state.draggingThreadKey);
  const [region, setRegion] = useState<DropRegion | null>(null);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(THREAD_DRAG_MIME)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setRegion(computeDropRegion(event, event.currentTarget));
  }, []);

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setRegion(null);
  }, []);

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const threadKey =
        event.dataTransfer.getData(THREAD_DRAG_MIME) ||
        useThreadDragStore.getState().draggingThreadKey;
      const dropRegion = computeDropRegion(event, event.currentTarget);
      setRegion(null);
      useThreadDragStore.getState().endThreadDrag();
      if (threadKey) {
        onDropThread(dropRegion, threadKey);
      }
    },
    [onDropThread],
  );

  if (draggingThreadKey === null) {
    return null;
  }

  return (
    <div
      className="absolute inset-0 z-40"
      data-testid="pane-drop-overlay"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {region !== null && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute rounded-md border-2 border-primary/50 bg-primary/15 transition-all duration-100",
            dropHighlightClass(region),
          )}
        />
      )}
    </div>
  );
}
