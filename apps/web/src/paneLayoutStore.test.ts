import { beforeEach, describe, expect, it } from "vite-plus/test";

import { collectLeaves, findLeafById, type PaneSplitNode } from "./paneLayout.logic";
import {
  closePaneLeaf,
  migratePersistedPaneLayoutState,
  usePaneLayoutStore,
} from "./paneLayoutStore";

const store = () => usePaneLayoutStore.getState();

const leafIdForThread = (threadKey: string): string => {
  const root = store().root;
  if (root === null) {
    throw new Error("no pane tree");
  }
  const leaf = collectLeaves(root).find((entry) => entry.threadKey === threadKey);
  if (leaf === undefined) {
    throw new Error(`no leaf for ${threadKey}`);
  }
  return leaf.id;
};

describe("paneLayoutStore", () => {
  beforeEach(() => usePaneLayoutStore.setState({ root: null, focusedLeafId: null }));

  describe("splitFromSingle", () => {
    it("materializes a two-pane split and focuses the new pane", () => {
      store().splitFromSingle("t1", "t2", "right");
      const { root, focusedLeafId } = store();
      expect(root?.type).toBe("split");
      expect(collectLeaves(root!).map((leaf) => leaf.threadKey)).toEqual(["t1", "t2"]);
      expect(focusedLeafId).toBe(leafIdForThread("t2"));
    });

    it("places the new pane before the current one for top/left edges", () => {
      store().splitFromSingle("t1", "t2", "top");
      const root = store().root as PaneSplitNode;
      expect(root.direction).toBe("column");
      expect(collectLeaves(root).map((leaf) => leaf.threadKey)).toEqual(["t2", "t1"]);
    });

    it("does nothing when a tree already exists", () => {
      store().splitFromSingle("t1", "t2", "right");
      const before = store().root;
      store().splitFromSingle("t3", "t4", "right");
      expect(store().root).toBe(before);
    });

    it("refuses to split a thread against itself", () => {
      store().splitFromSingle("t1", "t1", "right");
      expect(store().root).toBeNull();
    });
  });

  describe("splitLeafPane", () => {
    it("adds a pane next to the target and focuses it", () => {
      store().splitFromSingle("t1", "t2", "right");
      store().splitLeafPane(leafIdForThread("t1"), "t3", "bottom");
      expect(collectLeaves(store().root!)).toHaveLength(3);
      expect(store().focusedLeafId).toBe(leafIdForThread("t3"));
    });

    it("refuses to open a thread already shown in another pane", () => {
      store().splitFromSingle("t1", "t2", "right");
      const before = store().root;
      store().splitLeafPane(leafIdForThread("t1"), "t2", "bottom");
      expect(store().root).toBe(before);
    });

    it("ignores unknown leaf ids", () => {
      store().splitFromSingle("t1", "t2", "right");
      const before = store().root;
      store().splitLeafPane("missing", "t3", "left");
      expect(store().root).toBe(before);
    });
  });

  describe("setLeafThread", () => {
    it("swaps a pane's thread", () => {
      store().splitFromSingle("t1", "t2", "right");
      store().setLeafThread(leafIdForThread("t1"), "t9");
      expect(collectLeaves(store().root!).map((leaf) => leaf.threadKey)).toEqual(["t9", "t2"]);
    });

    it("bails when the thread is already open in a different pane", () => {
      store().splitFromSingle("t1", "t2", "right");
      store().setLeafThread(leafIdForThread("t1"), "t2");
      expect(collectLeaves(store().root!).map((leaf) => leaf.threadKey)).toEqual(["t1", "t2"]);
    });
  });

  describe("focusLeaf", () => {
    it("focuses an existing leaf", () => {
      store().splitFromSingle("t1", "t2", "right");
      const target = leafIdForThread("t1");
      store().focusLeaf(target);
      expect(store().focusedLeafId).toBe(target);
    });

    it("ignores ids that are not in the tree", () => {
      store().splitFromSingle("t1", "t2", "right");
      const before = store().focusedLeafId;
      store().focusLeaf("missing");
      expect(store().focusedLeafId).toBe(before);
    });
  });

  describe("closeLeaf", () => {
    it("collapses to the implicit single view when one pane remains", () => {
      store().splitFromSingle("t1", "t2", "right");
      store().closeLeaf(leafIdForThread("t2"));
      expect(store().root).toBeNull();
      expect(store().focusedLeafId).toBeNull();
    });

    it("moves focus to a surviving pane when the focused pane closes", () => {
      store().splitFromSingle("t1", "t2", "right");
      store().splitLeafPane(leafIdForThread("t2"), "t3", "bottom");
      const focused = store().focusedLeafId!;
      store().closeLeaf(focused);
      const after = store();
      expect(after.focusedLeafId).not.toBeNull();
      expect(findLeafById(after.root!, after.focusedLeafId!)).not.toBeNull();
    });

    it("keeps focus when an unfocused pane closes", () => {
      store().splitFromSingle("t1", "t2", "right");
      store().splitLeafPane(leafIdForThread("t2"), "t3", "bottom");
      const focused = store().focusedLeafId;
      store().closeLeaf(leafIdForThread("t1"));
      expect(store().focusedLeafId).toBe(focused);
    });
  });

  describe("closePaneLeaf", () => {
    it("returns the surviving focused pane's thread key", () => {
      store().splitFromSingle("t1", "t2", "right");
      store().splitLeafPane(leafIdForThread("t2"), "t3", "bottom");
      expect(closePaneLeaf(leafIdForThread("t3"))).toBe(
        findLeafById(store().root!, store().focusedLeafId!)?.threadKey,
      );
    });

    it("returns the last survivor's key when the tree collapses", () => {
      store().splitFromSingle("t1", "t2", "right");
      expect(closePaneLeaf(leafIdForThread("t2"))).toBe("t1");
      expect(store().root).toBeNull();
    });

    it("returns null without a tree", () => {
      expect(closePaneLeaf("anything")).toBeNull();
    });
  });

  describe("migratePersistedPaneLayoutState", () => {
    const twoPaneTree = {
      type: "split",
      id: "s1",
      direction: "row",
      children: [
        { type: "leaf", id: "a", threadKey: "t1" },
        { type: "leaf", id: "b", threadKey: "t2" },
      ],
      sizes: [0.5, 0.5],
    };

    it("restores a valid tree and focus", () => {
      const result = migratePersistedPaneLayoutState({ root: twoPaneTree, focusedLeafId: "b" });
      expect(result.root?.type).toBe("split");
      expect(result.focusedLeafId).toBe("b");
    });

    it("drops lone-leaf trees back to the implicit single view", () => {
      const result = migratePersistedPaneLayoutState({
        root: { type: "leaf", id: "a", threadKey: "t1" },
        focusedLeafId: "a",
      });
      expect(result).toEqual({ root: null, focusedLeafId: null });
    });

    it("dedupes panes showing the same thread (freeze guard)", () => {
      const result = migratePersistedPaneLayoutState({
        root: {
          ...twoPaneTree,
          children: [
            { type: "leaf", id: "a", threadKey: "t1" },
            { type: "leaf", id: "b", threadKey: "t1" },
          ],
        },
        focusedLeafId: "b",
      });
      expect(result).toEqual({ root: null, focusedLeafId: null });
    });

    it("repoints an invalid focusedLeafId at the first pane", () => {
      const result = migratePersistedPaneLayoutState({ root: twoPaneTree, focusedLeafId: "gone" });
      expect(result.focusedLeafId).toBe("a");
    });

    it("returns empty state for garbage", () => {
      expect(migratePersistedPaneLayoutState("garbage")).toEqual({
        root: null,
        focusedLeafId: null,
      });
      expect(migratePersistedPaneLayoutState(null)).toEqual({ root: null, focusedLeafId: null });
    });
  });
});
