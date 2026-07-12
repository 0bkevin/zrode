import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  normalizeFileRevealTarget,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectOrderedFileSurfaces,
  selectThreadFileSurfaces,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const defaultWorkspaceSidebarState = {
  workspaceSidebarView: "explorer",
  workspaceSidebarFocusRequestId: 0,
} as const;

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore", () => {
  it("drops the legacy singleton terminal surface during migration", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "terminal",
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "terminal", kind: "terminal" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
          ...defaultWorkspaceSidebarState,
        },
      },
    });
  });

  it("upgrades saved single-session terminal surfaces to split-capable surfaces", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "terminal:term-1",
            surfaces: [{ id: "terminal:term-1", kind: "terminal", resourceId: "term-1" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "terminal:term-1",
          surfaces: [
            {
              id: "terminal:term-1",
              kind: "terminal",
              resourceId: "term-1",
              terminalIds: ["term-1"],
              activeTerminalId: "term-1",
            },
          ],
          ...defaultWorkspaceSidebarState,
        },
      },
    });
  });

  it("upgrades saved file surfaces with neutral reveal state", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:src/index.ts",
            surfaces: [{ id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "file:src/index.ts",
          surfaces: [
            {
              id: "file:src/index.ts",
              kind: "file",
              relativePath: "src/index.ts",
              revealTarget: null,
              revealRequestId: 0,
            },
          ],
          ...defaultWorkspaceSidebarState,
        },
      },
    });
  });

  it("migrates legacy line reveals to one-based reveal targets", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:src/index.ts",
            surfaces: [
              {
                id: "file:src/index.ts",
                kind: "file",
                relativePath: "src/index.ts",
                revealLine: 0.9,
                revealRequestId: -1,
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "file:src/index.ts",
          surfaces: [
            {
              id: "file:src/index.ts",
              kind: "file",
              relativePath: "src/index.ts",
              revealTarget: { kind: "line", line: 1 },
              revealRequestId: 0,
            },
          ],
          ...defaultWorkspaceSidebarState,
        },
      },
    });
  });

  it("normalizes persisted UTF-16 reveal ranges", () => {
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "file:src/index.ts",
          surfaces: [
            {
              id: "file:src/index.ts",
              kind: "file",
              relativePath: "src/index.ts",
              revealTarget: {
                kind: "range",
                start: { line: 10.8, column: 14.9 },
                end: { line: 3.2, column: -4 },
              },
              revealRequestId: 7,
            },
          ],
        },
      },
    });

    expect(selectThreadRightPanelState(migrated.byThreadKey, refA).surfaces[0]).toEqual({
      id: "file:src/index.ts",
      kind: "file",
      relativePath: "src/index.ts",
      revealTarget: {
        kind: "range",
        start: { line: 3, column: 1 },
        end: { line: 10, column: 14 },
      },
      revealRequestId: 7,
    });
  });

  it("rejects malformed reveal targets without leaking invalid coordinates", () => {
    expect(
      normalizeFileRevealTarget({
        kind: "range",
        start: { line: 4, column: 2 },
        end: { line: Number.NaN, column: 8 },
      }),
    ).toBeNull();
    expect(normalizeFileRevealTarget({ kind: "line", line: Number.POSITIVE_INFINITY })).toBeNull();
    expect(normalizeFileRevealTarget({ kind: "selection", line: 3 })).toBeNull();
  });

  it("migrates persisted workspace sidebar state and defaults invalid values", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "files",
            surfaces: [{ id: "files", kind: "files" }],
            workspaceSidebarView: "search",
            workspaceSidebarFocusRequestId: 12,
          },
          "env-1:thread-B": {
            isOpen: true,
            activeSurfaceId: "files",
            surfaces: [{ id: "files", kind: "files" }],
            workspaceSidebarView: "invalid",
            workspaceSidebarFocusRequestId: -1,
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "files",
          surfaces: [{ id: "files", kind: "files" }],
          workspaceSidebarView: "search",
          workspaceSidebarFocusRequestId: 12,
        },
        "env-1:thread-B": {
          isOpen: true,
          activeSurfaceId: "files",
          surfaces: [{ id: "files", kind: "files" }],
          ...defaultWorkspaceSidebarState,
        },
      },
    });
  });

  it("open sets the active panel for a thread", () => {
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBeNull();
  });

  it("opening a different kind keeps both surfaces and activates the new one", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
  });

  it("keeps files as a singleton surface", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().open(refA, "files");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("replaces the standalone explorer with peer file surfaces", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "README.md");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:README.md",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealTarget: null,
          revealRequestId: 2,
        },
        {
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
          revealTarget: null,
          revealRequestId: 1,
        },
      ],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("selects file surfaces in their mixed-surface tab order", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openFile(refA, "README.md");

    const byThreadKey = useRightPanelStore.getState().byThreadKey;
    const threadState = selectThreadRightPanelState(byThreadKey, refA);
    expect(threadState.surfaces.map((surface) => surface.id)).toEqual([
      "browser:tab-a",
      "file:src/index.ts",
      "terminal:term-1",
      "file:README.md",
    ]);
    expect(selectOrderedFileSurfaces(threadState.surfaces).map((surface) => surface.id)).toEqual([
      "file:src/index.ts",
      "file:README.md",
    ]);
    expect(selectThreadFileSurfaces(byThreadKey, refA).map((surface) => surface.id)).toEqual([
      "file:src/index.ts",
      "file:README.md",
    ]);
  });

  it("closes selected file surfaces atomically and activates the next open file", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/a.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openFile(refA, "src/b.ts");
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().openFile(refA, "src/c.ts");
    useRightPanelStore.getState().activateSurface(refA, "file:src/b.ts");

    useRightPanelStore
      .getState()
      .closeFileSurfaces(refA, ["file:src/b.ts", "terminal:term-1", "missing"]);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("file:src/c.ts");
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "browser:tab-a",
      "file:src/a.ts",
      "terminal:term-1",
      "plan",
      "file:src/c.ts",
    ]);

    useRightPanelStore.getState().closeFileSurfaces(refA, ["file:src/c.ts"]);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).activeSurfaceId,
    ).toBe("file:src/a.ts");
  });

  it("restores and activates the explorer when the final file surface closes", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().activateSurface(refA, "file:src/index.ts");

    useRightPanelStore.getState().closeFileSurfaces(refA, ["file:src/index.ts"]);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [
        { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
        { id: "files", kind: "files" },
        {
          id: "terminal:term-1",
          kind: "terminal",
          resourceId: "term-1",
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
        },
      ],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("closes all file surfaces without disturbing the active non-file surface", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/a.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openFile(refA, "src/b.ts");
    useRightPanelStore.getState().open(refA, "plan");

    useRightPanelStore.getState().closeAllFileSurfaces(refA);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("plan");
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "browser:tab-a",
      "files",
      "terminal:term-1",
      "plan",
    ]);
  });

  it("closes only captured file ids when another editor opens during confirmation", () => {
    useRightPanelStore.getState().openFile(refA, "src/a.ts");
    useRightPanelStore.getState().openFile(refA, "src/b.ts");
    const capturedIds = selectThreadFileSurfaces(
      useRightPanelStore.getState().byThreadKey,
      refA,
    ).map((surface) => surface.id);

    useRightPanelStore.getState().openFile(refA, "src/opened-during-prompt.ts");
    useRightPanelStore.getState().closeFileSurfaces(refA, capturedIds);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("file:src/opened-during-prompt.ts");
    expect(selectOrderedFileSurfaces(state.surfaces).map((surface) => surface.id)).toEqual([
      "file:src/opened-during-prompt.ts",
    ]);
  });

  it("switches workspace sidebar modes and requests search focus", () => {
    useRightPanelStore.getState().showWorkspaceSearch(refA);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
      workspaceSidebarView: "search",
      workspaceSidebarFocusRequestId: 1,
    });

    useRightPanelStore.getState().showWorkspaceSearch(refA);
    useRightPanelStore.getState().showWorkspaceExplorer(refA);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
      workspaceSidebarView: "explorer",
      workspaceSidebarFocusRequestId: 2,
    });

    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().showWorkspaceSearch(refA);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("file:src/index.ts");
    expect(state.workspaceSidebarView).toBe("search");
    expect(state.workspaceSidebarFocusRequestId).toBe(3);
    expect(state.surfaces.some((surface) => surface.kind === "files")).toBe(false);
  });

  it("updates line reveal requests when reopening a file surface", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 42);
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 87);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealTarget: { kind: "line", line: 87 },
          revealRequestId: 2,
        },
      ],
      ...defaultWorkspaceSidebarState,
    });

    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealTarget: null,
          revealRequestId: 3,
        },
      ],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("updates and normalizes range reveal requests when reopening a file surface", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts", {
      kind: "range",
      start: { line: 8.9, column: 21.7 },
      end: { line: 8.1, column: 4.2 },
    });
    useRightPanelStore.getState().openFile(refA, "src/index.ts", {
      kind: "range",
      start: { line: 12, column: 3 },
      end: { line: 12, column: 9 },
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces[0],
    ).toEqual({
      id: "file:src/index.ts",
      kind: "file",
      relativePath: "src/index.ts",
      revealTarget: {
        kind: "range",
        start: { line: 12, column: 3 },
        end: { line: 12, column: 9 },
      },
      revealRequestId: 2,
    });
  });

  it("removes persisted file surfaces when their workspace no longer exists", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().openFile(refA, "README.md");

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "plan",
      surfaces: [{ id: "plan", kind: "plan" }],
      ...defaultWorkspaceSidebarState,
    });

    useRightPanelStore.getState().openFile(refB, "conductor.json");
    useRightPanelStore.getState().reconcileFileSurfaces(refB, false);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("close hides the panel without clearing its selected surface", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().close(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "plan",
      surfaces: [{ id: "plan", kind: "plan" }],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("toggles empty panel visibility without creating a surface", () => {
    useRightPanelStore.getState().toggleVisibility(refA);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
      ...defaultWorkspaceSidebarState,
    });

    useRightPanelStore.getState().toggleVisibility(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("toggle hides the panel without discarding the active surface", () => {
    useRightPanelStore.getState().toggle(refA, "diff");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
    useRightPanelStore.getState().toggle(refA, "diff");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [{ id: "diff", kind: "diff" }],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("toggle to a different kind switches active", () => {
    useRightPanelStore.getState().toggle(refA, "preview");
    useRightPanelStore.getState().toggle(refA, "plan");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("plan");
  });

  it("removeThread clears persisted state", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().removeThread(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
  });

  it("close on never-opened thread is a no-op", () => {
    useRightPanelStore.getState().close(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("tracks one surface per browser session", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["browser:tab-a", "browser:tab-b"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "browser:tab-b",
      kind: "preview",
      resourceId: "tab-b",
    });
  });

  it("tracks one surface per terminal session", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openTerminal(refA, "term-2");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toEqual([
      {
        id: "terminal:term-1",
        kind: "terminal",
        resourceId: "term-1",
        terminalIds: ["term-1"],
        activeTerminalId: "term-1",
      },
      {
        id: "terminal:term-2",
        kind: "terminal",
        resourceId: "term-2",
        terminalIds: ["term-2"],
        activeTerminalId: "term-2",
      },
    ]);
    expect(state.activeSurfaceId).toBe("terminal:term-2");
  });

  it("tracks split panes and the active pane within a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
    });

    useRightPanelStore.getState().activateTerminal(refA, "terminal:term-1", "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-2"],
      activeTerminalId: "term-2",
    });
  });

  it("tracks vertical layout for a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2", "vertical");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
      splitDirection: "vertical",
    });
  });

  it("closing the final terminal pane removes its surface and closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("closing the active surface activates a neighboring surface", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "browser:tab-a",
    );
  });

  it("closing the final surface closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("closing other surfaces keeps the selected surface active", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeOtherSurfaces(refA, "file:src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealTarget: null,
          revealRequestId: 1,
        },
      ],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("closes only the surfaces captured by a close-others confirmation", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    const capturedIds = ["browser:tab-a", "terminal:term-1"];

    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().closeSurfaces(refA, capturedIds);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.isOpen).toBe(true);
    expect(state.activeSurfaceId).toBe("plan");
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["file:src/index.ts", "plan"]);
  });

  it("closing surfaces to the right activates the selected surface when active was removed", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeSurfacesToRight(refA, "browser:tab-a");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "browser:tab-a",
      surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("does not close a surface opened after close-to-right captured its ids", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    const capturedIds = ["file:src/index.ts", "terminal:term-1"];

    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().closeSurfaces(refA, capturedIds);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.isOpen).toBe(true);
    expect(state.activeSurfaceId).toBe("plan");
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["browser:tab-a", "plan"]);
  });

  it("closing all surfaces closes the panel", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    useRightPanelStore.getState().closeAllSurfaces(refA);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("does not close a surface opened after close-all captured its ids", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    const capturedIds = ["browser:tab-a", "file:src/index.ts"];

    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurfaces(refA, capturedIds);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "terminal:term-1",
      surfaces: [
        {
          id: "terminal:term-1",
          kind: "terminal",
          resourceId: "term-1",
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
        },
      ],
      ...defaultWorkspaceSidebarState,
    });
  });

  it("reconciles browser surfaces without deleting other surface kinds", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ["tab-b", "tab-c"]);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["terminal:term-1", "browser:tab-b", "browser:tab-c"]);
  });
});
