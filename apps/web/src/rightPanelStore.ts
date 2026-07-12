/**
 * Thread-scoped right-panel surface state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state. Browser surfaces point at preview tab ids,
 * terminal surfaces point at terminal session ids, file surfaces point at
 * workspace paths, and diff/plan/files remain singleton surfaces.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const RIGHT_PANEL_KINDS = ["plan", "diff", "files", "file", "preview", "terminal"] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];
export const WORKSPACE_SIDEBAR_VIEWS = ["explorer", "search"] as const;
export type WorkspaceSidebarView = (typeof WORKSPACE_SIDEBAR_VIEWS)[number];

/** A one-based position whose column is measured in UTF-16 code units. */
export interface FileRevealPosition {
  readonly line: number;
  readonly column: number;
}

/**
 * A location to reveal in a file preview. Range ends are exclusive. Lines and
 * UTF-16 columns are one-based, matching the project-search protocol.
 */
export type FileRevealTarget =
  | { readonly kind: "line"; readonly line: number }
  | {
      readonly kind: "range";
      readonly start: FileRevealPosition;
      readonly end: FileRevealPosition;
    };

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | {
      id: `terminal:${string}`;
      kind: "terminal";
      resourceId: string;
      terminalIds: string[];
      activeTerminalId: string;
      splitDirection?: "horizontal" | "vertical";
    }
  | { id: "diff"; kind: "diff" }
  | { id: "files"; kind: "files" }
  | {
      id: `file:${string}`;
      kind: "file";
      relativePath: string;
      revealTarget: FileRevealTarget | null;
      revealRequestId: number;
    }
  | { id: "plan"; kind: "plan" };

export type RightPanelFileSurface = Extract<RightPanelSurface, { kind: "file" }>;

const RIGHT_PANEL_STORAGE_KEY = "zrode:right-panel-state:v2";
const RIGHT_PANEL_STORAGE_VERSION = 9;

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
  workspaceSidebarView: WorkspaceSidebarView;
  workspaceSidebarFocusRequestId: number;
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  open: (ref: ScopedThreadRef, kind: Exclude<RightPanelKind, "file" | "terminal">) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  openFile: (
    ref: ScopedThreadRef,
    relativePath: string,
    target?: number | FileRevealTarget | null,
  ) => void;
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  splitTerminal: (
    ref: ScopedThreadRef,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfaces: (ref: ScopedThreadRef, surfaceIds: readonly string[]) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  closeFileSurfaces: (ref: ScopedThreadRef, surfaceIds: readonly string[]) => void;
  closeAllFileSurfaces: (ref: ScopedThreadRef) => void;
  reconcileBrowserSurfaces: (ref: ScopedThreadRef, tabIds: readonly string[]) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  showWorkspaceExplorer: (ref: ScopedThreadRef) => void;
  showWorkspaceSearch: (ref: ScopedThreadRef) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (ref: ScopedThreadRef, kind: Exclude<RightPanelKind, "file" | "terminal">) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
  workspaceSidebarView: "explorer",
  workspaceSidebarFocusRequestId: 0,
};

const singletonSurface = (
  kind: Exclude<RightPanelKind, "file" | "preview" | "terminal">,
): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "plan":
      return { id: "plan", kind };
  }
};

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const fileSurface = (
  relativePath: string,
  revealTarget: FileRevealTarget | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealTarget,
  revealRequestId,
});

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  ...current,
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

function nextRequestId(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

function preferredWorkspaceSurface(
  current: ThreadRightPanelState,
): RightPanelFileSurface | Extract<RightPanelSurface, { kind: "files" }> | null {
  const active = current.surfaces.find((surface) => surface.id === current.activeSurfaceId);
  if (active?.kind === "file" || active?.kind === "files") return active;

  return (
    current.surfaces.findLast(
      (surface): surface is RightPanelFileSurface => surface.kind === "file",
    ) ??
    current.surfaces.find(
      (surface): surface is Extract<RightPanelSurface, { kind: "files" }> =>
        surface.kind === "files",
    ) ??
    null
  );
}

function showWorkspaceSidebar(
  current: ThreadRightPanelState,
  view: WorkspaceSidebarView,
): ThreadRightPanelState {
  const existing = preferredWorkspaceSurface(current);
  const surface = existing ?? singletonSurface("files");
  return {
    ...current,
    isOpen: true,
    activeSurfaceId: surface.id,
    surfaces: existing ? current.surfaces : [...current.surfaces, surface],
    workspaceSidebarView: view,
    workspaceSidebarFocusRequestId:
      view === "search"
        ? nextRequestId(current.workspaceSidebarFocusRequestId)
        : current.workspaceSidebarFocusRequestId,
  };
}

function closeFileSurfacesInThread(
  current: ThreadRightPanelState,
  requestedSurfaceIds: ReadonlySet<string> | null,
): ThreadRightPanelState {
  const fileSurfaces = selectOrderedFileSurfaces(current.surfaces);
  const closedFileSurfaces = fileSurfaces.filter(
    (surface) => requestedSurfaceIds === null || requestedSurfaceIds.has(surface.id),
  );
  if (closedFileSurfaces.length === 0) return current;

  const closedIds = new Set<string>(closedFileSurfaces.map((surface) => surface.id));
  const firstClosedSurfaceIndex = current.surfaces.findIndex((surface) =>
    closedIds.has(surface.id),
  );
  const remainingSurfaces = current.surfaces.filter((surface) => !closedIds.has(surface.id));
  const remainingFileSurfaces = selectOrderedFileSurfaces(remainingSurfaces);
  let nextSurfaces = remainingSurfaces;

  let explorerSurface = remainingSurfaces.find(
    (surface): surface is Extract<RightPanelSurface, { kind: "files" }> => surface.kind === "files",
  );
  if (remainingFileSurfaces.length === 0 && !explorerSurface) {
    explorerSurface = singletonSurface("files") as Extract<RightPanelSurface, { kind: "files" }>;
    const insertionIndex = Math.min(firstClosedSurfaceIndex, remainingSurfaces.length);
    nextSurfaces = [
      ...remainingSurfaces.slice(0, insertionIndex),
      explorerSurface,
      ...remainingSurfaces.slice(insertionIndex),
    ];
  }

  let activeSurfaceId = current.activeSurfaceId;
  if (activeSurfaceId !== null && closedIds.has(activeSurfaceId)) {
    const activeFileIndex = fileSurfaces.findIndex((surface) => surface.id === activeSurfaceId);
    const nextFile = fileSurfaces
      .slice(activeFileIndex + 1)
      .find((surface) => !closedIds.has(surface.id));
    const previousFile = fileSurfaces
      .slice(0, activeFileIndex)
      .toReversed()
      .find((surface) => !closedIds.has(surface.id));
    activeSurfaceId = nextFile?.id ?? previousFile?.id ?? explorerSurface?.id ?? null;
  }

  return {
    ...current,
    activeSurfaceId,
    surfaces: nextSurfaces,
  };
}

function closeSurfacesInThread(
  current: ThreadRightPanelState,
  requestedSurfaceIds: ReadonlySet<string>,
): ThreadRightPanelState {
  const closedIds = new Set<string>(
    current.surfaces
      .filter((surface) => requestedSurfaceIds.has(surface.id))
      .map((surface) => surface.id),
  );
  if (closedIds.size === 0) return current;

  const surfaces = current.surfaces.filter((surface) => !closedIds.has(surface.id));
  let activeSurfaceId = current.activeSurfaceId;
  if (activeSurfaceId !== null && closedIds.has(activeSurfaceId)) {
    const activeIndex = current.surfaces.findIndex((surface) => surface.id === activeSurfaceId);
    const nextSurface = current.surfaces
      .slice(activeIndex + 1)
      .find((surface) => !closedIds.has(surface.id));
    const previousSurface = current.surfaces
      .slice(0, activeIndex)
      .toReversed()
      .find((surface) => !closedIds.has(surface.id));
    activeSurfaceId = nextSurface?.id ?? previousSurface?.id ?? null;
  }

  return {
    ...current,
    isOpen: current.isOpen && surfaces.length > 0,
    activeSurfaceId,
    surfaces,
  };
}

const updateThread = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

function normalizeOneBasedCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.trunc(value)));
}

function normalizeFileRevealPosition(value: unknown): FileRevealPosition | null {
  if (!value || typeof value !== "object") return null;
  const position = value as { readonly line?: unknown; readonly column?: unknown };
  const line = normalizeOneBasedCoordinate(position.line);
  const column = normalizeOneBasedCoordinate(position.column);
  return line === null || column === null ? null : { line, column };
}

function compareFileRevealPositions(left: FileRevealPosition, right: FileRevealPosition): number {
  return left.line === right.line ? left.column - right.column : left.line - right.line;
}

/** Normalize untrusted or legacy reveal data into the canonical persisted shape. */
export function normalizeFileRevealTarget(value: unknown): FileRevealTarget | null {
  const legacyLine = normalizeOneBasedCoordinate(value);
  if (legacyLine !== null) return { kind: "line", line: legacyLine };
  if (!value || typeof value !== "object") return null;

  const target = value as {
    readonly kind?: unknown;
    readonly line?: unknown;
    readonly start?: unknown;
    readonly end?: unknown;
  };
  if (target.kind === "line") {
    const line = normalizeOneBasedCoordinate(target.line);
    return line === null ? null : { kind: "line", line };
  }
  if (target.kind !== "range") return null;

  const first = normalizeFileRevealPosition(target.start);
  const second = normalizeFileRevealPosition(target.end);
  if (first === null || second === null) return null;
  const [start, end] =
    compareFileRevealPositions(first, second) <= 0 ? [first, second] : [second, first];
  return { kind: "range", start, end };
}

export function migratePersistedRightPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadRightPanelState>;
} {
  if (!persistedState || typeof persistedState !== "object") {
    return { byThreadKey: {} };
  }
  const byThreadKey =
    "byThreadKey" in persistedState &&
    persistedState.byThreadKey &&
    typeof persistedState.byThreadKey === "object"
      ? Object.fromEntries(
          Object.entries(persistedState.byThreadKey as Record<string, ThreadRightPanelState>).map(
            ([threadKey, threadState]) => {
              const validThreadState =
                threadState && typeof threadState === "object" ? threadState : null;
              const surfaces = Array.isArray(validThreadState?.surfaces)
                ? validThreadState.surfaces.flatMap<RightPanelSurface>((surface) => {
                    if (!surface || typeof surface !== "object") return [];
                    if (surface.kind === "file") {
                      const persistedFileSurface = surface as RightPanelFileSurface & {
                        readonly revealLine?: unknown;
                        readonly revealTarget?: unknown;
                        readonly revealRequestId?: unknown;
                      };
                      const {
                        revealLine: legacyRevealLine,
                        revealTarget: persistedRevealTarget,
                        revealRequestId: persistedRevealRequestId,
                        ...baseSurface
                      } = persistedFileSurface;
                      const revealTarget = normalizeFileRevealTarget(
                        Object.hasOwn(persistedFileSurface, "revealTarget")
                          ? persistedRevealTarget
                          : legacyRevealLine,
                      );
                      const revealRequestId =
                        typeof persistedRevealRequestId === "number" &&
                        Number.isSafeInteger(persistedRevealRequestId) &&
                        persistedRevealRequestId >= 0
                          ? persistedRevealRequestId
                          : 0;
                      return [{ ...baseSurface, revealTarget, revealRequestId }];
                    }
                    if (surface.kind !== "terminal") return [surface];
                    if (
                      !("resourceId" in surface) ||
                      typeof surface.resourceId !== "string" ||
                      surface.id !== `terminal:${surface.resourceId}`
                    ) {
                      return [];
                    }
                    const terminalIds =
                      "terminalIds" in surface && Array.isArray(surface.terminalIds)
                        ? [
                            ...new Set(
                              surface.terminalIds.filter(
                                (terminalId): terminalId is string =>
                                  typeof terminalId === "string",
                              ),
                            ),
                          ]
                        : [surface.resourceId];
                    const activeTerminalId =
                      "activeTerminalId" in surface &&
                      typeof surface.activeTerminalId === "string" &&
                      terminalIds.includes(surface.activeTerminalId)
                        ? surface.activeTerminalId
                        : (terminalIds[0] ?? surface.resourceId);
                    return [
                      {
                        ...surface,
                        terminalIds: terminalIds.length > 0 ? terminalIds : [surface.resourceId],
                        activeTerminalId,
                      },
                    ];
                  })
                : [];
              const activeSurfaceId = surfaces.some(
                (surface) => surface.id === validThreadState?.activeSurfaceId,
              )
                ? (validThreadState?.activeSurfaceId ?? null)
                : null;
              const isOpen =
                typeof validThreadState?.isOpen === "boolean"
                  ? validThreadState.isOpen
                  : activeSurfaceId !== null;
              const workspaceSidebarView = WORKSPACE_SIDEBAR_VIEWS.includes(
                validThreadState?.workspaceSidebarView as WorkspaceSidebarView,
              )
                ? (validThreadState?.workspaceSidebarView as WorkspaceSidebarView)
                : "explorer";
              const workspaceSidebarFocusRequestId =
                typeof validThreadState?.workspaceSidebarFocusRequestId === "number" &&
                Number.isSafeInteger(validThreadState.workspaceSidebarFocusRequestId) &&
                validThreadState.workspaceSidebarFocusRequestId >= 0
                  ? validThreadState.workspaceSidebarFocusRequestId
                  : 0;
              return [
                threadKey,
                {
                  isOpen,
                  surfaces,
                  activeSurfaceId,
                  workspaceSidebarView,
                  workspaceSidebarFocusRequestId,
                },
              ];
            },
          ),
        )
      : {};
  return { byThreadKey };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      open: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            if (kind === "files") return showWorkspaceSidebar(current, "explorer");
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      openBrowser: (ref, tabId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            return upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface);
          }),
        })),
      openFile: (ref, relativePath, target) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => surface.kind !== "files",
            );
            const surfaceId = `file:${relativePath}` as const;
            const existing = withoutStandaloneExplorer.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.id === surfaceId && surface.kind === "file",
            );
            const surface = fileSurface(
              relativePath,
              normalizeFileRevealTarget(target),
              nextRequestId(existing?.revealRequestId ?? 0),
            );
            return {
              ...current,
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? withoutStandaloneExplorer.map((entry) =>
                    entry.id === surface.id ? surface : entry,
                  )
                : [...withoutStandaloneExplorer, surface],
            };
          }),
        })),
      openTerminal: (ref, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            upsertSurface(current, terminalSurface(terminalId)),
          ),
        })),
      splitTerminal: (ref, surfaceId, terminalId, direction = "horizontal") =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) => {
              if (surface.id !== surfaceId || surface.kind !== "terminal") return surface;
              const { splitDirection: _splitDirection, ...baseSurface } = surface;
              return {
                ...baseSurface,
                terminalIds: surface.terminalIds.includes(terminalId)
                  ? surface.terminalIds
                  : [...surface.terminalIds, terminalId],
                activeTerminalId: terminalId,
                ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
              };
            }),
          })),
        })),
      activateTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === "terminal" &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        })),
      closeTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);
              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
              const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
              return {
                ...current,
                isOpen: surfaces.length > 0 && current.isOpen,
                surfaces,
                activeSurfaceId:
                  current.activeSurfaceId === surfaceId
                    ? (fallback?.id ?? null)
                    : current.activeSurfaceId,
              };
            }
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === "terminal"
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        })),
      activateSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            closeSurfacesInThread(current, new Set([surfaceId])),
          ),
        })),
      closeSurfaces: (ref, surfaceIds) => {
        const requestedSurfaceIds = new Set(surfaceIds);
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            closeSurfacesInThread(current, requestedSurfaceIds),
          ),
        }));
      },
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        })),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        })),
      closeAllSurfaces: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
          ),
        })),
      closeFileSurfaces: (ref, surfaceIds) => {
        const requestedSurfaceIds = new Set(surfaceIds);
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            closeFileSurfacesInThread(current, requestedSurfaceIds),
          ),
        }));
      },
      closeAllFileSurfaces: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            closeFileSurfacesInThread(current, null),
          ),
        })),
      reconcileBrowserSurfaces: (ref, tabIds) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const nonBrowser = current.surfaces.filter((surface) => surface.kind !== "preview");
            const existingBrowser = current.surfaces.filter(
              (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                surface.kind === "preview" &&
                surface.id !== "browser:new" &&
                validIds.has(surface.id),
            );
            const knownIds = new Set(existingBrowser.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...nonBrowser, ...existingBrowser, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            };
          }),
        })),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            if (workspaceAvailable) return current;
            const surfaces = current.surfaces.filter(
              (surface) => surface.kind !== "files" && surface.kind !== "file",
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              isOpen: surfaces.length > 0 ? current.isOpen : false,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (surfaces.at(-1)?.id ?? null),
            };
          }),
        })),
      showWorkspaceExplorer: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            showWorkspaceSidebar(current, "explorer"),
          ),
        })),
      showWorkspaceSearch: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            showWorkspaceSidebar(current, "search"),
          ),
        })),
      show: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        })),
      close: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        })),
      toggleVisibility: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        })),
      toggle: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) {
              return { ...current, isOpen: false };
            }
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          return { byThreadKey: rest };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      migrate: migratePersistedRightPanelState,
    },
  ),
);

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

/** Preserve the user's file-tab order while excluding non-file panel surfaces. */
export function selectOrderedFileSurfaces(
  surfaces: readonly RightPanelSurface[],
): RightPanelFileSurface[] {
  return surfaces.filter((surface): surface is RightPanelFileSurface => surface.kind === "file");
}

export function selectThreadFileSurfaces(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelFileSurface[] {
  return selectOrderedFileSurfaces(selectThreadRightPanelState(byThreadKey, ref).surfaces);
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
