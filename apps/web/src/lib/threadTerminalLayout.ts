import {
  DEFAULT_THREAD_TERMINAL_ID,
  type ThreadTerminalDropZone,
  type ThreadTerminalLayoutNode,
  type ThreadTerminalSplitLayout,
} from "../types";

const MIN_TERMINAL_SPLIT_RATIO = 0.15;
const MAX_TERMINAL_SPLIT_RATIO = 0.85;

function fallbackTerminalGroupId(): string {
  return `group-${DEFAULT_THREAD_TERMINAL_ID}`;
}

function normalizeGroupIds(groupIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const groupId of groupIds) {
    const trimmed = groupId.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : [fallbackTerminalGroupId()];
}

export function clampThreadTerminalSplitRatio(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(MAX_TERMINAL_SPLIT_RATIO, Math.max(MIN_TERMINAL_SPLIT_RATIO, value ?? 0.5));
}

export function buildThreadTerminalLayout(
  groupIds: readonly string[],
  direction: ThreadTerminalSplitLayout,
): ThreadTerminalLayoutNode {
  const normalizedGroupIds = normalizeGroupIds(groupIds);
  const build = (remainingGroupIds: readonly string[]): ThreadTerminalLayoutNode => {
    const [firstGroupId, ...restGroupIds] = remainingGroupIds;
    if (!firstGroupId || restGroupIds.length === 0) {
      return { type: "leaf", groupId: firstGroupId ?? fallbackTerminalGroupId() };
    }
    return {
      type: "split",
      direction,
      first: { type: "leaf", groupId: firstGroupId },
      second: build(restGroupIds),
      ratio: 1 / remainingGroupIds.length,
    };
  };
  return build(normalizedGroupIds);
}

export function threadTerminalLayoutGroupIds(layout: ThreadTerminalLayoutNode): string[] {
  if (layout.type === "leaf") return [layout.groupId];
  return [
    ...threadTerminalLayoutGroupIds(layout.first),
    ...threadTerminalLayoutGroupIds(layout.second),
  ];
}

export function threadTerminalLayoutHasSplit(layout: ThreadTerminalLayoutNode): boolean {
  if (layout.type === "split") return true;
  return false;
}

export function threadTerminalLayoutEqual(
  left: ThreadTerminalLayoutNode,
  right: ThreadTerminalLayoutNode,
): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "leaf" && right.type === "leaf") {
    return left.groupId === right.groupId;
  }
  if (left.type !== "split" || right.type !== "split") return false;
  return (
    left.direction === right.direction &&
    clampThreadTerminalSplitRatio(left.ratio) === clampThreadTerminalSplitRatio(right.ratio) &&
    threadTerminalLayoutEqual(left.first, right.first) &&
    threadTerminalLayoutEqual(left.second, right.second)
  );
}

export function threadTerminalLayoutKey(layout: ThreadTerminalLayoutNode): string {
  if (layout.type === "leaf") return `leaf:${layout.groupId}`;
  return `split:${layout.direction}:${clampThreadTerminalSplitRatio(layout.ratio)}(${threadTerminalLayoutKey(
    layout.first,
  )},${threadTerminalLayoutKey(layout.second)})`;
}

function firstThreadTerminalLayoutLeafGroupId(layout: ThreadTerminalLayoutNode): string {
  return layout.type === "leaf"
    ? layout.groupId
    : firstThreadTerminalLayoutLeafGroupId(layout.first);
}

export function findThreadTerminalLayoutSiblingGroupId(
  layout: ThreadTerminalLayoutNode,
  targetGroupId: string,
): string | null {
  if (layout.type === "leaf") return null;
  if (layout.first.type === "leaf" && layout.first.groupId === targetGroupId) {
    return layout.second.type === "leaf"
      ? layout.second.groupId
      : firstThreadTerminalLayoutLeafGroupId(layout.second);
  }
  if (layout.second.type === "leaf" && layout.second.groupId === targetGroupId) {
    return layout.first.type === "leaf"
      ? layout.first.groupId
      : firstThreadTerminalLayoutLeafGroupId(layout.first);
  }
  return (
    findThreadTerminalLayoutSiblingGroupId(layout.first, targetGroupId) ??
    findThreadTerminalLayoutSiblingGroupId(layout.second, targetGroupId)
  );
}

function normalizeNode(
  node: ThreadTerminalLayoutNode | undefined,
  validGroupIds: ReadonlySet<string>,
  assignedGroupIds: Set<string>,
): ThreadTerminalLayoutNode | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "leaf") {
    const groupId = typeof node.groupId === "string" ? node.groupId.trim() : "";
    if (groupId.length === 0 || !validGroupIds.has(groupId) || assignedGroupIds.has(groupId)) {
      return null;
    }
    assignedGroupIds.add(groupId);
    return { type: "leaf", groupId };
  }
  if (node.type !== "split") return null;

  const first = normalizeNode(node.first, validGroupIds, assignedGroupIds);
  const second = normalizeNode(node.second, validGroupIds, assignedGroupIds);
  if (!first) return second;
  if (!second) return first;

  return {
    type: "split",
    direction: node.direction === "rows" ? "rows" : "columns",
    first,
    second,
    ratio: clampThreadTerminalSplitRatio(node.ratio),
  };
}

export function appendThreadTerminalGroupToLayout(
  layout: ThreadTerminalLayoutNode,
  groupId: string,
  direction: ThreadTerminalSplitLayout,
): ThreadTerminalLayoutNode {
  const existingLeafCount = threadTerminalLayoutGroupIds(layout).length;
  return {
    type: "split",
    direction,
    first: layout,
    second: { type: "leaf", groupId },
    ratio: existingLeafCount / (existingLeafCount + 1),
  };
}

export function normalizeThreadTerminalLayout(
  layout: ThreadTerminalLayoutNode | undefined,
  groupIds: readonly string[],
  fallbackDirection: ThreadTerminalSplitLayout,
): ThreadTerminalLayoutNode {
  const normalizedGroupIds = normalizeGroupIds(groupIds);
  const validGroupIds = new Set(normalizedGroupIds);
  const assignedGroupIds = new Set<string>();
  let normalized = normalizeNode(layout, validGroupIds, assignedGroupIds);

  if (!normalized) {
    return buildThreadTerminalLayout(normalizedGroupIds, fallbackDirection);
  }

  for (const groupId of normalizedGroupIds) {
    if (assignedGroupIds.has(groupId)) continue;
    normalized = appendThreadTerminalGroupToLayout(normalized, groupId, fallbackDirection);
  }

  return normalized;
}

function buildSplitNode(
  existingGroupId: string,
  newGroupId: string,
  direction: ThreadTerminalSplitLayout,
  placement: "first" | "second",
): ThreadTerminalLayoutNode {
  const existingLeaf: ThreadTerminalLayoutNode = { type: "leaf", groupId: existingGroupId };
  const newLeaf: ThreadTerminalLayoutNode = { type: "leaf", groupId: newGroupId };
  return {
    type: "split",
    direction,
    first: placement === "first" ? newLeaf : existingLeaf,
    second: placement === "second" ? newLeaf : existingLeaf,
    ratio: 0.5,
  };
}

export function replaceThreadTerminalLayoutLeaf(
  layout: ThreadTerminalLayoutNode,
  targetGroupId: string,
  replacement: ThreadTerminalLayoutNode,
): ThreadTerminalLayoutNode {
  if (layout.type === "leaf") {
    return layout.groupId === targetGroupId ? replacement : layout;
  }
  return {
    ...layout,
    first: replaceThreadTerminalLayoutLeaf(layout.first, targetGroupId, replacement),
    second: replaceThreadTerminalLayoutLeaf(layout.second, targetGroupId, replacement),
  };
}

export function removeThreadTerminalLayoutLeaf(
  layout: ThreadTerminalLayoutNode,
  groupId: string,
): ThreadTerminalLayoutNode | null {
  if (layout.type === "leaf") {
    return layout.groupId === groupId ? null : layout;
  }

  const first = removeThreadTerminalLayoutLeaf(layout.first, groupId);
  const second = removeThreadTerminalLayoutLeaf(layout.second, groupId);
  if (!first) return second;
  if (!second) return first;
  if (first === layout.first && second === layout.second) return layout;
  return { ...layout, first, second };
}

export function splitThreadTerminalLayoutLeaf(
  layout: ThreadTerminalLayoutNode,
  targetGroupId: string,
  newGroupId: string,
  zone: Exclude<ThreadTerminalDropZone, "center">,
): ThreadTerminalLayoutNode {
  const direction = zone === "left" || zone === "right" ? "columns" : "rows";
  const placement = zone === "left" || zone === "up" ? "first" : "second";
  const replacement = buildSplitNode(targetGroupId, newGroupId, direction, placement);
  return replaceThreadTerminalLayoutLeaf(layout, targetGroupId, replacement);
}

export function updateThreadTerminalLayoutSplitRatio(
  layout: ThreadTerminalLayoutNode,
  nodePath: string,
  ratio: number,
): ThreadTerminalLayoutNode {
  const path = nodePath.length > 0 ? nodePath.split(".") : [];
  const visit = (
    node: ThreadTerminalLayoutNode,
    remainingPath: readonly string[],
  ): ThreadTerminalLayoutNode => {
    if (node.type !== "split") return node;
    const [segment, ...rest] = remainingPath;
    if (!segment) {
      return { ...node, ratio: clampThreadTerminalSplitRatio(ratio) };
    }
    if (segment === "first") {
      return { ...node, first: visit(node.first, rest) };
    }
    if (segment === "second") {
      return { ...node, second: visit(node.second, rest) };
    }
    return node;
  };
  return visit(layout, path);
}

export function resolveThreadTerminalDropZone(
  rect: Pick<DOMRect, "height" | "width">,
  point: { x: number; y: number },
): ThreadTerminalDropZone {
  const edgeWidthThreshold = rect.width * 0.1;
  const edgeHeightThreshold = rect.height * 0.1;
  const splitWidthThreshold = rect.width / 3;

  if (
    point.x > edgeWidthThreshold &&
    point.x < rect.width - edgeWidthThreshold &&
    point.y > edgeHeightThreshold &&
    point.y < rect.height - edgeHeightThreshold
  ) {
    return "center";
  }
  if (point.x < splitWidthThreshold) return "left";
  if (point.x > splitWidthThreshold * 2) return "right";
  return point.y < rect.height / 2 ? "up" : "down";
}
