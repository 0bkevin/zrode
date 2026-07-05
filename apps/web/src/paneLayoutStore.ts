/**
 * Split-pane thread layout state.
 *
 * `root === null` means the default single-thread view driven purely by the
 * route. The tree is materialized on the first drop-to-split and collapses
 * back to null when only one pane remains, so the plain thread route keeps
 * its existing behavior. The focused leaf is the pane the URL tracks.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createDebouncedStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import {
  collectLeaves,
  createLeaf,
  createSplitForEdge,
  dedupeThreadLeaves,
  type DropEdge,
  findLeafById,
  findLeafByThreadKey,
  type PaneNode,
  removeLeaf,
  replaceLeafThread,
  sanitizePaneNode,
  setSplitSizesInTree,
  splitLeaf,
} from "./paneLayout.logic";

/** dataTransfer type carrying a scoped thread key while dragging a sidebar row. */
export const THREAD_DRAG_MIME = "application/x-zrode-thread";

const PANE_LAYOUT_STORAGE_KEY = "zrode:pane-layout:v1";
const PANE_LAYOUT_STORAGE_VERSION = 1;

interface PaneLayoutStoreState {
  root: PaneNode | null;
  focusedLeafId: string | null;
  /** Materialize the tree: split the implicit single route pane. */
  splitFromSingle: (currentThreadKey: string, newThreadKey: string, edge: DropEdge) => void;
  splitLeafPane: (leafId: string, newThreadKey: string, edge: DropEdge) => void;
  setLeafThread: (leafId: string, threadKey: string) => void;
  focusLeaf: (leafId: string) => void;
  closeLeaf: (leafId: string) => void;
  setSplitSizes: (splitId: string, sizes: readonly number[]) => void;
  reset: () => void;
}

const createPaneId = (): string => randomUUID();

export function migratePersistedPaneLayoutState(persisted: unknown): {
  root: PaneNode | null;
  focusedLeafId: string | null;
} {
  if (typeof persisted !== "object" || persisted === null) {
    return { root: null, focusedLeafId: null };
  }
  const candidate = persisted as { root?: unknown; focusedLeafId?: unknown };
  const sanitized = sanitizePaneNode(candidate.root);
  const root = sanitized === null ? null : dedupeThreadLeaves(sanitized);
  // A lone leaf is the implicit route-driven view; don't persist it as a tree.
  if (root === null || root.type === "leaf") {
    return { root: null, focusedLeafId: null };
  }
  const focusedLeafId =
    typeof candidate.focusedLeafId === "string" &&
    findLeafById(root, candidate.focusedLeafId) !== null
      ? candidate.focusedLeafId
      : (collectLeaves(root)[0]?.id ?? null);
  return { root, focusedLeafId };
}

const paneLayoutStorage = createDebouncedStorage(
  typeof window !== "undefined" ? window.localStorage : undefined,
);

export const usePaneLayoutStore = create<PaneLayoutStoreState>()(
  persist(
    (set) => ({
      root: null,
      focusedLeafId: null,
      splitFromSingle: (currentThreadKey, newThreadKey, edge) =>
        set((state) => {
          if (state.root !== null || currentThreadKey === newThreadKey) {
            return state;
          }
          const current = createLeaf(createPaneId(), currentThreadKey);
          const added = createLeaf(createPaneId(), newThreadKey);
          return {
            root: createSplitForEdge(createPaneId(), current, added, edge),
            focusedLeafId: added.id,
          };
        }),
      splitLeafPane: (leafId, newThreadKey, edge) =>
        set((state) => {
          // A thread may only be open in one pane; callers reveal the
          // existing pane instead (duplicate ChatViews share thread state).
          if (state.root === null || findLeafByThreadKey(state.root, newThreadKey) !== null) {
            return state;
          }
          const added = createLeaf(createPaneId(), newThreadKey);
          const next = splitLeaf(state.root, leafId, edge, added, createPaneId);
          if (next === null) {
            return state;
          }
          return { root: next, focusedLeafId: added.id };
        }),
      setLeafThread: (leafId, threadKey) =>
        set((state) => {
          if (state.root === null) {
            return state;
          }
          const existing = findLeafByThreadKey(state.root, threadKey);
          if (existing !== null && existing.id !== leafId) {
            return state;
          }
          return { root: replaceLeafThread(state.root, leafId, threadKey) };
        }),
      focusLeaf: (leafId) =>
        set((state) => {
          if (
            state.focusedLeafId === leafId ||
            state.root === null ||
            findLeafById(state.root, leafId) === null
          ) {
            return state;
          }
          return { focusedLeafId: leafId };
        }),
      closeLeaf: (leafId) =>
        set((state) => {
          if (state.root === null) {
            return state;
          }
          const next = removeLeaf(state.root, leafId);
          if (next === state.root) {
            return state;
          }
          if (next === null || next.type === "leaf") {
            return { root: null, focusedLeafId: null };
          }
          const focusedStillExists =
            state.focusedLeafId !== null && findLeafById(next, state.focusedLeafId) !== null;
          return {
            root: next,
            focusedLeafId: focusedStillExists
              ? state.focusedLeafId
              : (collectLeaves(next)[0]?.id ?? null),
          };
        }),
      setSplitSizes: (splitId, sizes) =>
        set((state) =>
          state.root === null ? state : { root: setSplitSizesInTree(state.root, splitId, sizes) },
        ),
      reset: () => set({ root: null, focusedLeafId: null }),
    }),
    {
      name: PANE_LAYOUT_STORAGE_KEY,
      version: PANE_LAYOUT_STORAGE_VERSION,
      // Debounced: divider drags update sizes every animation frame.
      storage: createJSONStorage(() => paneLayoutStorage),
      partialize: (state) => ({ root: state.root, focusedLeafId: state.focusedLeafId }),
      merge: (persisted, current) => ({
        ...current,
        ...migratePersistedPaneLayoutState(persisted),
      }),
    },
  ),
);

// A layout change right before closing the window must not be lost to the
// storage debounce (same pattern as uiStateStore / composerDraftStore).
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    paneLayoutStorage.flush();
  });
}

/**
 * Close a pane and return the thread key the URL should show afterwards:
 * the focused survivor's thread, or null when nothing sensible remains.
 * Shared by the pane header strip and the sidebar split-view section so
 * their close semantics cannot drift.
 */
export function closePaneLeaf(leafId: string): string | null {
  const store = usePaneLayoutStore.getState();
  if (store.root === null) {
    return null;
  }
  const survivor = collectLeaves(store.root).find((leaf) => leaf.id !== leafId);
  store.closeLeaf(leafId);
  const after = usePaneLayoutStore.getState();
  return after.root !== null && after.focusedLeafId !== null
    ? (findLeafById(after.root, after.focusedLeafId)?.threadKey ?? null)
    : (survivor?.threadKey ?? null);
}

interface ThreadDragState {
  /** Scoped thread key of the sidebar row currently being dragged, if any. */
  draggingThreadKey: string | null;
  startThreadDrag: (threadKey: string) => void;
  endThreadDrag: () => void;
}

export const useThreadDragStore = create<ThreadDragState>()((set) => ({
  draggingThreadKey: null,
  startThreadDrag: (threadKey) => set({ draggingThreadKey: threadKey }),
  endThreadDrag: () =>
    set((state) => (state.draggingThreadKey === null ? state : { draggingThreadKey: null })),
}));
