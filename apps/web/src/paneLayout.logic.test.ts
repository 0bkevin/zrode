import { describe, expect, it } from "vite-plus/test";

import {
  collectLeaves,
  createLeaf,
  createSplitForEdge,
  dedupeThreadLeaves,
  findLeafById,
  findLeafByThreadKey,
  normalizeSizes,
  type PaneNode,
  type PaneSplitNode,
  removeLeaf,
  replaceLeafThread,
  resizeSplitPair,
  resolveDropRegion,
  sanitizePaneNode,
  setSplitSizesInTree,
  splitLeaf,
} from "./paneLayout.logic";

let idCounter = 0;
const nextId = () => `split-${idCounter++}`;

const leaf = (id: string, threadKey = `thread-${id}`) => createLeaf(id, threadKey);

describe("paneLayout.logic", () => {
  describe("createSplitForEdge", () => {
    it("places the new pane before the target for left/top edges", () => {
      const split = createSplitForEdge("s", leaf("a"), leaf("b"), "left");
      expect(split.direction).toBe("row");
      expect(split.children.map((child) => child.id)).toEqual(["b", "a"]);
      expect(split.sizes).toEqual([0.5, 0.5]);
    });

    it("places the new pane after the target for bottom edges with column direction", () => {
      const split = createSplitForEdge("s", leaf("a"), leaf("b"), "bottom");
      expect(split.direction).toBe("column");
      expect(split.children.map((child) => child.id)).toEqual(["a", "b"]);
    });
  });

  describe("splitLeaf", () => {
    it("wraps a root leaf in a new split", () => {
      const result = splitLeaf(leaf("a"), "a", "right", leaf("b"), nextId);
      expect(result?.type).toBe("split");
      const split = result as PaneSplitNode;
      expect(split.direction).toBe("row");
      expect(split.children.map((child) => child.id)).toEqual(["a", "b"]);
    });

    it("inserts as a sibling when the parent split runs the same direction", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      const result = splitLeaf(root, "a", "right", leaf("c"), nextId) as PaneSplitNode;
      expect(result.children.map((child) => child.id)).toEqual(["a", "c", "b"]);
      expect(result.sizes).toEqual([0.25, 0.25, 0.5]);
    });

    it("nests a new split when the drop direction differs from the parent", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      const result = splitLeaf(root, "a", "bottom", leaf("c"), nextId) as PaneSplitNode;
      expect(result.children).toHaveLength(2);
      const nested = result.children[0] as PaneSplitNode;
      expect(nested.type).toBe("split");
      expect(nested.direction).toBe("column");
      expect(nested.children.map((child) => child.id)).toEqual(["a", "c"]);
    });

    it("returns null when the target leaf does not exist", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      expect(splitLeaf(root, "missing", "left", leaf("c"), nextId)).toBeNull();
    });
  });

  describe("removeLeaf", () => {
    it("collapses a two-child split into the surviving child", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      const result = removeLeaf(root, "b");
      expect(result).toEqual(leaf("a"));
    });

    it("removes the last leaf entirely", () => {
      expect(removeLeaf(leaf("a"), "a")).toBeNull();
    });

    it("returns the same node when the leaf is not present", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      expect(removeLeaf(root, "missing")).toBe(root);
    });

    it("renormalizes remaining sizes", () => {
      const root: PaneSplitNode = {
        type: "split",
        id: "s",
        direction: "row",
        children: [leaf("a"), leaf("b"), leaf("c")],
        sizes: [0.5, 0.25, 0.25],
      };
      const result = removeLeaf(root, "a") as PaneSplitNode;
      expect(result.children.map((child) => child.id)).toEqual(["b", "c"]);
      expect(result.sizes).toEqual([0.5, 0.5]);
    });

    it("inlines a collapsed child that runs along the parent's axis", () => {
      // row[ a, column[ row[b, c], d ] ] — removing d collapses the column
      // into row[b, c], which must merge into the outer row.
      const inner = createSplitForEdge("inner", leaf("b"), leaf("c"), "right");
      const middle: PaneSplitNode = {
        type: "split",
        id: "middle",
        direction: "column",
        children: [inner, leaf("d")],
        sizes: [0.5, 0.5],
      };
      const root: PaneSplitNode = {
        type: "split",
        id: "root",
        direction: "row",
        children: [leaf("a"), middle],
        sizes: [0.5, 0.5],
      };
      const result = removeLeaf(root, "d") as PaneSplitNode;
      expect(result.direction).toBe("row");
      expect(result.children.map((child) => child.id)).toEqual(["a", "b", "c"]);
      expect(result.sizes).toEqual([0.5, 0.25, 0.25]);
    });
  });

  describe("replaceLeafThread", () => {
    it("swaps the thread key of the target leaf only", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      const result = replaceLeafThread(root, "b", "thread-z") as PaneSplitNode;
      expect(findLeafById(result, "b")?.threadKey).toBe("thread-z");
      expect(findLeafById(result, "a")?.threadKey).toBe("thread-a");
    });

    it("returns the same tree when nothing changes", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      expect(replaceLeafThread(root, "b", "thread-b")).toBe(root);
      expect(replaceLeafThread(root, "missing", "thread-z")).toBe(root);
    });
  });

  describe("setSplitSizesInTree", () => {
    it("normalizes and applies sizes to the target split", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      const result = setSplitSizesInTree(root, "s", [3, 1]) as PaneSplitNode;
      expect(result.sizes).toEqual([0.75, 0.25]);
    });

    it("falls back to even sizes for invalid input", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      const result = setSplitSizesInTree(root, "s", [Number.NaN, 1]) as PaneSplitNode;
      expect(result.sizes).toEqual([0.5, 0.5]);
    });
  });

  describe("resizeSplitPair", () => {
    it("moves size between the two panes around the divider", () => {
      const [first, second] = resizeSplitPair([0.5, 0.5], 2, 0, 0.2);
      expect(first).toBeCloseTo(0.7);
      expect(second).toBeCloseTo(0.3);
    });

    it("clamps to the minimum pane fraction", () => {
      const [first, second] = resizeSplitPair([0.5, 0.5], 2, 0, 0.9);
      expect(first).toBeCloseTo(0.9);
      expect(second).toBeCloseTo(0.1);
    });

    it("leaves other panes untouched", () => {
      const result = resizeSplitPair([0.25, 0.25, 0.5], 3, 0, 0.1);
      expect(result[2]).toBeCloseTo(0.5);
      expect((result[0] ?? 0) + (result[1] ?? 0)).toBeCloseTo(0.5);
    });

    it("returns normalized sizes for an out-of-range divider index", () => {
      expect(resizeSplitPair([0.5, 0.5], 2, 5, 0.1)).toEqual([0.5, 0.5]);
    });

    it("honors a caller-provided minimum fraction (absolute px minimums)", () => {
      const [first, second] = resizeSplitPair([0.5, 0.5], 2, 0, 0.9, 0.25);
      expect(first).toBeCloseTo(0.75);
      expect(second).toBeCloseTo(0.25);
    });
  });

  describe("normalizeSizes", () => {
    it("keeps proportions while scaling to sum 1", () => {
      expect(normalizeSizes([2, 2], 2)).toEqual([0.5, 0.5]);
    });

    it("falls back to even sizes on length mismatch", () => {
      expect(normalizeSizes([1], 2)).toEqual([0.5, 0.5]);
    });
  });

  describe("sanitizePaneNode", () => {
    it("round-trips a valid tree", () => {
      const inner = createSplitForEdge("inner", leaf("b"), leaf("c"), "bottom");
      const root: PaneNode = {
        type: "split",
        id: "root",
        direction: "row",
        children: [leaf("a"), inner],
        sizes: [0.4, 0.6],
      };
      expect(sanitizePaneNode(JSON.parse(JSON.stringify(root)))).toEqual(root);
    });

    it("drops invalid children and collapses single-child splits", () => {
      const result = sanitizePaneNode({
        type: "split",
        id: "root",
        direction: "row",
        children: [{ type: "leaf", id: "a", threadKey: "thread-a" }, { type: "bogus" }],
        sizes: [0.5, 0.5],
      });
      expect(result).toEqual(leaf("a"));
    });

    it("rejects non-tree values", () => {
      expect(sanitizePaneNode(null)).toBeNull();
      expect(sanitizePaneNode("nope")).toBeNull();
      expect(sanitizePaneNode({ type: "split", id: "s", direction: "diagonal" })).toBeNull();
    });

    it("repairs malformed sizes with an even distribution", () => {
      const result = sanitizePaneNode({
        type: "split",
        id: "root",
        direction: "column",
        children: [
          { type: "leaf", id: "a", threadKey: "thread-a" },
          { type: "leaf", id: "b", threadKey: "thread-b" },
        ],
        sizes: ["wide", null],
      }) as PaneSplitNode;
      expect(result.sizes).toEqual([0.5, 0.5]);
    });
  });

  describe("resolveDropRegion", () => {
    const size = { width: 1000, height: 800 };

    it("returns center for the middle zone", () => {
      expect(resolveDropRegion({ x: 500, y: 400, ...size })).toBe("center");
    });

    it("picks the nearest edge outside the center zone", () => {
      expect(resolveDropRegion({ x: 50, y: 400, ...size })).toBe("left");
      expect(resolveDropRegion({ x: 950, y: 400, ...size })).toBe("right");
      expect(resolveDropRegion({ x: 500, y: 30, ...size })).toBe("top");
      expect(resolveDropRegion({ x: 500, y: 780, ...size })).toBe("bottom");
    });

    it("disallows horizontal splits on panes too narrow to split", () => {
      expect(resolveDropRegion({ x: 10, y: 150, width: 300, height: 800 })).toBe("top");
    });

    it("falls back to center when the pane is too small to split at all", () => {
      expect(resolveDropRegion({ x: 10, y: 10, width: 300, height: 300 })).toBe("center");
    });

    it("returns center for degenerate sizes", () => {
      expect(resolveDropRegion({ x: 0, y: 0, width: 0, height: 0 })).toBe("center");
    });
  });

  describe("dedupeThreadLeaves", () => {
    it("keeps the first pane per thread and drops later duplicates", () => {
      const root: PaneSplitNode = {
        type: "split",
        id: "root",
        direction: "row",
        children: [leaf("a", "thread-1"), leaf("b", "thread-2"), leaf("c", "thread-1")],
        sizes: [0.4, 0.3, 0.3],
      };
      const result = dedupeThreadLeaves(root) as PaneSplitNode;
      expect(collectLeaves(result).map((entry) => entry.id)).toEqual(["a", "b"]);
    });

    it("collapses to the surviving leaf when every pane shows the same thread", () => {
      const root = createSplitForEdge("s", leaf("a", "thread-1"), leaf("b", "thread-1"), "right");
      expect(dedupeThreadLeaves(root)).toEqual(leaf("a", "thread-1"));
    });

    it("returns the same tree when there are no duplicates", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      expect(dedupeThreadLeaves(root)).toBe(root);
    });
  });

  describe("findLeafByThreadKey", () => {
    it("finds the pane showing a thread", () => {
      const root = createSplitForEdge("s", leaf("a"), leaf("b"), "right");
      expect(findLeafByThreadKey(root, "thread-b")?.id).toBe("b");
      expect(findLeafByThreadKey(root, "thread-missing")).toBeNull();
    });
  });

  describe("collectLeaves", () => {
    it("returns leaves in visual order", () => {
      const inner = createSplitForEdge("inner", leaf("b"), leaf("c"), "top");
      const root: PaneSplitNode = {
        type: "split",
        id: "root",
        direction: "row",
        children: [leaf("a"), inner],
        sizes: [0.5, 0.5],
      };
      expect(collectLeaves(root).map((entry) => entry.id)).toEqual(["a", "c", "b"]);
    });
  });
});
