/**
 * Pure tree operations for the split-pane thread layout.
 *
 * The layout is a binary-or-wider tree: leaves show a thread, split nodes
 * arrange their children along one axis with fractional sizes that sum to 1.
 * All operations are immutable and return the input node unchanged when the
 * operation does not apply, so store updates can bail out cheaply.
 */

export type SplitDirection = "row" | "column";
export type DropEdge = "left" | "right" | "top" | "bottom";
export type DropRegion = DropEdge | "center";

export interface PaneLeafNode {
  readonly type: "leaf";
  readonly id: string;
  readonly threadKey: string;
}

export interface PaneSplitNode {
  readonly type: "split";
  readonly id: string;
  readonly direction: SplitDirection;
  readonly children: readonly PaneNode[];
  readonly sizes: readonly number[];
}

export type PaneNode = PaneLeafNode | PaneSplitNode;

/** Smallest fraction of a split a pane can be resized down to. */
export const MIN_PANE_FRACTION = 0.1;

/**
 * Minimum usable pane size in px along an axis: ChatView's composer and
 * header controls have no design below this. Resizing clamps to it and
 * edge drops that would create a smaller pane fall back to "center".
 */
export const MIN_PANE_SIZE_PX = 200;

export function createLeaf(id: string, threadKey: string): PaneLeafNode {
  return { type: "leaf", id, threadKey };
}

export function edgeDirection(edge: DropEdge): SplitDirection {
  return edge === "left" || edge === "right" ? "row" : "column";
}

/** Whether a drop on this edge places the new pane before the target. */
export function edgeInsertsBefore(edge: DropEdge): boolean {
  return edge === "left" || edge === "top";
}

export function collectLeaves(node: PaneNode): PaneLeafNode[] {
  if (node.type === "leaf") {
    return [node];
  }
  return node.children.flatMap(collectLeaves);
}

export function findLeafByThreadKey(node: PaneNode, threadKey: string): PaneLeafNode | null {
  return collectLeaves(node).find((leaf) => leaf.threadKey === threadKey) ?? null;
}

/**
 * Drop duplicate-thread leaves (keeping the first). Two panes must never
 * show the same thread: ChatView state is keyed by thread, so duplicate
 * instances fight over shared stores.
 */
export function dedupeThreadLeaves(root: PaneNode): PaneNode | null {
  const seen = new Set<string>();
  let current: PaneNode | null = root;
  for (const leaf of collectLeaves(root)) {
    if (seen.has(leaf.threadKey)) {
      if (current !== null) {
        current = removeLeaf(current, leaf.id);
      }
    } else {
      seen.add(leaf.threadKey);
    }
  }
  return current;
}

export function findLeafById(node: PaneNode, leafId: string): PaneLeafNode | null {
  if (node.type === "leaf") {
    return node.id === leafId ? node : null;
  }
  for (const child of node.children) {
    const found = findLeafById(child, leafId);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Sizes for `count` children: normalized to sum to 1, falling back to even. */
export function normalizeSizes(sizes: readonly number[], count: number): number[] {
  if (count <= 0) {
    return [];
  }
  const usable = sizes.length === count && sizes.every((size) => Number.isFinite(size) && size > 0);
  if (!usable) {
    return Array.from({ length: count }, () => 1 / count);
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return sizes.map((size) => size / total);
}

export function createSplitForEdge(
  id: string,
  target: PaneNode,
  added: PaneNode,
  edge: DropEdge,
): PaneSplitNode {
  return {
    type: "split",
    id,
    direction: edgeDirection(edge),
    children: edgeInsertsBefore(edge) ? [added, target] : [target, added],
    sizes: [0.5, 0.5],
  };
}

/**
 * Split the target leaf along the given edge, placing `added` next to it.
 * When the leaf's parent split already runs along the same axis the new pane
 * is inserted as a sibling (taking half the target's size) instead of nesting
 * another split. Returns null when the target leaf is not in the tree.
 */
export function splitLeaf(
  root: PaneNode,
  targetLeafId: string,
  edge: DropEdge,
  added: PaneNode,
  createSplitId: () => string,
): PaneNode | null {
  const direction = edgeDirection(edge);
  const before = edgeInsertsBefore(edge);

  const visit = (node: PaneNode): PaneNode | null => {
    if (node.type === "leaf") {
      return node.id === targetLeafId
        ? createSplitForEdge(createSplitId(), node, added, edge)
        : null;
    }
    for (let index = 0; index < node.children.length; index++) {
      const child = node.children[index];
      if (child === undefined) {
        continue;
      }
      if (child.type === "leaf" && child.id === targetLeafId && node.direction === direction) {
        const sizes = normalizeSizes(node.sizes, node.children.length);
        const half = (sizes[index] ?? 0) / 2;
        const nextChildren = [...node.children];
        const nextSizes = [...sizes];
        nextSizes[index] = half;
        const insertAt = before ? index : index + 1;
        nextChildren.splice(insertAt, 0, added);
        nextSizes.splice(insertAt, 0, half);
        return { ...node, children: nextChildren, sizes: nextSizes };
      }
      const replaced = visit(child);
      if (replaced) {
        const nextChildren = [...node.children];
        nextChildren[index] = replaced;
        return { ...node, children: nextChildren };
      }
    }
    return null;
  };

  return visit(root);
}

export function replaceLeafThread(root: PaneNode, leafId: string, threadKey: string): PaneNode {
  if (root.type === "leaf") {
    if (root.id !== leafId || root.threadKey === threadKey) {
      return root;
    }
    return { ...root, threadKey };
  }
  let changed = false;
  const children = root.children.map((child) => {
    const next = replaceLeafThread(child, leafId, threadKey);
    if (next !== child) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...root, children } : root;
}

/**
 * Remove a leaf. Splits left with a single child collapse into that child,
 * and a collapsed child running along its parent's axis is inlined so the
 * tree never accumulates redundant same-direction nesting. Returns null when
 * the last leaf was removed.
 */
export function removeLeaf(root: PaneNode, leafId: string): PaneNode | null {
  if (root.type === "leaf") {
    return root.id === leafId ? null : root;
  }
  const normalized = normalizeSizes(root.sizes, root.children.length);
  let changed = false;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, index) => {
    const next = removeLeaf(child, leafId);
    if (next === null) {
      changed = true;
      return;
    }
    if (next !== child) {
      changed = true;
    }
    children.push(next);
    sizes.push(normalized[index] ?? 0);
  });
  if (!changed) {
    return root;
  }
  const survivor = children[0];
  if (survivor === undefined) {
    return null;
  }
  if (children.length === 1) {
    return survivor;
  }
  const flatChildren: PaneNode[] = [];
  const flatSizes: number[] = [];
  children.forEach((child, index) => {
    if (child.type === "split" && child.direction === root.direction) {
      const childSizes = normalizeSizes(child.sizes, child.children.length);
      child.children.forEach((grandchild, childIndex) => {
        flatChildren.push(grandchild);
        flatSizes.push((sizes[index] ?? 0) * (childSizes[childIndex] ?? 0));
      });
      return;
    }
    flatChildren.push(child);
    flatSizes.push(sizes[index] ?? 0);
  });
  return {
    ...root,
    children: flatChildren,
    sizes: normalizeSizes(flatSizes, flatChildren.length),
  };
}

export function setSplitSizesInTree(
  root: PaneNode,
  splitId: string,
  sizes: readonly number[],
): PaneNode {
  if (root.type === "leaf") {
    return root;
  }
  if (root.id === splitId) {
    return { ...root, sizes: normalizeSizes(sizes, root.children.length) };
  }
  let changed = false;
  const children = root.children.map((child) => {
    const next = setSplitSizesInTree(child, splitId, sizes);
    if (next !== child) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...root, children } : root;
}

/**
 * New sizes after dragging the divider between children `index` and
 * `index + 1` by `deltaFraction` of the container. The pair's combined size
 * is preserved and each side is kept at least MIN_PANE_FRACTION wide.
 */
export function resizeSplitPair(
  sizes: readonly number[],
  count: number,
  index: number,
  deltaFraction: number,
  minFraction: number = MIN_PANE_FRACTION,
): number[] {
  const normalized = normalizeSizes(sizes, count);
  const current = normalized[index];
  const neighbor = normalized[index + 1];
  if (current === undefined || neighbor === undefined || !Number.isFinite(deltaFraction)) {
    return normalized;
  }
  const pairTotal = current + neighbor;
  const min = Math.min(
    Number.isFinite(minFraction) ? minFraction : MIN_PANE_FRACTION,
    pairTotal / 2,
  );
  const first = Math.max(min, Math.min(pairTotal - min, current + deltaFraction));
  const next = [...normalized];
  next[index] = first;
  next[index + 1] = pairTotal - first;
  return next;
}

/**
 * Drop region for a pointer at (x, y) inside a drop target of the given
 * size: a generous center zone, otherwise the nearest edge. Edges along an
 * axis where splitting would produce panes under MIN_PANE_SIZE_PX are
 * disqualified and fall back to the next candidate (or "center").
 */
export function resolveDropRegion(input: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): DropRegion {
  const { x, y, width, height } = input;
  if (width <= 0 || height <= 0) {
    return "center";
  }
  const fractionX = x / width;
  const fractionY = y / height;
  if (fractionX >= 0.3 && fractionX <= 0.7 && fractionY >= 0.3 && fractionY <= 0.7) {
    return "center";
  }
  const rowAllowed = width >= MIN_PANE_SIZE_PX * 2;
  const columnAllowed = height >= MIN_PANE_SIZE_PX * 2;
  const candidates: ReadonlyArray<readonly [DropRegion, number]> = [
    ...(rowAllowed
      ? ([
          ["left", fractionX],
          ["right", 1 - fractionX],
        ] as const)
      : []),
    ...(columnAllowed
      ? ([
          ["top", fractionY],
          ["bottom", 1 - fractionY],
        ] as const)
      : []),
  ];
  const closest = candidates.reduce((best, entry) => (entry[1] < best[1] ? entry : best), [
    "center",
    Number.POSITIVE_INFINITY,
  ] as readonly [DropRegion, number]);
  return closest[0];
}

/**
 * Validate an untrusted (persisted) value into a PaneNode. Invalid children
 * are dropped; splits reduced to a single child collapse into it.
 */
export function sanitizePaneNode(value: unknown): PaneNode | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const node = value as Record<string, unknown>;
  if (node.type === "leaf") {
    if (typeof node.id !== "string" || typeof node.threadKey !== "string") {
      return null;
    }
    return createLeaf(node.id, node.threadKey);
  }
  if (node.type !== "split" || typeof node.id !== "string") {
    return null;
  }
  if (node.direction !== "row" && node.direction !== "column") {
    return null;
  }
  if (!Array.isArray(node.children)) {
    return null;
  }
  const children = node.children
    .map(sanitizePaneNode)
    .filter((child): child is PaneNode => child !== null);
  const onlyChild = children[0];
  if (onlyChild === undefined) {
    return null;
  }
  if (children.length === 1) {
    return onlyChild;
  }
  const rawSizes = Array.isArray(node.sizes)
    ? node.sizes.filter((size): size is number => typeof size === "number")
    : [];
  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    children,
    sizes: normalizeSizes(rawSizes, children.length),
  };
}
