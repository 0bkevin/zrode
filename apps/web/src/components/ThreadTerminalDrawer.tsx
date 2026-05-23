import { FitAddon } from "@xterm/addon-fit";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Plus, SquareSplitHorizontal, TerminalSquare, Trash2, XIcon } from "lucide-react";
import {
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type ThreadId,
} from "@zrode/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  normalizeThreadTerminalLayout,
  resolveThreadTerminalDropZone,
  threadTerminalLayoutGroupIds,
  threadTerminalLayoutKey,
} from "~/lib/threadTerminalLayout";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { openInPreferredEditor } from "../editorPreferences";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../terminal-links";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitDownShortcut,
  isTerminalSplitShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalDropZone,
  type ThreadTerminalGroup,
  type ThreadTerminalLayoutNode,
  type ThreadTerminalSplitLayout,
} from "../types";
import { readEnvironmentApi } from "~/environmentApi";
import { readLocalApi } from "~/localApi";
import { selectTerminalEventEntries, useTerminalStateStore } from "../terminalStateStore";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function paneDropOverlayClassName(zone: ThreadTerminalDropZone): string {
  switch (zone) {
    case "center":
      return "inset-0";
    case "left":
      return "left-0 top-0 h-full w-1/2";
    case "right":
      return "right-0 top-0 h-full w-1/2";
    case "up":
      return "left-0 top-0 h-1/2 w-full";
    case "down":
      return "bottom-0 left-0 h-1/2 w-full";
  }
}

interface TerminalTabDragData {
  kind: "terminal-tab";
  groupId: string;
  terminalId: string;
  label: string;
}

interface TerminalPaneDropData {
  kind: "terminal-pane";
  groupId: string;
}

interface TerminalTabDropData {
  kind: "terminal-tab-target";
  groupId: string;
  terminalId: string;
}

type TerminalDragData = TerminalTabDragData;
type TerminalDropData = TerminalPaneDropData | TerminalTabDropData;

function isTerminalTabDragData(value: unknown): value is TerminalTabDragData {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as TerminalTabDragData).kind === "terminal-tab"
  );
}

function isTerminalDropData(value: unknown): value is TerminalDropData {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    ((value as TerminalDropData).kind === "terminal-pane" ||
      (value as TerminalDropData).kind === "terminal-tab-target")
  );
}

function terminalPaneDroppableId(groupId: string): UniqueIdentifier {
  return `thread-terminal-pane:${groupId}`;
}

function terminalTabDraggableId(terminalId: string): UniqueIdentifier {
  return `thread-terminal-tab-drag:${terminalId}`;
}

function terminalTabDroppableId(terminalId: string): UniqueIdentifier {
  return `thread-terminal-tab-drop:${terminalId}`;
}

function getDragCenter(
  event: Pick<DragMoveEvent | DragOverEvent | DragEndEvent, "active" | "delta">,
): { x: number; y: number } | null {
  const translated = event.active.rect.current.translated;
  if (translated) {
    return {
      x: translated.left + translated.width / 2,
      y: translated.top + translated.height / 2,
    };
  }
  const initial = event.active.rect.current.initial;
  if (!initial) return null;
  return {
    x: initial.left + initial.width / 2 + event.delta.x,
    y: initial.top + initial.height / 2 + event.delta.y,
  };
}

function resolveAbsolutePaneDropZone(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
): ThreadTerminalDropZone {
  return resolveThreadTerminalDropZone(rect, {
    x: point.x - rect.left,
    y: point.y - rect.top,
  });
}

function resolveTerminalTabInsertSide(
  rect: { left: number; width: number },
  point: { x: number },
): "left" | "right" {
  return point.x < rect.left + rect.width / 2 ? "left" : "right";
}

function activeTerminalIdForTerminalGroup(
  terminalGroup: ThreadTerminalGroup,
  fallbackTerminalId: string,
): string {
  if (
    terminalGroup.activeTerminalId &&
    terminalGroup.terminalIds.includes(terminalGroup.activeTerminalId)
  ) {
    return terminalGroup.activeTerminalId;
  }
  const recentTerminalIds = terminalGroup.recentTerminalIds ?? [];
  for (let index = recentTerminalIds.length - 1; index >= 0; index -= 1) {
    const terminalId = recentTerminalIds[index];
    if (terminalId && terminalGroup.terminalIds.includes(terminalId)) {
      return terminalId;
    }
  }
  return terminalGroup.terminalIds[0] ?? fallbackTerminalId;
}

const terminalCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function writeTerminalSnapshot(terminal: Terminal, snapshot: TerminalSessionSnapshot): void {
  terminal.write("\u001bc");
  if (snapshot.history.length > 0) {
    terminal.write(snapshot.history);
  }
}

export function selectTerminalEventEntriesAfterSnapshot(
  entries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
  snapshotUpdatedAt: string,
): ReadonlyArray<{ id: number; event: TerminalEvent }> {
  return entries.filter((entry) => entry.event.createdAt > snapshotUpdatedAt);
}

export function selectPendingTerminalEventEntries(
  entries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
  lastAppliedTerminalEventId: number,
): ReadonlyArray<{ id: number; event: TerminalEvent }> {
  return entries.filter((entry) => entry.id > lastAppliedTerminalEventId);
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

function terminalThemeFromApp(mountElement?: HTMLElement | null): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const drawerSurface =
    mountElement?.closest(".thread-terminal-drawer") ??
    document.querySelector(".thread-terminal-drawer") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const bodyStyles = getComputedStyle(document.body);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

interface TerminalViewportProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  visible: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  keybindings: ResolvedKeybindingsConfig;
}

export function TerminalViewport({
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  visible,
  resizeEpoch,
  drawerHeight,
  keybindings,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const environmentId = threadRef.environmentId;
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const keybindingsRef = useRef(keybindings);
  const lastAppliedTerminalEventIdRef = useRef(0);
  const terminalHydratedRef = useRef(false);
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;
    const api = readEnvironmentApi(environmentId);
    const localApi = readLocalApi();
    if (!api || !localApi) return;

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp(mount),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await localApi.contextMenu.show(
          [{ id: "add-to-chat", label: "Add to chat" }],
          nextAction.position,
        );
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        handleAddTerminalContext(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } finally {
        selectionActionOpenRef.current = false;
      }
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const currentKeybindings = keybindingsRef.current;
      const options = { context: { terminalFocus: true, terminalOpen: true } };
      if (
        isTerminalToggleShortcut(event, currentKeybindings, options) ||
        isTerminalSplitShortcut(event, currentKeybindings, options) ||
        isTerminalSplitDownShortcut(event, currentKeybindings, options) ||
        isTerminalNewShortcut(event, currentKeybindings, options) ||
        isTerminalCloseShortcut(event, currentKeybindings, options) ||
        isDiffToggleShortcut(event, currentKeybindings, options)
      ) {
        return false;
      }

      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      const deleteData = terminalDeleteShortcutData(event);
      if (deleteData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(deleteData, "Failed to delete terminal input");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          activeTerminal.buffer.active.getLine(bufferLineIndex),
        );
        if (!wrappedLine) {
          callback(undefined);
          return;
        }

        const links = extractTerminalLinks(wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        if (links.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          links.map(({ match, range }) => ({
            text: match.text,
            range,
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                void localApi.shell.openExternal(match.text).catch((error: unknown) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void openInPreferredEditor(localApi, target).catch((error) => {
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              });
            },
          })),
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      void api.terminal
        .write({ threadId, terminalId, data })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp(containerRef.current);
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const applyTerminalEvent = (event: TerminalEvent) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        return;
      }

      if (event.type === "activity") {
        return;
      }

      if (event.type === "output") {
        activeTerminal.write(event.data);
        clearSelectionAction();
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        clearSelectionAction();
        writeTerminalSnapshot(activeTerminal, event.snapshot);
        return;
      }

      if (event.type === "cleared") {
        clearSelectionAction();
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }

      const details = [
        typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
        typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
      ]
        .filter((value): value is string => value !== null)
        .join(", ");
      writeSystemMessage(
        activeTerminal,
        details.length > 0 ? `Process exited (${details})` : "Process exited",
      );
      if (hasHandledExitRef.current) {
        return;
      }
      hasHandledExitRef.current = true;
      window.setTimeout(() => {
        if (!hasHandledExitRef.current) {
          return;
        }
        handleSessionExited();
      }, 0);
    };
    const applyPendingTerminalEvents = (
      terminalEventEntries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
    ) => {
      const pendingEntries = selectPendingTerminalEventEntries(
        terminalEventEntries,
        lastAppliedTerminalEventIdRef.current,
      );
      if (pendingEntries.length === 0) {
        return;
      }
      for (const entry of pendingEntries) {
        applyTerminalEvent(entry.event);
      }
      lastAppliedTerminalEventIdRef.current =
        pendingEntries.at(-1)?.id ?? lastAppliedTerminalEventIdRef.current;
    };

    const unsubscribeTerminalEvents = useTerminalStateStore.subscribe((state, previousState) => {
      if (!terminalHydratedRef.current) {
        return;
      }

      const previousLastEntryId =
        selectTerminalEventEntries(
          previousState.terminalEventEntriesByKey,
          threadRef,
          terminalId,
        ).at(-1)?.id ?? 0;
      const nextEntries = selectTerminalEventEntries(
        state.terminalEventEntriesByKey,
        threadRef,
        terminalId,
      );
      const nextLastEntryId = nextEntries.at(-1)?.id ?? 0;
      if (nextLastEntryId === previousLastEntryId) {
        return;
      }

      applyPendingTerminalEvents(nextEntries);
    });

    const openTerminal = async () => {
      try {
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        activeFitAddon.fit();
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
        });
        if (disposed) return;
        writeTerminalSnapshot(activeTerminal, snapshot);
        const bufferedEntries = selectTerminalEventEntries(
          useTerminalStateStore.getState().terminalEventEntriesByKey,
          threadRef,
          terminalId,
        );
        const replayEntries = selectTerminalEventEntriesAfterSnapshot(
          bufferedEntries,
          snapshot.updatedAt,
        );
        for (const entry of replayEntries) {
          applyTerminalEvent(entry.event);
        }
        lastAppliedTerminalEventIdRef.current = bufferedEntries.at(-1)?.id ?? 0;
        terminalHydratedRef.current = true;
        if (autoFocus) {
          window.requestAnimationFrame(() => {
            activeTerminal.focus();
          });
        }
      } catch (err) {
        if (disposed) return;
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      }
    };

    const fitTimer = window.setTimeout(() => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        })
        .catch(() => undefined);
    }, 30);
    void openTerminal();

    return () => {
      disposed = true;
      terminalHydratedRef.current = false;
      lastAppliedTerminalEventIdRef.current = 0;
      unsubscribeTerminalEvents();
      window.clearTimeout(fitTimer);
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, environmentId, runtimeEnv, terminalId, threadId]);

  useEffect(() => {
    if (!visible) return;
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId, visible]);

  useEffect(() => {
    if (!visible) return;
    const api = readEnvironmentApi(environmentId);
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => undefined);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, environmentId, resizeEpoch, terminalId, threadId, visible]);
  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-[4px] bg-background"
    />
  );
}

interface ThreadTerminalDrawerProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  presentation?: "drawer" | "workspace";
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  terminalLayout: ThreadTerminalLayoutNode;
  terminalPanesVisible: boolean;
  terminalGroupSplitLayout: ThreadTerminalSplitLayout;
  focusRequestId: number;
  onSplitTerminal: (splitLayout?: ThreadTerminalSplitLayout, targetGroupId?: string) => void;
  onNewTerminal: (targetGroupId?: string) => void;
  splitShortcutLabel?: string | undefined;
  splitDownShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onMoveTerminal?: (
    terminalId: string,
    targetTerminalId: string,
    zone: ThreadTerminalDropZone,
  ) => void;
  onMoveTerminalToGroup?: (terminalId: string, targetGroupId: string, index?: number) => void;
  onTerminalLayoutRatioChange: (nodePath: string, ratio: number) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

interface TerminalLayoutResizeHandleProps {
  direction: ThreadTerminalSplitLayout;
  onRatioChange: (ratio: number) => void;
}

function TerminalLayoutResizeHandle({ direction, onRatioChange }: TerminalLayoutResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const isColumns = direction === "columns";

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      const container = handle.parentElement;
      if (!container) return;

      setDragging(true);
      handle.setPointerCapture(event.pointerId);

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        const rect = container.getBoundingClientRect();
        const ratio = isColumns
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height;
        onRatioChange(ratio);
      };

      const cleanup = () => {
        setDragging(false);
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
        handle.removeEventListener("pointermove", onPointerMove);
        handle.removeEventListener("pointerup", cleanup);
        handle.removeEventListener("pointercancel", cleanup);
        handle.removeEventListener("lostpointercapture", cleanup);
      };

      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", cleanup);
      handle.addEventListener("pointercancel", cleanup);
      handle.addEventListener("lostpointercapture", cleanup);
    },
    [isColumns, onRatioChange],
  );

  return (
    <div
      className={`shrink-0 transition-colors ${
        isColumns ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"
      } ${dragging ? "bg-accent" : "bg-border/80 hover:bg-accent/70"}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={isColumns ? "vertical" : "horizontal"}
    />
  );
}

interface TerminalGroupTabButtonProps {
  groupId: string;
  terminalId: string;
  label: string;
  active: boolean;
  closeLabel: string;
  canClose: boolean;
  dropSide: "left" | "right" | null;
  onActivate: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
}

function TerminalGroupTabButton({
  groupId,
  terminalId,
  label,
  active,
  closeLabel,
  canClose,
  dropSide,
  onActivate,
  onClose,
}: TerminalGroupTabButtonProps) {
  const { setNodeRef: setDropNodeRef } = useDroppable({
    id: terminalTabDroppableId(terminalId),
    data: { kind: "terminal-tab-target", groupId, terminalId } satisfies TerminalTabDropData,
  });
  const {
    attributes,
    listeners,
    setNodeRef: setDragNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: terminalTabDraggableId(terminalId),
    data: { kind: "terminal-tab", groupId, terminalId, label } satisfies TerminalTabDragData,
  });

  return (
    <div
      ref={setDropNodeRef}
      className={`group/tab relative flex h-full min-w-24 max-w-48 shrink-0 items-center border-r border-border text-xs transition-[background-color,color,opacity] duration-150 ${
        active
          ? "bg-background text-foreground"
          : "bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      } ${isDragging ? "opacity-35" : ""}`}
    >
      {dropSide ? (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute top-1 z-20 h-[calc(100%-0.5rem)] w-0.5 rounded bg-accent ${
            dropSide === "left" ? "left-0" : "right-0"
          }`}
        />
      ) : null}
      <button
        ref={setDragNodeRef}
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
        style={{
          transform: CSS.Translate.toString(transform),
          touchAction: "none",
        }}
        onClick={() => onActivate(terminalId)}
        {...attributes}
        {...listeners}
      >
        <TerminalSquare className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {canClose ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <button
                type="button"
                aria-label={closeLabel}
                className="mr-1 rounded p-0.5 opacity-55 transition hover:bg-accent hover:opacity-100 group-hover/tab:opacity-100"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(terminalId);
                }}
              />
            }
          >
            <XIcon className="size-3" />
          </PopoverTrigger>
          <PopoverPopup
            tooltipStyle
            side="bottom"
            sideOffset={6}
            align="center"
            className="pointer-events-none select-none"
          >
            {closeLabel}
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}

interface TerminalPaneDropSurfaceProps {
  groupId: string;
  disabled: boolean;
  className: string;
  children: ReactNode;
  onMouseDown?: () => void;
}

function TerminalPaneDropSurface({
  groupId,
  disabled,
  className,
  children,
  onMouseDown,
}: TerminalPaneDropSurfaceProps) {
  const { setNodeRef } = useDroppable({
    id: terminalPaneDroppableId(groupId),
    data: { kind: "terminal-pane", groupId } satisfies TerminalPaneDropData,
    disabled,
  });

  return (
    <section ref={setNodeRef} className={className} onMouseDown={onMouseDown}>
      {children}
    </section>
  );
}

export default function ThreadTerminalDrawer({
  threadRef,
  threadId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
  presentation = "drawer",
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  terminalLayout,
  terminalPanesVisible,
  terminalGroupSplitLayout,
  focusRequestId,
  onSplitTerminal,
  onNewTerminal,
  splitShortcutLabel,
  splitDownShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onMoveTerminal,
  onMoveTerminalToGroup,
  onTerminalLayoutRatioChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
  keybindings,
}: ThreadTerminalDrawerProps) {
  const isWorkspacePresentation = presentation === "workspace";
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  const normalizedTerminalIds = useMemo(() => {
    const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds = [
        ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ].filter((terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      });
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
        ...(terminalGroup.activeTerminalId &&
        nextTerminalIds.includes(terminalGroup.activeTerminalId)
          ? { activeTerminalId: terminalGroup.activeTerminalId }
          : {}),
        ...(terminalGroup.recentTerminalIds
          ? {
              recentTerminalIds: terminalGroup.recentTerminalIds.filter((terminalId) =>
                nextTerminalIds.includes(terminalId),
              ),
            }
          : {}),
        ...(terminalGroup.splitLayout === "rows" ? { splitLayout: "rows" as const } : {}),
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    if (nextGroups.length > 0) {
      return nextGroups;
    }

    return [
      {
        id: `group-${resolvedActiveTerminalId}`,
        terminalIds: [resolvedActiveTerminalId],
      },
    ];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const resolvedTerminalLayout = useMemo(
    () =>
      normalizeThreadTerminalLayout(
        terminalLayout,
        resolvedTerminalGroups.map((group) => group.id),
        terminalGroupSplitLayout === "rows" ? "rows" : "columns",
      ),
    [resolvedTerminalGroups, terminalGroupSplitLayout, terminalLayout],
  );
  const terminalGroupById = useMemo(
    () => new Map(resolvedTerminalGroups.map((group) => [group.id, group])),
    [resolvedTerminalGroups],
  );

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const hasTerminalSidebar = false;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedNewTerminalLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId, index) => [terminalId, `Terminal ${index + 1}`]),
      ),
    [normalizedTerminalIds],
  );
  const splitTerminalActionLabel = splitShortcutLabel
    ? `Split Terminal (${splitShortcutLabel})`
    : "Split Terminal";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const splitDownActionLabel = splitDownShortcutLabel
    ? `Split Down (${splitDownShortcutLabel})`
    : "Split Down";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const [activeTerminalDrag, setActiveTerminalDrag] = useState<TerminalDragData | null>(null);
  const [hoveredPaneDropTarget, setHoveredPaneDropTarget] = useState<{
    groupId: string;
    zone: ThreadTerminalDropZone;
  } | null>(null);
  const [hoveredTabInsertion, setHoveredTabInsertion] = useState<{
    groupId: string;
    terminalId: string;
    side: "left" | "right";
  } | null>(null);
  const terminalDragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: visible ? 5 : Number.MAX_SAFE_INTEGER },
    }),
  );
  const splitPanesVisible =
    terminalPanesVisible && threadTerminalLayoutGroupIds(resolvedTerminalLayout).length > 1;
  const layoutResizeSignature = useMemo(
    () =>
      [
        splitPanesVisible ? threadTerminalLayoutKey(resolvedTerminalLayout) : "active-only",
        resolvedTerminalGroups
          .map(
            (group) => `${group.id}:${group.activeTerminalId ?? ""}:${group.terminalIds.join(",")}`,
          )
          .join("|"),
      ].join("#"),
    [resolvedTerminalGroups, resolvedTerminalLayout, splitPanesVisible],
  );
  const onSplitTerminalAction = useCallback(() => {
    onSplitTerminal("columns");
  }, [onSplitTerminal]);
  const onNewTerminalAction = useCallback(() => {
    if (hasReachedNewTerminalLimit) return;
    onNewTerminal();
  }, [hasReachedNewTerminalLimit, onNewTerminal]);
  const clearTerminalDragState = useCallback(() => {
    setActiveTerminalDrag(null);
    setHoveredPaneDropTarget(null);
    setHoveredTabInsertion(null);
  }, []);

  const updateHoveredTerminalDropTarget = useCallback((event: DragMoveEvent | DragOverEvent) => {
    const activeData = event.active.data.current;
    const overData = event.over?.data.current;
    if (!isTerminalTabDragData(activeData) || !event.over || !isTerminalDropData(overData)) {
      setHoveredPaneDropTarget((current) => (current === null ? current : null));
      setHoveredTabInsertion((current) => (current === null ? current : null));
      return;
    }

    const center = getDragCenter(event);
    if (!center) {
      setHoveredPaneDropTarget((current) => (current === null ? current : null));
      setHoveredTabInsertion((current) => (current === null ? current : null));
      return;
    }

    if (overData.kind === "terminal-pane") {
      const zone = resolveAbsolutePaneDropZone(event.over.rect, center);
      setHoveredPaneDropTarget((current) =>
        current?.groupId === overData.groupId && current.zone === zone
          ? current
          : { groupId: overData.groupId, zone },
      );
      setHoveredTabInsertion((current) => (current === null ? current : null));
      return;
    }

    const side = resolveTerminalTabInsertSide(event.over.rect, center);
    setHoveredTabInsertion((current) =>
      current?.groupId === overData.groupId &&
      current.terminalId === overData.terminalId &&
      current.side === side
        ? current
        : { groupId: overData.groupId, terminalId: overData.terminalId, side },
    );
    setHoveredPaneDropTarget((current) => (current === null ? current : null));
  }, []);

  const handleTerminalDragStart = useCallback((event: DragStartEvent) => {
    const dragData = event.active.data.current;
    setActiveTerminalDrag(isTerminalTabDragData(dragData) ? dragData : null);
  }, []);

  const handleTerminalDragMove = useCallback(
    (event: DragMoveEvent) => {
      updateHoveredTerminalDropTarget(event);
    },
    [updateHoveredTerminalDropTarget],
  );

  const handleTerminalDragOver = useCallback(
    (event: DragOverEvent) => {
      updateHoveredTerminalDropTarget(event);
    },
    [updateHoveredTerminalDropTarget],
  );

  const handleTerminalDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeData = event.active.data.current;
      const overData = event.over?.data.current;
      if (!event.over || !isTerminalTabDragData(activeData) || !isTerminalDropData(overData)) {
        clearTerminalDragState();
        return;
      }

      const center = getDragCenter(event);
      if (!center) {
        clearTerminalDragState();
        return;
      }

      if (overData.kind === "terminal-tab-target") {
        const targetGroup = terminalGroupById.get(overData.groupId);
        if (targetGroup && activeData.terminalId !== overData.terminalId) {
          const side = resolveTerminalTabInsertSide(event.over.rect, center);
          const overIndex = targetGroup.terminalIds.indexOf(overData.terminalId);
          const rawIndex =
            overIndex === -1
              ? targetGroup.terminalIds.length
              : overIndex + (side === "right" ? 1 : 0);
          const sourceIndex =
            activeData.groupId === overData.groupId
              ? targetGroup.terminalIds.indexOf(activeData.terminalId)
              : -1;
          const targetIndex = sourceIndex >= 0 && sourceIndex < rawIndex ? rawIndex - 1 : rawIndex;
          onMoveTerminalToGroup?.(
            activeData.terminalId,
            overData.groupId,
            Math.max(0, targetIndex),
          );
        }
        clearTerminalDragState();
        return;
      }

      const targetGroup = terminalGroupById.get(overData.groupId);
      const zone = resolveAbsolutePaneDropZone(event.over.rect, center);
      const targetTerminalId = targetGroup
        ? activeTerminalIdForTerminalGroup(targetGroup, resolvedActiveTerminalId)
        : null;

      if (targetTerminalId) {
        if (zone === "center") {
          if (activeData.groupId !== overData.groupId) {
            onMoveTerminalToGroup?.(
              activeData.terminalId,
              overData.groupId,
              targetGroup?.terminalIds.length,
            );
          }
        } else {
          onMoveTerminal?.(activeData.terminalId, targetTerminalId, zone);
        }
      }
      clearTerminalDragState();
    },
    [
      clearTerminalDragState,
      onMoveTerminal,
      onMoveTerminalToGroup,
      resolvedActiveTerminalId,
      terminalGroupById,
    ],
  );

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback(
    (nextHeight: number) => {
      if (isWorkspacePresentation) return;
      const clampedHeight = clampDrawerHeight(nextHeight);
      if (lastSyncedHeightRef.current === clampedHeight) return;
      lastSyncedHeightRef.current = clampedHeight;
      onHeightChangeRef.current(clampedHeight);
    },
    [isWorkspacePresentation],
  );

  useEffect(() => {
    if (isWorkspacePresentation) {
      return;
    }
    const clampedHeight = clampDrawerHeight(height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [height, isWorkspacePresentation, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [layoutResizeSignature, visible]);

  useEffect(() => {
    if (isWorkspacePresentation) {
      return;
    }
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [isWorkspacePresentation, syncHeight]);

  const renderTerminalViewport = (terminalId: string, terminalIsVisible: boolean) => (
    <TerminalViewport
      key={terminalId}
      threadRef={threadRef}
      threadId={threadId}
      terminalId={terminalId}
      terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
      cwd={cwd}
      {...(worktreePath !== undefined ? { worktreePath } : {})}
      {...(runtimeEnv ? { runtimeEnv } : {})}
      onSessionExited={() => onCloseTerminal(terminalId)}
      onAddTerminalContext={onAddTerminalContext}
      focusRequestId={focusRequestId}
      autoFocus={terminalIsVisible && terminalId === resolvedActiveTerminalId}
      visible={terminalIsVisible}
      resizeEpoch={resizeEpoch}
      drawerHeight={drawerHeight}
      keybindings={keybindings}
    />
  );

  const renderTerminalGroup = (terminalGroup: ThreadTerminalGroup) => {
    const groupTerminalIds =
      terminalGroup.terminalIds.length > 0 ? terminalGroup.terminalIds : [resolvedActiveTerminalId];
    const groupIsActive = groupTerminalIds.includes(resolvedActiveTerminalId);
    const groupActiveTerminalId = groupIsActive
      ? resolvedActiveTerminalId
      : activeTerminalIdForTerminalGroup(terminalGroup, resolvedActiveTerminalId);
    const paneDropZone =
      hoveredPaneDropTarget?.groupId === terminalGroup.id ? hoveredPaneDropTarget.zone : null;
    const showPaneTabBar =
      isWorkspacePresentation || splitPanesVisible || groupTerminalIds.length > 1;
    const groupHasReachedNewTerminalLimit = groupTerminalIds.length >= MAX_TERMINALS_PER_GROUP;

    return (
      <div
        key={terminalGroup.id}
        className={`relative flex h-full w-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background transition-[opacity,border-color] duration-150 ${
          splitPanesVisible
            ? groupIsActive
              ? "border border-border"
              : "border border-border/70"
            : ""
        }`}
      >
        {showPaneTabBar ? (
          <div className="flex h-8 shrink-0 items-stretch overflow-hidden border-b border-border bg-muted/25">
            <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden">
              {groupTerminalIds.map((terminalId) => {
                const label = terminalLabelById.get(terminalId) ?? "Terminal";
                const active = terminalId === groupActiveTerminalId;
                const dropInsertion =
                  hoveredTabInsertion?.groupId === terminalGroup.id &&
                  hoveredTabInsertion.terminalId === terminalId
                    ? hoveredTabInsertion.side
                    : null;
                return (
                  <TerminalGroupTabButton
                    key={terminalId}
                    groupId={terminalGroup.id}
                    terminalId={terminalId}
                    label={label}
                    active={active}
                    closeLabel={
                      terminalId === resolvedActiveTerminalId && closeShortcutLabel
                        ? `Close ${label} (${closeShortcutLabel})`
                        : `Close ${label}`
                    }
                    canClose={normalizedTerminalIds.length > 1}
                    dropSide={dropInsertion}
                    onActivate={onActiveTerminalChange}
                    onClose={onCloseTerminal}
                  />
                );
              })}
              <TerminalActionButton
                className={`flex h-full shrink-0 items-center justify-center border-r border-border px-2 text-muted-foreground transition-colors ${
                  groupHasReachedNewTerminalLimit
                    ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                    : "hover:bg-muted/50 hover:text-foreground"
                }`}
                onClick={() => {
                  if (!groupHasReachedNewTerminalLimit) {
                    onNewTerminal(terminalGroup.id);
                  }
                }}
                label={
                  groupHasReachedNewTerminalLimit
                    ? `New Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
                    : newTerminalActionLabel
                }
              >
                <Plus className="size-3.5" />
              </TerminalActionButton>
            </div>
            <div className="flex shrink-0 items-stretch border-l border-border">
              <TerminalActionButton
                className="flex h-full items-center justify-center px-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                onClick={() => onSplitTerminal("columns", terminalGroup.id)}
                label={splitTerminalActionLabel}
              >
                <SquareSplitHorizontal className="size-3.5 rotate-90" />
              </TerminalActionButton>
              <TerminalActionButton
                className="flex h-full items-center justify-center border-l border-border px-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                onClick={() => onSplitTerminal("rows", terminalGroup.id)}
                label={splitDownActionLabel}
              >
                <SquareSplitHorizontal className="size-3.5" />
              </TerminalActionButton>
            </div>
          </div>
        ) : null}
        <TerminalPaneDropSurface
          groupId={terminalGroup.id}
          disabled={!activeTerminalDrag}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          onMouseDown={() => {
            if (groupActiveTerminalId !== resolvedActiveTerminalId) {
              onActiveTerminalChange(groupActiveTerminalId);
            }
          }}
        >
          {paneDropZone ? (
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute z-30 rounded-sm border border-accent bg-accent/25 transition-all duration-150 ease-out ${paneDropOverlayClassName(
                paneDropZone,
              )}`}
            />
          ) : null}
          <div className="relative h-full min-h-0 min-w-0 p-1">
            {groupTerminalIds.map((terminalId) => {
              const terminalIsVisible = terminalId === groupActiveTerminalId;
              return (
                <div
                  key={terminalId}
                  className="absolute inset-1 min-h-0 min-w-0 overflow-hidden"
                  style={{
                    visibility: terminalIsVisible ? "visible" : "hidden",
                    pointerEvents: terminalIsVisible ? "auto" : "none",
                  }}
                  aria-hidden={!terminalIsVisible}
                >
                  {renderTerminalViewport(terminalId, terminalIsVisible)}
                </div>
              );
            })}
          </div>
        </TerminalPaneDropSurface>
      </div>
    );
  };

  const renderTerminalLayoutNode = (
    node: ThreadTerminalLayoutNode,
    nodePath: string,
  ): ReactNode => {
    if (node.type === "leaf") {
      const terminalGroup = terminalGroupById.get(node.groupId) ??
        resolvedTerminalGroups[resolvedActiveGroupIndex] ?? {
          id: `group-${resolvedActiveTerminalId}`,
          terminalIds: [resolvedActiveTerminalId],
        };
      return renderTerminalGroup(terminalGroup);
    }

    const ratio = typeof node.ratio === "number" ? node.ratio : 0.5;
    const firstPath = nodePath.length > 0 ? `${nodePath}.first` : "first";
    const secondPath = nodePath.length > 0 ? `${nodePath}.second` : "second";

    return (
      <div
        key={nodePath || "root"}
        className="flex h-full w-full min-w-0 min-h-0 overflow-hidden"
        style={{ flexDirection: node.direction === "columns" ? "row" : "column" }}
      >
        <div
          className="flex min-w-0 min-h-0 overflow-hidden transition-[flex] duration-150 ease-out"
          style={{ flex: `${ratio} 1 0%` }}
        >
          {renderTerminalLayoutNode(node.first, firstPath)}
        </div>
        <TerminalLayoutResizeHandle
          direction={node.direction}
          onRatioChange={(nextRatio) => onTerminalLayoutRatioChange(nodePath, nextRatio)}
        />
        <div
          className="flex min-w-0 min-h-0 overflow-hidden transition-[flex] duration-150 ease-out"
          style={{ flex: `${1 - ratio} 1 0%` }}
        >
          {renderTerminalLayoutNode(node.second, secondPath)}
        </div>
      </div>
    );
  };

  return (
    <DndContext
      sensors={terminalDragSensors}
      collisionDetection={terminalCollisionDetection}
      onDragStart={handleTerminalDragStart}
      onDragMove={handleTerminalDragMove}
      onDragOver={handleTerminalDragOver}
      onDragEnd={handleTerminalDragEnd}
      onDragCancel={clearTerminalDragState}
      autoScroll={false}
    >
      <aside
        className={
          isWorkspacePresentation
            ? "thread-terminal-drawer relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
            : "thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
        }
        style={isWorkspacePresentation ? undefined : { height: `${drawerHeight}px` }}
      >
        {!isWorkspacePresentation ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
          />
        ) : null}

        {!isWorkspacePresentation && !hasTerminalSidebar && (
          <div className="pointer-events-none absolute right-2 top-2 z-20">
            <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
              <TerminalActionButton
                className="p-1 text-foreground/90 transition-colors hover:bg-accent"
                onClick={onSplitTerminalAction}
                label={splitTerminalActionLabel}
              >
                <SquareSplitHorizontal className="size-3.25" />
              </TerminalActionButton>
              <div className="h-4 w-px bg-border/80" />
              <TerminalActionButton
                className={`p-1 text-foreground/90 transition-colors ${
                  hasReachedNewTerminalLimit
                    ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                    : "hover:bg-accent"
                }`}
                onClick={onNewTerminalAction}
                label={
                  hasReachedNewTerminalLimit
                    ? `New Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
                    : newTerminalActionLabel
                }
              >
                <Plus className="size-3.25" />
              </TerminalActionButton>
              <div className="h-4 w-px bg-border/80" />
              <TerminalActionButton
                className="p-1 text-foreground/90 transition-colors hover:bg-accent"
                onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                label={closeTerminalActionLabel}
              >
                <Trash2 className="size-3.25" />
              </TerminalActionButton>
            </div>
          </div>
        )}

        <div className="min-h-0 w-full flex-1">
          <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
            <div className="min-w-0 flex-1">
              {splitPanesVisible
                ? renderTerminalLayoutNode(resolvedTerminalLayout, "")
                : renderTerminalGroup(
                    resolvedTerminalGroups[resolvedActiveGroupIndex] ?? {
                      id: `group-${resolvedActiveTerminalId}`,
                      terminalIds: visibleTerminalIds,
                    },
                  )}
            </div>

            {hasTerminalSidebar && (
              <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
                <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                  <div className="inline-flex h-full items-stretch">
                    <TerminalActionButton
                      className="inline-flex h-full items-center px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                      onClick={onSplitTerminalAction}
                      label={splitTerminalActionLabel}
                    >
                      <SquareSplitHorizontal className="size-3.25" />
                    </TerminalActionButton>
                    <TerminalActionButton
                      className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                      onClick={onNewTerminalAction}
                      label={newTerminalActionLabel}
                    >
                      <Plus className="size-3.25" />
                    </TerminalActionButton>
                    <TerminalActionButton
                      className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                      onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                      label={closeTerminalActionLabel}
                    >
                      <Trash2 className="size-3.25" />
                    </TerminalActionButton>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                  {resolvedTerminalGroups.map((terminalGroup, groupIndex) => {
                    const isGroupActive =
                      terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                    const groupActiveTerminalId = isGroupActive
                      ? resolvedActiveTerminalId
                      : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);

                    return (
                      <div key={terminalGroup.id} className="pb-0.5">
                        {showGroupHeaders && (
                          <button
                            type="button"
                            className={`flex w-full items-center rounded px-1 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
                              isGroupActive
                                ? "bg-accent/70 text-foreground"
                                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                            }`}
                            onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                          >
                            {terminalGroup.terminalIds.length > 1
                              ? `Split ${groupIndex + 1}`
                              : `Terminal ${groupIndex + 1}`}
                          </button>
                        )}

                        <div
                          className={
                            showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""
                          }
                        >
                          {terminalGroup.terminalIds.map((terminalId) => {
                            const isActive = terminalId === resolvedActiveTerminalId;
                            const closeTerminalLabel = `Close ${
                              terminalLabelById.get(terminalId) ?? "terminal"
                            }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;
                            return (
                              <div
                                key={terminalId}
                                className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                                  isActive
                                    ? "bg-accent text-foreground"
                                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                                }`}
                              >
                                {showGroupHeaders && (
                                  <span className="text-[10px] text-muted-foreground/80">└</span>
                                )}
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                  onClick={() => onActiveTerminalChange(terminalId)}
                                >
                                  <TerminalSquare className="size-3 shrink-0" />
                                  <span className="truncate">
                                    {terminalLabelById.get(terminalId) ?? "Terminal"}
                                  </span>
                                </button>
                                {normalizedTerminalIds.length > 1 && (
                                  <Popover>
                                    <PopoverTrigger
                                      openOnHover
                                      render={
                                        <button
                                          type="button"
                                          className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                          onClick={() => onCloseTerminal(terminalId)}
                                          aria-label={closeTerminalLabel}
                                        />
                                      }
                                    >
                                      <XIcon className="size-2.5" />
                                    </PopoverTrigger>
                                    <PopoverPopup
                                      tooltipStyle
                                      side="bottom"
                                      sideOffset={6}
                                      align="center"
                                      className="pointer-events-none select-none"
                                    >
                                      {closeTerminalLabel}
                                    </PopoverPopup>
                                  </Popover>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </aside>
            )}
          </div>
        </div>
      </aside>
      <DragOverlay dropAnimation={null}>
        {activeTerminalDrag ? (
          <div className="flex h-8 min-w-32 items-center gap-1.5 rounded border border-border bg-background px-2 text-xs text-foreground shadow-lg">
            <TerminalSquare className="size-3.5 shrink-0" />
            <span className="truncate">{activeTerminalDrag.label}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
