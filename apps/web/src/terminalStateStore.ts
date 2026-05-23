/**
 * Single Zustand store for terminal UI state keyed by scoped thread identity.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { parseScopedThreadKey, scopedThreadKey } from "@zrode/client-runtime";
import { type ScopedThreadRef, type TerminalEvent } from "@zrode/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import {
  buildThreadTerminalLayout,
  findThreadTerminalLayoutSiblingGroupId,
  normalizeThreadTerminalLayout,
  removeThreadTerminalLayoutLeaf,
  splitThreadTerminalLayoutLeaf,
  threadTerminalLayoutEqual,
  threadTerminalLayoutGroupIds,
  threadTerminalLayoutHasSplit,
  updateThreadTerminalLayoutSplitRatio,
} from "./lib/threadTerminalLayout";
import { terminalRunningSubprocessFromEvent } from "./terminalActivity";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalDropZone,
  type ThreadTerminalGroup,
  type ThreadTerminalLayoutNode,
  type ThreadTerminalSplitLayout,
} from "./types";

interface ThreadTerminalState {
  entryPoint: "chat" | "terminal";
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  terminalLayout: ThreadTerminalLayoutNode;
  terminalPanesVisible: boolean;
  terminalGroupSplitLayout: ThreadTerminalSplitLayout;
}

export interface ThreadTerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export interface TerminalEventEntry {
  id: number;
  event: TerminalEvent;
}

const TERMINAL_STATE_STORAGE_KEY = "zrode:terminal-state:v1";
const EMPTY_TERMINAL_EVENT_ENTRIES: ReadonlyArray<TerminalEventEntry> = [];
const MAX_TERMINAL_EVENT_BUFFER = 200;
const normalizedThreadTerminalStateCache = new WeakMap<ThreadTerminalState, ThreadTerminalState>();

interface PersistedTerminalStateStoreState {
  terminalStateByThreadKey?: Record<string, ThreadTerminalState>;
}

function migrateLegacyInternalSplitGroups(state: ThreadTerminalState): ThreadTerminalState {
  const input = state as Partial<ThreadTerminalState>;
  if (!input.terminalPanesVisible && (input.terminalGroups ?? []).length > 1) {
    const terminalIds = dedupeTerminalOrder(
      (input.terminalGroups ?? []).flatMap((group) => group.terminalIds),
    );
    const groupId =
      input.terminalGroups?.[0]?.id.trim() ||
      fallbackGroupId(terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    return {
      ...state,
      terminalGroups: [
        {
          id: groupId,
          terminalIds,
          ...(input.activeTerminalId && terminalIds.includes(input.activeTerminalId)
            ? { activeTerminalId: input.activeTerminalId }
            : {}),
        },
      ],
      activeTerminalGroupId: groupId,
      terminalLayout: { type: "leaf", groupId },
    };
  }

  if (
    !input.terminalPanesVisible ||
    (input.terminalLayout && threadTerminalLayoutHasSplit(input.terminalLayout))
  ) {
    return state;
  }

  const usedGroupIds = new Set<string>();
  const terminalGroups = (input.terminalGroups ?? []).flatMap((group) => {
    const terminalIds = dedupeTerminalOrder(group.terminalIds);
    if (terminalIds.length <= 1) {
      const groupId = assignUniqueGroupId(
        group.id.trim().length > 0 ? group.id.trim() : fallbackGroupId(terminalIds[0] ?? ""),
        usedGroupIds,
      );
      return [{ ...group, id: groupId, terminalIds }];
    }

    return terminalIds.map((terminalId, index) => {
      const groupId = assignUniqueGroupId(
        index === 0 && group.id.trim().length > 0 ? group.id.trim() : fallbackGroupId(terminalId),
        usedGroupIds,
      );
      return { id: groupId, terminalIds: [terminalId] };
    });
  });

  return {
    ...state,
    terminalGroups,
    terminalLayout: buildThreadTerminalLayout(
      terminalGroups.map((group) => group.id),
      normalizeTerminalGroupSplitLayout(input.terminalGroupSplitLayout),
    ),
  };
}

export function migratePersistedTerminalStateStoreState(
  persistedState: unknown,
  version: number,
): PersistedTerminalStateStoreState {
  if (version <= 4 && persistedState && typeof persistedState === "object") {
    const candidate = persistedState as PersistedTerminalStateStoreState;
    const nextTerminalStateByThreadKey = Object.fromEntries(
      Object.entries(candidate.terminalStateByThreadKey ?? {}).flatMap(([threadKey, state]) =>
        parseScopedThreadKey(threadKey)
          ? [[threadKey, normalizeThreadTerminalState(migrateLegacyInternalSplitGroups(state))]]
          : [],
      ),
    );
    return { terminalStateByThreadKey: nextTerminalStateByThreadKey };
  }
  return { terminalStateByThreadKey: {} };
}

function createTerminalStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function findGroupByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): ThreadTerminalGroup | null {
  return terminalGroups.find((group) => group.terminalIds.includes(terminalId)) ?? null;
}

function dedupeTerminalOrder(terminalIds: readonly string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function sanitizeRecentTerminalIds(
  recentTerminalIds: readonly string[] | undefined,
  terminalIds: readonly string[],
): string[] {
  if (!recentTerminalIds || recentTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return dedupeTerminalOrder(recentTerminalIds).filter((terminalId) =>
    validTerminalIdSet.has(terminalId),
  );
}

function pushRecentTerminalId(
  recentTerminalIds: readonly string[] | undefined,
  terminalId: string,
): string[] {
  return [...(recentTerminalIds ?? []).filter((id) => id !== terminalId), terminalId];
}

function pickNeighborTerminalId(terminalIds: readonly string[], terminalId: string): string | null {
  const index = terminalIds.indexOf(terminalId);
  if (index === -1) return terminalIds[0] ?? null;
  return (
    terminalIds[Math.min(index, terminalIds.length - 1)] ??
    terminalIds[index - 1] ??
    terminalIds[0] ??
    null
  );
}

function pickNextActiveTerminal(
  terminalIdsBeforeRemoval: readonly string[],
  recentTerminalIds: readonly string[] | undefined,
  removedTerminalId: string,
): string | null {
  const remainingTerminalIds = terminalIdsBeforeRemoval.filter((id) => id !== removedTerminalId);
  if (remainingTerminalIds.length === 0) return null;
  const remainingTerminalIdSet = new Set(remainingTerminalIds);
  const recentCandidate = (recentTerminalIds ?? [])
    .toReversed()
    .find(
      (terminalId) => terminalId !== removedTerminalId && remainingTerminalIdSet.has(terminalId),
    );
  return recentCandidate ?? pickNeighborTerminalId(remainingTerminalIds, removedTerminalId);
}

function lastRecentTerminalId(
  recentTerminalIds: readonly string[] | undefined,
  terminalIds: readonly string[],
): string | null {
  if (!recentTerminalIds || recentTerminalIds.length === 0) return null;
  const terminalIdSet = new Set(terminalIds);
  for (let index = recentTerminalIds.length - 1; index >= 0; index -= 1) {
    const terminalId = recentTerminalIds[index];
    if (terminalId && terminalIdSet.has(terminalId)) {
      return terminalId;
    }
  }
  return null;
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return dedupeTerminalOrder(terminalIds);
}

function normalizeTerminalSplitLayout(
  splitLayout: ThreadTerminalGroup["splitLayout"],
): ThreadTerminalGroup["splitLayout"] {
  return splitLayout === "rows" ? "rows" : undefined;
}

function terminalGroupSplitLayout(group: ThreadTerminalGroup): ThreadTerminalSplitLayout {
  return normalizeTerminalSplitLayout(group.splitLayout) ?? "columns";
}

function splitLayoutFromDropZone(zone: ThreadTerminalDropZone): ThreadTerminalSplitLayout | null {
  if (zone === "left" || zone === "right") return "columns";
  if (zone === "up" || zone === "down") return "rows";
  return null;
}

function dropZoneFromSplitLayout(
  splitLayout: ThreadTerminalSplitLayout,
): Exclude<ThreadTerminalDropZone, "center"> {
  return splitLayout === "rows" ? "down" : "right";
}

function insertAfterTargetForDropZone(zone: ThreadTerminalDropZone): boolean {
  return zone === "center" || zone === "right" || zone === "down";
}

function normalizeTerminalGroupSplitLayout(
  splitLayout: ThreadTerminalState["terminalGroupSplitLayout"] | undefined,
): ThreadTerminalSplitLayout {
  return splitLayout === "rows" ? "rows" : "columns";
}

function terminalGroupsHaveVisiblePanes(terminalLayout: ThreadTerminalLayoutNode): boolean {
  return threadTerminalLayoutHasSplit(terminalLayout);
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    const splitLayout = normalizeTerminalSplitLayout(group.splitLayout);
    const recentTerminalIds = sanitizeRecentTerminalIds(group.recentTerminalIds, groupTerminalIds);
    const activeTerminalId =
      group.activeTerminalId && groupTerminalIds.includes(group.activeTerminalId)
        ? group.activeTerminalId
        : (recentTerminalIds.at(-1) ?? groupTerminalIds[0] ?? null);
    const nextRecentTerminalIds = activeTerminalId
      ? pushRecentTerminalId(recentTerminalIds, activeTerminalId)
      : recentTerminalIds;
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
      ...(activeTerminalId && groupTerminalIds.length > 1 ? { activeTerminalId } : {}),
      ...(nextRecentTerminalIds.length > 1 ? { recentTerminalIds: nextRecentTerminalIds } : {}),
      ...(splitLayout ? { splitLayout } : {}),
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
      activeTerminalId: terminalId,
    });
  }

  if (nextGroups.length === 0) {
    return [
      {
        id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      },
    ];
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
    if ((leftGroup.activeTerminalId ?? null) !== (rightGroup.activeTerminalId ?? null)) {
      return false;
    }
    if (!arraysEqual(leftGroup.recentTerminalIds ?? [], rightGroup.recentTerminalIds ?? [])) {
      return false;
    }
    if (terminalGroupSplitLayout(leftGroup) !== terminalGroupSplitLayout(rightGroup)) return false;
  }
  return true;
}

function threadTerminalStateEqual(left: ThreadTerminalState, right: ThreadTerminalState): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.entryPoint === right.entryPoint &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    left.terminalPanesVisible === right.terminalPanesVisible &&
    left.terminalGroupSplitLayout === right.terminalGroupSplitLayout &&
    Boolean(left.terminalLayout) &&
    Boolean(right.terminalLayout) &&
    threadTerminalLayoutEqual(left.terminalLayout, right.terminalLayout) &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  entryPoint: "chat",
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
  terminalGroups: [
    {
      id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ],
  activeTerminalGroupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  terminalLayout: { type: "leaf" as const, groupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID) },
  terminalPanesVisible: false,
  terminalGroupSplitLayout: "columns",
});

function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
    terminalLayout: copyTerminalLayout(DEFAULT_THREAD_TERMINAL_STATE.terminalLayout),
  };
}

function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const cached = normalizedThreadTerminalStateCache.get(state);
  if (cached) return cached;

  const input = state as Partial<ThreadTerminalState>;
  const terminalIds = normalizeTerminalIds(input.terminalIds ?? []);
  let terminalGroups = normalizeTerminalGroups(input.terminalGroups ?? [], terminalIds);
  const terminalLayout = normalizeThreadTerminalLayout(
    input.terminalLayout,
    terminalGroups.map((group) => group.id),
    normalizeTerminalGroupSplitLayout(input.terminalGroupSplitLayout),
  );
  const groupOrder = new Map(
    threadTerminalLayoutGroupIds(terminalLayout).map((groupId, index) => [groupId, index]),
  );
  terminalGroups = terminalGroups.toSorted(
    (left, right) =>
      (groupOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (groupOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const nextTerminalIds = normalizeTerminalIds(
    terminalGroups.flatMap((group) => group.terminalIds),
  );
  const runningTerminalIds = normalizeRunningTerminalIds(
    input.runningTerminalIds ?? [],
    nextTerminalIds,
  );
  const activeGroupIdFromState =
    input.activeTerminalGroupId &&
    terminalGroups.some((group) => group.id === input.activeTerminalGroupId)
      ? input.activeTerminalGroupId
      : null;
  const activeGroupFromState =
    (activeGroupIdFromState
      ? terminalGroups.find((group) => group.id === activeGroupIdFromState)
      : null) ?? null;
  const activeTerminalIdFromState =
    input.activeTerminalId && nextTerminalIds.includes(input.activeTerminalId)
      ? input.activeTerminalId
      : null;
  const activeTerminalGroupId =
    (activeTerminalIdFromState
      ? findGroupByTerminalId(terminalGroups, activeTerminalIdFromState)?.id
      : null) ??
    activeGroupIdFromState ??
    terminalGroups[0]?.id ??
    fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID);
  const activeGroup =
    terminalGroups.find((group) => group.id === activeTerminalGroupId) ??
    activeGroupFromState ??
    terminalGroups[0] ??
    null;
  const activeTerminalId =
    activeTerminalIdFromState && activeGroup?.terminalIds.includes(activeTerminalIdFromState)
      ? activeTerminalIdFromState
      : activeGroup?.activeTerminalId &&
          activeGroup.terminalIds.includes(activeGroup.activeTerminalId)
        ? activeGroup.activeTerminalId
        : (lastRecentTerminalId(activeGroup?.recentTerminalIds, activeGroup?.terminalIds ?? []) ??
          activeGroup?.terminalIds[0] ??
          nextTerminalIds[0] ??
          DEFAULT_THREAD_TERMINAL_ID);
  terminalGroups = terminalGroups.map((group) => {
    const groupActiveTerminalId =
      group.id === activeTerminalGroupId && group.terminalIds.includes(activeTerminalId)
        ? activeTerminalId
        : group.activeTerminalId && group.terminalIds.includes(group.activeTerminalId)
          ? group.activeTerminalId
          : (lastRecentTerminalId(group.recentTerminalIds, group.terminalIds) ??
            group.terminalIds[0] ??
            null);
    const recentTerminalIds = groupActiveTerminalId
      ? pushRecentTerminalId(
          sanitizeRecentTerminalIds(group.recentTerminalIds, group.terminalIds),
          groupActiveTerminalId,
        )
      : sanitizeRecentTerminalIds(group.recentTerminalIds, group.terminalIds);
    const splitLayout = normalizeTerminalSplitLayout(group.splitLayout);
    return {
      id: group.id,
      terminalIds: group.terminalIds,
      ...(groupActiveTerminalId && group.terminalIds.length > 1
        ? { activeTerminalId: groupActiveTerminalId }
        : {}),
      ...(recentTerminalIds.length > 1 ? { recentTerminalIds } : {}),
      ...(splitLayout ? { splitLayout } : {}),
    };
  });

  const normalized: ThreadTerminalState = {
    entryPoint: state.entryPoint === "terminal" ? "terminal" : "chat",
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId,
    terminalLayout,
    terminalPanesVisible:
      Boolean(input.terminalPanesVisible) && terminalGroupsHaveVisiblePanes(terminalLayout),
    terminalGroupSplitLayout: normalizeTerminalGroupSplitLayout(input.terminalGroupSplitLayout),
  };
  const result = threadTerminalStateEqual(state, normalized) ? state : normalized;
  normalizedThreadTerminalStateCache.set(state, result);
  return result;
}

function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalThreadKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

function terminalEventBufferKey(threadRef: ScopedThreadRef, terminalId: string): string {
  return `${terminalThreadKey(threadRef)}\u0000${terminalId}`;
}

function copyTerminalLayout(layout: ThreadTerminalLayoutNode): ThreadTerminalLayoutNode {
  if (layout.type === "leaf") {
    return { type: "leaf", groupId: layout.groupId };
  }
  return {
    type: "split",
    direction: layout.direction,
    first: copyTerminalLayout(layout.first),
    second: copyTerminalLayout(layout.second),
    ...(layout.ratio !== undefined ? { ratio: layout.ratio } : {}),
  };
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => {
    const splitLayout = normalizeTerminalSplitLayout(group.splitLayout);
    return {
      id: group.id,
      terminalIds: [...group.terminalIds],
      ...(group.activeTerminalId ? { activeTerminalId: group.activeTerminalId } : {}),
      ...(group.recentTerminalIds ? { recentTerminalIds: [...group.recentTerminalIds] } : {}),
      ...(splitLayout ? { splitLayout } : {}),
    };
  });
}

function activeTerminalIdForGroup(group: ThreadTerminalGroup): string | null {
  if (group.activeTerminalId && group.terminalIds.includes(group.activeTerminalId)) {
    return group.activeTerminalId;
  }
  return (
    lastRecentTerminalId(group.recentTerminalIds, group.terminalIds) ?? group.terminalIds[0] ?? null
  );
}

function withGroupActiveTerminal(
  group: ThreadTerminalGroup,
  terminalId: string | null,
): ThreadTerminalGroup {
  const activeTerminalId =
    terminalId && group.terminalIds.includes(terminalId)
      ? terminalId
      : activeTerminalIdForGroup(group);
  const sanitizedRecentTerminalIds = sanitizeRecentTerminalIds(
    group.recentTerminalIds,
    group.terminalIds,
  );
  const seededRecentTerminalIds =
    group.activeTerminalId &&
    group.activeTerminalId !== activeTerminalId &&
    group.terminalIds.includes(group.activeTerminalId)
      ? pushRecentTerminalId(sanitizedRecentTerminalIds, group.activeTerminalId)
      : sanitizedRecentTerminalIds;
  const recentTerminalIds = activeTerminalId
    ? pushRecentTerminalId(seededRecentTerminalIds, activeTerminalId)
    : seededRecentTerminalIds;
  const splitLayout = normalizeTerminalSplitLayout(group.splitLayout);
  return {
    id: group.id,
    terminalIds: [...group.terminalIds],
    ...(activeTerminalId && group.terminalIds.length > 1 ? { activeTerminalId } : {}),
    ...(recentTerminalIds.length > 1 ? { recentTerminalIds } : {}),
    ...(splitLayout ? { splitLayout } : {}),
  };
}

function createTerminalGroup(groupId: string, terminalIds: string[]): ThreadTerminalGroup {
  return withGroupActiveTerminal({ id: groupId, terminalIds }, terminalIds.at(-1) ?? null);
}

function appendTerminalEventEntry(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  nextTerminalEventId: number,
  threadRef: ScopedThreadRef,
  event: TerminalEvent,
) {
  const key = terminalEventBufferKey(threadRef, event.terminalId);
  const currentEntries = terminalEventEntriesByKey[key] ?? EMPTY_TERMINAL_EVENT_ENTRIES;
  const nextEntry: TerminalEventEntry = {
    id: nextTerminalEventId,
    event,
  };
  const nextEntries =
    currentEntries.length >= MAX_TERMINAL_EVENT_BUFFER
      ? [...currentEntries.slice(1), nextEntry]
      : [...currentEntries, nextEntry];

  return {
    terminalEventEntriesByKey: {
      ...terminalEventEntriesByKey,
      [key]: nextEntries,
    },
    nextTerminalEventId: nextTerminalEventId + 1,
  };
}

function launchContextFromStartEvent(
  event: Extract<TerminalEvent, { type: "started" | "restarted" }>,
): ThreadTerminalLaunchContext {
  return {
    cwd: event.snapshot.cwd,
    worktreePath: event.snapshot.worktreePath,
  };
}

function newThreadTerminal(
  state: ThreadTerminalState,
  terminalId: string,
  targetGroupId?: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  if (normalized.terminalIds.includes(terminalId)) {
    return setThreadActiveTerminal(normalized, terminalId);
  }

  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  let targetGroupIndex =
    targetGroupId !== undefined
      ? terminalGroups.findIndex((group) => group.id === targetGroupId)
      : -1;
  if (targetGroupIndex < 0) {
    targetGroupIndex = terminalGroups.findIndex(
      (group) => group.id === normalized.activeTerminalGroupId,
    );
  }
  if (targetGroupIndex < 0) {
    targetGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (targetGroupIndex < 0) {
    return normalized;
  }

  const targetGroup = terminalGroups[targetGroupIndex];
  if (!targetGroup || targetGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP) {
    return normalized;
  }

  const anchorTerminalId =
    targetGroup.id === normalized.activeTerminalGroupId
      ? normalized.activeTerminalId
      : activeTerminalIdForGroup(targetGroup);
  const insertIndex = anchorTerminalId
    ? targetGroup.terminalIds.indexOf(anchorTerminalId) + 1
    : targetGroup.terminalIds.length;
  targetGroup.terminalIds.splice(Math.max(0, insertIndex), 0, terminalId);
  terminalGroups[targetGroupIndex] = withGroupActiveTerminal(targetGroup, terminalId);

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds: terminalGroups.flatMap((group) => group.terminalIds),
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: targetGroup.id,
    terminalLayout: normalized.terminalLayout,
  });
}

function splitThreadTerminal(
  state: ThreadTerminalState,
  terminalId: string,
  splitLayout: ThreadTerminalSplitLayout = "columns",
  targetGroupId?: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  let sourceGroupIndex =
    targetGroupId !== undefined
      ? terminalGroups.findIndex((group) => group.id === targetGroupId)
      : -1;
  if (sourceGroupIndex < 0) {
    sourceGroupIndex = terminalGroups.findIndex(
      (group) => group.id === normalized.activeTerminalGroupId,
    );
  }
  if (sourceGroupIndex < 0) {
    sourceGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  const sourceGroup = terminalGroups[sourceGroupIndex];
  if (!sourceGroup) {
    return normalized;
  }

  const splitZone = dropZoneFromSplitLayout(splitLayout);
  const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
  const isSingleTabSplit = sourceGroup.terminalIds.length <= 1;
  const terminalIdToMove = isSingleTabSplit
    ? terminalId
    : sourceGroup.terminalIds.includes(terminalId)
      ? terminalId
      : sourceGroup.terminalIds.includes(normalized.activeTerminalId)
        ? normalized.activeTerminalId
        : (activeTerminalIdForGroup(sourceGroup) ?? sourceGroup.terminalIds[0] ?? terminalId);

  if (!isSingleTabSplit && !sourceGroup.terminalIds.includes(terminalIdToMove)) {
    return normalized;
  }

  const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalIdToMove), usedGroupIds);
  let terminalLayout = splitThreadTerminalLayoutLeaf(
    normalized.terminalLayout,
    sourceGroup.id,
    nextGroupId,
    splitZone,
  );

  if (isSingleTabSplit) {
    if (normalized.terminalIds.includes(terminalIdToMove)) {
      return normalized;
    }
    terminalGroups.push(createTerminalGroup(nextGroupId, [terminalIdToMove]));
  } else {
    const sourceTerminalIdsBeforeMove = [...sourceGroup.terminalIds];
    sourceGroup.terminalIds = sourceGroup.terminalIds.filter((id) => id !== terminalIdToMove);
    terminalGroups[sourceGroupIndex] = withGroupActiveTerminal(
      sourceGroup,
      pickNextActiveTerminal(
        sourceTerminalIdsBeforeMove,
        sourceGroup.recentTerminalIds,
        terminalIdToMove,
      ),
    );
    terminalGroups.push(createTerminalGroup(nextGroupId, [terminalIdToMove]));
  }

  terminalLayout = normalizeThreadTerminalLayout(
    terminalLayout,
    terminalGroups.map((group) => group.id),
    splitLayout,
  );

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds: terminalGroups.flatMap((group) => group.terminalIds),
    activeTerminalId: terminalIdToMove,
    terminalGroups,
    activeTerminalGroupId: nextGroupId,
    terminalLayout,
    terminalPanesVisible: true,
    terminalGroupSplitLayout: splitLayout,
  });
}

function moveThreadTerminalToGroup(
  state: ThreadTerminalState,
  terminalId: string,
  targetGroupId: string,
  index?: number,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const sourceGroupBeforeMove = findGroupByTerminalId(normalized.terminalGroups, terminalId);
  const targetGroupBeforeMove = normalized.terminalGroups.find(
    (group) => group.id === targetGroupId,
  );
  if (!sourceGroupBeforeMove || !targetGroupBeforeMove) {
    return normalized;
  }

  if (
    sourceGroupBeforeMove.id !== targetGroupBeforeMove.id &&
    targetGroupBeforeMove.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  let terminalLayout = normalized.terminalLayout;
  let terminalGroups = copyTerminalGroups(normalized.terminalGroups).flatMap((group) => {
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    if (terminalIds.length === 0) return [];
    return [
      withGroupActiveTerminal(
        { ...group, terminalIds },
        group.activeTerminalId === terminalId
          ? pickNextActiveTerminal(group.terminalIds, group.recentTerminalIds, terminalId)
          : (group.activeTerminalId ?? null),
      ),
    ];
  });

  const sourceGroupEmptied = !terminalGroups.some((group) => group.id === sourceGroupBeforeMove.id);
  if (sourceGroupEmptied) {
    terminalLayout =
      removeThreadTerminalLayoutLeaf(terminalLayout, sourceGroupBeforeMove.id) ??
      buildThreadTerminalLayout([targetGroupId], normalized.terminalGroupSplitLayout);
  }

  const targetGroupIndex = terminalGroups.findIndex((group) => group.id === targetGroupId);
  const targetGroup = terminalGroups[targetGroupIndex];
  if (!targetGroup) {
    return normalized;
  }

  const insertIndex = Math.max(
    0,
    Math.min(index ?? targetGroup.terminalIds.length, targetGroup.terminalIds.length),
  );
  targetGroup.terminalIds.splice(insertIndex, 0, terminalId);
  terminalGroups[targetGroupIndex] = withGroupActiveTerminal(targetGroup, terminalId);
  terminalGroups = terminalGroups.filter((group) => group.terminalIds.length > 0);

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds: terminalGroups.flatMap((group) => group.terminalIds),
    terminalGroups,
    activeTerminalId: terminalId,
    activeTerminalGroupId: targetGroup.id,
    terminalLayout,
    terminalPanesVisible: normalized.terminalPanesVisible,
  });
}

function setThreadTerminalOpen(state: ThreadTerminalState, open: boolean): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function openThreadTerminalPage(state: ThreadTerminalState): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.entryPoint === "terminal" && normalized.terminalOpen) {
    return normalized;
  }
  return {
    ...normalized,
    entryPoint: "terminal",
    terminalOpen: true,
  };
}

function setThreadTerminalHeight(state: ThreadTerminalState, height: number): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function setThreadActiveTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  const terminalGroups = normalized.terminalGroups.map((group) =>
    group.id === activeTerminalGroupId ? withGroupActiveTerminal(group, terminalId) : group,
  );
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId &&
    terminalGroupsEqual(normalized.terminalGroups, terminalGroups)
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
    terminalGroups,
  };
}

function moveThreadTerminal(
  state: ThreadTerminalState,
  terminalId: string,
  targetTerminalId: string,
  zone: ThreadTerminalDropZone,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (
    !normalized.terminalIds.includes(terminalId) ||
    !normalized.terminalIds.includes(targetTerminalId)
  ) {
    return normalized;
  }
  if (terminalId === targetTerminalId) {
    return setThreadActiveTerminal(normalized, terminalId);
  }

  const targetGroupBeforeMove = normalized.terminalGroups.find((group) =>
    group.terminalIds.includes(targetTerminalId),
  );
  if (!targetGroupBeforeMove) {
    return normalized;
  }
  const sourceGroupBeforeMove = normalized.terminalGroups.find((group) =>
    group.terminalIds.includes(terminalId),
  );
  const isCrossGroupMove = sourceGroupBeforeMove?.id !== targetGroupBeforeMove.id;
  if (
    zone === "center" &&
    isCrossGroupMove &&
    targetGroupBeforeMove.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }
  if (
    zone !== "center" &&
    sourceGroupBeforeMove?.id === targetGroupBeforeMove.id &&
    sourceGroupBeforeMove.terminalIds.length <= 1
  ) {
    return normalized;
  }

  const terminalGroups = copyTerminalGroups(normalized.terminalGroups).flatMap((group) => {
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    if (terminalIds.length === 0) return [];
    return [
      withGroupActiveTerminal(
        { ...group, terminalIds },
        group.activeTerminalId === terminalId
          ? pickNextActiveTerminal(group.terminalIds, group.recentTerminalIds, terminalId)
          : (group.activeTerminalId ?? null),
      ),
    ];
  });
  const sourceGroupEmptied = !terminalGroups.some(
    (group) => group.id === sourceGroupBeforeMove?.id,
  );
  const targetGroupIndex = terminalGroups.findIndex((group) =>
    group.terminalIds.includes(targetTerminalId),
  );
  if (targetGroupIndex < 0) {
    return normalized;
  }

  const targetGroup = terminalGroups[targetGroupIndex]!;
  const targetIndex = targetGroup.terminalIds.indexOf(targetTerminalId);
  const splitLayout = splitLayoutFromDropZone(zone);
  let terminalLayout = normalized.terminalLayout;

  if (sourceGroupEmptied && sourceGroupBeforeMove) {
    terminalLayout =
      removeThreadTerminalLayoutLeaf(terminalLayout, sourceGroupBeforeMove.id) ??
      buildThreadTerminalLayout([targetGroupBeforeMove.id], normalized.terminalGroupSplitLayout);
  }

  if (splitLayout !== null && zone !== "center") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalLayout = splitThreadTerminalLayoutLeaf(
      terminalLayout,
      targetGroupBeforeMove.id,
      nextGroupId,
      zone,
    );
    terminalGroups.push(createTerminalGroup(nextGroupId, [terminalId]));

    return normalizeThreadTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds: terminalGroups.flatMap((group) => group.terminalIds),
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
      terminalLayout,
      terminalPanesVisible: true,
      terminalGroupSplitLayout: splitLayout,
    });
  }

  const insertIndex = targetIndex + (insertAfterTargetForDropZone(zone) ? 1 : 0);
  targetGroup.terminalIds.splice(insertIndex, 0, terminalId);
  terminalGroups[targetGroupIndex] = withGroupActiveTerminal(targetGroup, terminalId);

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds: terminalGroups.flatMap((group) => group.terminalIds),
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: targetGroup.id,
    terminalLayout,
    terminalPanesVisible: normalized.terminalPanesVisible,
  });
}

function closeThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    const defaultState = createDefaultThreadTerminalState();
    return normalized.entryPoint === "terminal"
      ? { ...defaultState, entryPoint: "terminal", terminalOpen: true }
      : defaultState;
  }

  const sourceGroupBeforeClose = findGroupByTerminalId(normalized.terminalGroups, terminalId);
  const sourceGroupSiblingId = sourceGroupBeforeClose
    ? findThreadTerminalLayoutSiblingGroupId(normalized.terminalLayout, sourceGroupBeforeClose.id)
    : null;
  const terminalGroups = normalized.terminalGroups.flatMap((group) => {
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    if (terminalIds.length === 0) return [];
    return [
      withGroupActiveTerminal(
        { ...group, terminalIds },
        group.activeTerminalId === terminalId || normalized.activeTerminalId === terminalId
          ? pickNextActiveTerminal(group.terminalIds, group.recentTerminalIds, terminalId)
          : (group.activeTerminalId ?? null),
      ),
    ];
  });
  const removedGroupIds = normalized.terminalGroups
    .filter((group) => !terminalGroups.some((nextGroup) => nextGroup.id === group.id))
    .map((group) => group.id);
  const terminalLayout = removedGroupIds.reduce<ThreadTerminalLayoutNode | null>(
    (layout, groupId) => (layout ? removeThreadTerminalLayoutLeaf(layout, groupId) : null),
    normalized.terminalLayout,
  );
  const nextTerminalLayout =
    terminalLayout ??
    buildThreadTerminalLayout(
      terminalGroups.map((group) => group.id),
      normalized.terminalGroupSplitLayout,
    );

  const preferredActiveGroupId =
    normalized.activeTerminalId !== terminalId
      ? findGroupByTerminalId(terminalGroups, normalized.activeTerminalId)?.id
      : sourceGroupBeforeClose
        ? (terminalGroups.find((group) => group.id === sourceGroupBeforeClose.id)?.id ??
          sourceGroupSiblingId)
        : null;
  const nextActiveGroup =
    (preferredActiveGroupId
      ? terminalGroups.find((group) => group.id === preferredActiveGroupId)
      : null) ??
    terminalGroups.find((group) => group.id === normalized.activeTerminalGroupId) ??
    terminalGroups[0] ??
    null;
  const nextActiveTerminalId =
    normalized.activeTerminalId !== terminalId &&
    remainingTerminalIds.includes(normalized.activeTerminalId)
      ? normalized.activeTerminalId
      : ((nextActiveGroup
          ? activeTerminalIdForGroup(nextActiveGroup)
          : (remainingTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID)) ?? DEFAULT_THREAD_TERMINAL_ID);
  const nextActiveTerminalGroupId =
    nextActiveGroup?.id ??
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalState({
    entryPoint: normalized.entryPoint,
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
    terminalLayout: nextTerminalLayout,
    terminalPanesVisible:
      normalized.terminalPanesVisible && terminalGroupsHaveVisiblePanes(nextTerminalLayout),
    terminalGroupSplitLayout: normalized.terminalGroupSplitLayout,
  });
}

function setThreadTerminalActivity(
  state: ThreadTerminalState,
  terminalId: string,
  hasRunningSubprocess: boolean,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  if (hasRunningSubprocess === alreadyRunning) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  return { ...normalized, runningTerminalIds: [...runningTerminalIds] };
}

function setThreadTerminalLayoutRatio(
  state: ThreadTerminalState,
  nodePath: string,
  ratio: number,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const terminalLayout = updateThreadTerminalLayoutSplitRatio(
    normalized.terminalLayout,
    nodePath,
    ratio,
  );
  if (threadTerminalLayoutEqual(normalized.terminalLayout, terminalLayout)) {
    return normalized;
  }
  return normalizeThreadTerminalState({ ...normalized, terminalLayout });
}

export function selectThreadTerminalState(
  terminalStateByThreadKey: Record<string, ThreadTerminalState>,
  threadRef: ScopedThreadRef | null | undefined,
): ThreadTerminalState {
  if (!threadRef || threadRef.threadId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  const terminalState = terminalStateByThreadKey[terminalThreadKey(threadRef)];
  return terminalState
    ? normalizeThreadTerminalState(terminalState)
    : getDefaultThreadTerminalState();
}

function updateTerminalStateByThreadKey(
  terminalStateByThreadKey: Record<string, ThreadTerminalState>,
  threadRef: ScopedThreadRef,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<string, ThreadTerminalState> {
  if (threadRef.threadId.length === 0) {
    return terminalStateByThreadKey;
  }

  const threadKey = terminalThreadKey(threadRef);
  const current = selectThreadTerminalState(terminalStateByThreadKey, threadRef);
  const next = updater(current);
  if (next === current) {
    return terminalStateByThreadKey;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByThreadKey[threadKey] === undefined) {
      return terminalStateByThreadKey;
    }
    const { [threadKey]: _removed, ...rest } = terminalStateByThreadKey;
    return rest;
  }

  return {
    ...terminalStateByThreadKey,
    [threadKey]: next,
  };
}

export function selectTerminalEventEntries(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  threadRef: ScopedThreadRef | null | undefined,
  terminalId: string,
): ReadonlyArray<TerminalEventEntry> {
  if (!threadRef || threadRef.threadId.length === 0 || terminalId.trim().length === 0) {
    return EMPTY_TERMINAL_EVENT_ENTRIES;
  }
  return (
    terminalEventEntriesByKey[terminalEventBufferKey(threadRef, terminalId)] ??
    EMPTY_TERMINAL_EVENT_ENTRIES
  );
}

interface TerminalStateStoreState {
  terminalStateByThreadKey: Record<string, ThreadTerminalState>;
  terminalLaunchContextByThreadKey: Record<string, ThreadTerminalLaunchContext>;
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>;
  nextTerminalEventId: number;
  setTerminalOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
  setTerminalHeight: (threadRef: ScopedThreadRef, height: number) => void;
  openTerminalThreadPage: (threadRef: ScopedThreadRef) => void;
  splitTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    splitLayout?: ThreadTerminalSplitLayout,
    targetGroupId?: string,
  ) => void;
  newTerminal: (threadRef: ScopedThreadRef, terminalId: string, targetGroupId?: string) => void;
  ensureTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  moveTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    targetTerminalId: string,
    zone: ThreadTerminalDropZone,
  ) => void;
  moveTerminalToGroup: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    targetGroupId: string,
    index?: number,
  ) => void;
  closeTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  setTerminalLaunchContext: (
    threadRef: ScopedThreadRef,
    context: ThreadTerminalLaunchContext,
  ) => void;
  clearTerminalLaunchContext: (threadRef: ScopedThreadRef) => void;
  setTerminalActivity: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  setTerminalLayoutRatio: (threadRef: ScopedThreadRef, nodePath: string, ratio: number) => void;
  recordTerminalEvent: (threadRef: ScopedThreadRef, event: TerminalEvent) => void;
  applyTerminalEvent: (threadRef: ScopedThreadRef, event: TerminalEvent) => void;
  clearTerminalState: (threadRef: ScopedThreadRef) => void;
  removeTerminalState: (threadRef: ScopedThreadRef) => void;
  removeOrphanedTerminalStates: (activeThreadKeys: Set<string>) => void;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadRef: ScopedThreadRef,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
            state.terminalStateByThreadKey,
            threadRef,
            updater,
          );
          if (nextTerminalStateByThreadKey === state.terminalStateByThreadKey) {
            return state;
          }
          return {
            terminalStateByThreadKey: nextTerminalStateByThreadKey,
          };
        });
      };

      return {
        terminalStateByThreadKey: {},
        terminalLaunchContextByThreadKey: {},
        terminalEventEntriesByKey: {},
        nextTerminalEventId: 1,
        setTerminalOpen: (threadRef, open) =>
          updateTerminal(threadRef, (state) => setThreadTerminalOpen(state, open)),
        setTerminalHeight: (threadRef, height) =>
          updateTerminal(threadRef, (state) => setThreadTerminalHeight(state, height)),
        openTerminalThreadPage: (threadRef) =>
          updateTerminal(threadRef, (state) => openThreadTerminalPage(state)),
        splitTerminal: (threadRef, terminalId, splitLayout, targetGroupId) =>
          updateTerminal(threadRef, (state) =>
            splitThreadTerminal(state, terminalId, splitLayout, targetGroupId),
          ),
        newTerminal: (threadRef, terminalId, targetGroupId) =>
          updateTerminal(threadRef, (state) => newThreadTerminal(state, terminalId, targetGroupId)),
        ensureTerminal: (threadRef, terminalId, options) =>
          updateTerminal(threadRef, (state) => {
            let nextState = state;
            if (!state.terminalIds.includes(terminalId)) {
              nextState = newThreadTerminal(nextState, terminalId);
            }
            if (options?.active === false) {
              nextState = {
                ...nextState,
                activeTerminalId: state.activeTerminalId,
                activeTerminalGroupId: state.activeTerminalGroupId,
                terminalGroups: nextState.terminalGroups.map((group) =>
                  group.id === state.activeTerminalGroupId
                    ? withGroupActiveTerminal(group, state.activeTerminalId)
                    : group,
                ),
              };
            }
            if (options?.active ?? true) {
              nextState = setThreadActiveTerminal(nextState, terminalId);
            }
            if (options?.open) {
              nextState = setThreadTerminalOpen(nextState, true);
            }
            return normalizeThreadTerminalState(nextState);
          }),
        setActiveTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => setThreadActiveTerminal(state, terminalId)),
        moveTerminal: (threadRef, terminalId, targetTerminalId, zone) =>
          updateTerminal(threadRef, (state) =>
            moveThreadTerminal(state, terminalId, targetTerminalId, zone),
          ),
        moveTerminalToGroup: (threadRef, terminalId, targetGroupId, index) =>
          updateTerminal(threadRef, (state) =>
            moveThreadTerminalToGroup(state, terminalId, targetGroupId, index),
          ),
        closeTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => closeThreadTerminal(state, terminalId)),
        setTerminalLaunchContext: (threadRef, context) =>
          set((state) => ({
            terminalLaunchContextByThreadKey: {
              ...state.terminalLaunchContextByThreadKey,
              [terminalThreadKey(threadRef)]: context,
            },
          })),
        clearTerminalLaunchContext: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            if (!state.terminalLaunchContextByThreadKey[threadKey]) {
              return state;
            }
            const { [threadKey]: _removed, ...rest } = state.terminalLaunchContextByThreadKey;
            return { terminalLaunchContextByThreadKey: rest };
          }),
        setTerminalActivity: (threadRef, terminalId, hasRunningSubprocess) =>
          updateTerminal(threadRef, (state) =>
            setThreadTerminalActivity(state, terminalId, hasRunningSubprocess),
          ),
        setTerminalLayoutRatio: (threadRef, nodePath, ratio) =>
          updateTerminal(threadRef, (state) =>
            setThreadTerminalLayoutRatio(state, nodePath, ratio),
          ),
        recordTerminalEvent: (threadRef, event) =>
          set((state) =>
            appendTerminalEventEntry(
              state.terminalEventEntriesByKey,
              state.nextTerminalEventId,
              threadRef,
              event,
            ),
          ),
        applyTerminalEvent: (threadRef, event) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            let nextTerminalStateByThreadKey = state.terminalStateByThreadKey;
            let nextTerminalLaunchContextByThreadKey = state.terminalLaunchContextByThreadKey;

            if (event.type === "started" || event.type === "restarted") {
              nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
                nextTerminalStateByThreadKey,
                threadRef,
                (current) => {
                  let nextState = current;
                  if (!current.terminalIds.includes(event.terminalId)) {
                    nextState = newThreadTerminal(nextState, event.terminalId);
                  }
                  nextState = setThreadActiveTerminal(nextState, event.terminalId);
                  nextState = setThreadTerminalOpen(nextState, true);
                  return normalizeThreadTerminalState(nextState);
                },
              );
              nextTerminalLaunchContextByThreadKey = {
                ...nextTerminalLaunchContextByThreadKey,
                [threadKey]: launchContextFromStartEvent(event),
              };
            }

            const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
            if (hasRunningSubprocess !== null) {
              nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
                nextTerminalStateByThreadKey,
                threadRef,
                (current) =>
                  setThreadTerminalActivity(current, event.terminalId, hasRunningSubprocess),
              );
            }

            const nextEventState = appendTerminalEventEntry(
              state.terminalEventEntriesByKey,
              state.nextTerminalEventId,
              threadRef,
              event,
            );

            return {
              terminalStateByThreadKey: nextTerminalStateByThreadKey,
              terminalLaunchContextByThreadKey: nextTerminalLaunchContextByThreadKey,
              ...nextEventState,
            };
          }),
        clearTerminalState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
              state.terminalStateByThreadKey,
              threadRef,
              () => createDefaultThreadTerminalState(),
            );
            const hadLaunchContext =
              state.terminalLaunchContextByThreadKey[threadKey] !== undefined;
            const { [threadKey]: _removed, ...remainingLaunchContexts } =
              state.terminalLaunchContextByThreadKey;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadKey}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              nextTerminalStateByThreadKey === state.terminalStateByThreadKey &&
              !hadLaunchContext &&
              !removedEventEntries
            ) {
              return state;
            }
            return {
              terminalStateByThreadKey: nextTerminalStateByThreadKey,
              terminalLaunchContextByThreadKey: remainingLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeTerminalState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const hadTerminalState = state.terminalStateByThreadKey[threadKey] !== undefined;
            const hadLaunchContext =
              state.terminalLaunchContextByThreadKey[threadKey] !== undefined;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadKey}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (!hadTerminalState && !hadLaunchContext && !removedEventEntries) {
              return state;
            }
            const nextTerminalStateByThreadKey = { ...state.terminalStateByThreadKey };
            delete nextTerminalStateByThreadKey[threadKey];
            const nextLaunchContexts = { ...state.terminalLaunchContextByThreadKey };
            delete nextLaunchContexts[threadKey];
            return {
              terminalStateByThreadKey: nextTerminalStateByThreadKey,
              terminalLaunchContextByThreadKey: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeOrphanedTerminalStates: (activeThreadKeys) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByThreadKey).filter(
              (key) => !activeThreadKeys.has(key),
            );
            const orphanedLaunchContextIds = Object.keys(
              state.terminalLaunchContextByThreadKey,
            ).filter((key) => !activeThreadKeys.has(key));
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              const [threadKey] = key.split("\u0000");
              if (threadKey && !activeThreadKeys.has(threadKey)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              orphanedIds.length === 0 &&
              orphanedLaunchContextIds.length === 0 &&
              !removedEventEntries
            ) {
              return state;
            }
            const next = { ...state.terminalStateByThreadKey };
            for (const id of orphanedIds) {
              delete next[id];
            }
            const nextLaunchContexts = { ...state.terminalLaunchContextByThreadKey };
            for (const id of orphanedLaunchContextIds) {
              delete nextLaunchContexts[id];
            }
            return {
              terminalStateByThreadKey: next,
              terminalLaunchContextByThreadKey: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 5,
      storage: createJSONStorage(createTerminalStateStorage),
      migrate: migratePersistedTerminalStateStoreState,
      partialize: (state) => ({
        terminalStateByThreadKey: state.terminalStateByThreadKey,
      }),
    },
  ),
);
