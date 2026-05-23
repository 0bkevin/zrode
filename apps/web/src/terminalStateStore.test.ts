import { scopeThreadRef, scopedThreadKey } from "@zrode/client-runtime";
import { ThreadId, type TerminalEvent } from "@zrode/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  migratePersistedTerminalStateStoreState,
  selectTerminalEventEntries,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "./terminalStateStore";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef("environment-b" as never, THREAD_ID);

function makeTerminalEvent(
  type: TerminalEvent["type"],
  overrides: Partial<TerminalEvent> = {},
): TerminalEvent {
  const base = {
    threadId: THREAD_ID,
    terminalId: "default",
    createdAt: "2026-04-02T20:00:00.000Z",
  };

  switch (type) {
    case "output":
      return { ...base, type, data: "hello\n", ...overrides } as TerminalEvent;
    case "activity":
      return { ...base, type, hasRunningSubprocess: true, ...overrides } as TerminalEvent;
    case "error":
      return { ...base, type, message: "boom", ...overrides } as TerminalEvent;
    case "cleared":
      return { ...base, type, ...overrides } as TerminalEvent;
    case "exited":
      return { ...base, type, exitCode: 0, exitSignal: null, ...overrides } as TerminalEvent;
    case "started":
    case "restarted":
      return {
        ...base,
        type,
        snapshot: {
          threadId: THREAD_ID,
          terminalId: "default",
          cwd: "/tmp/workspace",
          worktreePath: null,
          status: "running",
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-02T20:00:00.000Z",
        },
        ...overrides,
      } as TerminalEvent;
  }
}

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    useTerminalStateStore.persist.clearStorage();
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
      terminalLaunchContextByThreadKey: {},
      terminalEventEntriesByKey: {},
      nextTerminalEventId: 1,
    });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState).toEqual({
      entryPoint: "chat",
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: ["default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
      terminalLayout: { type: "leaf", groupId: "group-default" },
      terminalPanesVisible: false,
      terminalGroupSplitLayout: "columns",
    });
  });

  it("splits a single terminal into a new pane with a fresh terminal", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.splitTerminal(THREAD_REF, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalPanesVisible).toBe(true);
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
    expect(terminalState.terminalLayout).toEqual({
      type: "split",
      direction: "columns",
      first: { type: "leaf", groupId: "group-default" },
      second: { type: "leaf", groupId: "group-terminal-2" },
      ratio: 0.5,
    });
  });

  it("caps new terminal tabs at four terminals per group", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-2");
    store.newTerminal(THREAD_REF, "terminal-3");
    store.newTerminal(THREAD_REF, "terminal-4");
    store.newTerminal(THREAD_REF, "terminal-5");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
    ]);
    expect(terminalState.terminalGroups).toEqual([
      {
        id: "group-default",
        terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4"],
        activeTerminalId: "terminal-4",
        recentTerminalIds: ["terminal-2", "terminal-3", "terminal-4"],
      },
    ]);
  });

  it("creates new terminals as tabs in the active pane", () => {
    useTerminalStateStore.getState().newTerminal(THREAD_REF, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-default");
    expect(terminalState.terminalPanesVisible).toBe(false);
    expect(terminalState.terminalGroups).toEqual([
      {
        id: "group-default",
        terminalIds: ["default", "terminal-2"],
        activeTerminalId: "terminal-2",
      },
    ]);
  });

  it("records row layout for down splits", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2", "rows");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
    expect(terminalState.terminalLayout).toEqual({
      type: "split",
      direction: "rows",
      first: { type: "leaf", groupId: "group-default" },
      second: { type: "leaf", groupId: "group-terminal-2" },
      ratio: 0.5,
    });
  });

  it("moves terminal tabs into side groups and records root drop orientation", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-2");
    store.moveTerminal(THREAD_REF, "terminal-2", "default", "down");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalPanesVisible).toBe(true);
    expect(terminalState.terminalGroupSplitLayout).toBe("rows");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("places side-dropped terminal groups before or after the target side", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-2");
    store.newTerminal(THREAD_REF, "terminal-3");
    store.moveTerminal(THREAD_REF, "terminal-3", "default", "left");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalGroupSplitLayout).toBe("columns");
    expect(terminalState.terminalPanesVisible).toBe(true);
    expect(terminalState.terminalIds).toEqual(["terminal-3", "default", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-terminal-3", terminalIds: ["terminal-3"] },
      {
        id: "group-default",
        terminalIds: ["default", "terminal-2"],
        activeTerminalId: "terminal-2",
      },
    ]);
  });

  it("preserves nested split layout when side-dropping into an existing split", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-2");
    store.newTerminal(THREAD_REF, "terminal-3");
    store.moveTerminal(THREAD_REF, "terminal-2", "default", "right");
    store.moveTerminal(THREAD_REF, "terminal-3", "default", "down");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );

    expect(terminalState.terminalIds).toEqual(["default", "terminal-3", "terminal-2"]);
    expect(terminalState.terminalLayout).toEqual({
      type: "split",
      direction: "columns",
      ratio: 0.5,
      first: {
        type: "split",
        direction: "rows",
        ratio: 0.5,
        first: { type: "leaf", groupId: "group-default" },
        second: { type: "leaf", groupId: "group-terminal-3" },
      },
      second: { type: "leaf", groupId: "group-terminal-2" },
    });
  });

  it("updates nested terminal split ratios by layout path", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-2");
    store.newTerminal(THREAD_REF, "terminal-3");
    store.moveTerminal(THREAD_REF, "terminal-2", "default", "right");
    store.moveTerminal(THREAD_REF, "terminal-3", "default", "down");
    store.setTerminalLayoutRatio(THREAD_REF, "first", 0.3);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );

    expect(
      terminalState.terminalLayout.type === "split" &&
        terminalState.terminalLayout.first.type === "split"
        ? terminalState.terminalLayout.first.ratio
        : null,
    ).toBe(0.3);
  });

  it("splits a terminal out of its current group on side drops", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.moveTerminal(THREAD_REF, "terminal-2", "default", "right");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalPanesVisible).toBe(true);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("reorders terminal tabs in their group on center drops", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-2");
    store.newTerminal(THREAD_REF, "terminal-3");
    store.moveTerminal(THREAD_REF, "terminal-3", "default", "center");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-3", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      {
        id: "group-default",
        terminalIds: ["default", "terminal-3", "terminal-2"],
        activeTerminalId: "terminal-3",
        recentTerminalIds: ["terminal-2", "terminal-3"],
      },
    ]);
  });

  it("ensures unknown server terminals are registered, opened, and activated", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_REF, "setup-setup", { open: true, active: true });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "setup-setup"]);
    expect(terminalState.activeTerminalId).toBe("setup-setup");
    expect(terminalState.terminalGroups).toEqual([
      {
        id: "group-default",
        terminalIds: ["default", "setup-setup"],
        activeTerminalId: "setup-setup",
      },
    ]);
  });

  it("keeps state isolated per environment when raw thread ids collide", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(OTHER_THREAD_REF, "env-b-terminal");

    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).terminalOpen,
    ).toBe(true);
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        OTHER_THREAD_REF,
      ).terminalIds,
    ).toEqual(["default", "env-b-terminal"]);
  });

  it("migrates v1 persisted terminal state using the stored version", () => {
    const migrated = migratePersistedTerminalStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["default"],
            runningTerminalIds: [],
            activeTerminalId: "default",
            terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
            activeTerminalGroupId: "group-default",
          },
          "legacy-thread-id": {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["default"],
            runningTerminalIds: [],
            activeTerminalId: "default",
            terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
            activeTerminalGroupId: "group-default",
          },
        },
      },
      1,
    );

    expect(migrated).toEqual({
      terminalStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          entryPoint: "chat",
          terminalOpen: true,
          terminalHeight: 320,
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
          terminalLayout: { type: "leaf", groupId: "group-default" },
          terminalPanesVisible: false,
          terminalGroupSplitLayout: "columns",
        },
      },
    });
  });

  it("migrates legacy in-group split panes into layout groups", () => {
    const migrated = migratePersistedTerminalStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["default", "terminal-2"],
            runningTerminalIds: [],
            activeTerminalId: "terminal-2",
            terminalGroups: [{ id: "group-default", terminalIds: ["default", "terminal-2"] }],
            activeTerminalGroupId: "group-default",
            terminalPanesVisible: true,
            terminalGroupSplitLayout: "rows",
          },
        },
      },
      4,
    );

    expect(migrated.terminalStateByThreadKey?.[scopedThreadKey(THREAD_REF)]).toMatchObject({
      terminalGroups: [
        { id: "group-default", terminalIds: ["default"] },
        { id: "group-terminal-2", terminalIds: ["terminal-2"] },
      ],
      terminalLayout: {
        type: "split",
        direction: "rows",
        first: { type: "leaf", groupId: "group-default" },
        second: { type: "leaf", groupId: "group-terminal-2" },
      },
      terminalPanesVisible: true,
    });
  });

  it("migrates legacy unsplit groups into tabs in one pane", () => {
    const migrated = migratePersistedTerminalStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["default", "terminal-2"],
            runningTerminalIds: [],
            activeTerminalId: "terminal-2",
            terminalGroups: [
              { id: "group-default", terminalIds: ["default"] },
              { id: "group-terminal-2", terminalIds: ["terminal-2"] },
            ],
            activeTerminalGroupId: "group-terminal-2",
            terminalPanesVisible: false,
          },
        },
      },
      4,
    );

    expect(migrated.terminalStateByThreadKey?.[scopedThreadKey(THREAD_REF)]).toMatchObject({
      terminalGroups: [
        {
          id: "group-default",
          terminalIds: ["default", "terminal-2"],
          activeTerminalId: "terminal-2",
        },
      ],
      activeTerminalGroupId: "group-default",
      terminalLayout: { type: "leaf", groupId: "group-default" },
      terminalPanesVisible: false,
    });
  });

  it("returns a stable normalized object for legacy in-memory terminal state", () => {
    const legacyState = {
      terminalOpen: true,
      terminalHeight: 320,
      terminalIds: ["default", "terminal-2"],
      runningTerminalIds: [],
      activeTerminalId: "terminal-2",
      terminalGroups: [
        { id: "group-default", terminalIds: ["default"] },
        { id: "group-terminal-2", terminalIds: ["terminal-2"] },
      ],
      activeTerminalGroupId: "group-terminal-2",
    };
    const terminalStateByThreadKey = {
      [scopedThreadKey(THREAD_REF)]: legacyState as never,
    };

    const first = selectThreadTerminalState(terminalStateByThreadKey, THREAD_REF);
    const second = selectThreadTerminalState(terminalStateByThreadKey, THREAD_REF);

    expect(first).toBe(second);
    expect(first).toMatchObject({
      entryPoint: "chat",
      terminalLayout: {
        direction: "columns",
        first: { groupId: "group-default", type: "leaf" },
        ratio: 0.5,
        second: { groupId: "group-terminal-2", type: "leaf" },
        type: "split",
      },
      terminalPanesVisible: false,
      terminalGroupSplitLayout: "columns",
    });
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.setTerminalActivity(THREAD_REF, "terminal-2", true);
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(THREAD_REF, "terminal-2", false);
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).runningTerminalIds,
    ).toEqual([]);
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_REF, "default");

    expect(
      useTerminalStateStore.getState().terminalStateByThreadKey[scopedThreadKey(THREAD_REF)],
    ).toBeUndefined();
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["default"]);
  });

  it("keeps terminal thread surfaces open when closing their last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_REF);
    store.closeTerminal(THREAD_REF, "default");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default"]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.closeTerminal(THREAD_REF, "terminal-3");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("buffers terminal events outside persisted terminal UI state", () => {
    const store = useTerminalStateStore.getState();
    store.recordTerminalEvent(THREAD_REF, makeTerminalEvent("output"));
    store.recordTerminalEvent(THREAD_REF, makeTerminalEvent("activity"));

    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_REF,
      "default",
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.event.type)).toEqual(["output", "activity"]);
  });

  it("applies started terminal events to terminal state, launch context, and event buffer", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("started", {
        terminalId: "setup-bootstrap",
        snapshot: {
          threadId: THREAD_ID,
          terminalId: "setup-bootstrap",
          cwd: "/tmp/worktree",
          worktreePath: "/tmp/worktree",
          status: "running",
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-02T20:00:00.000Z",
        },
      }),
    );

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_REF,
      "setup-bootstrap",
    );

    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.activeTerminalId).toBe("setup-bootstrap");
    expect(terminalState.terminalIds).toEqual(["default", "setup-bootstrap"]);
    expect(
      useTerminalStateStore.getState().terminalLaunchContextByThreadKey[
        scopedThreadKey(THREAD_REF)
      ],
    ).toEqual({
      cwd: "/tmp/worktree",
      worktreePath: "/tmp/worktree",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event.type).toBe("started");
  });

  it("applies activity and exited terminal events to subprocess state while buffering events", () => {
    const store = useTerminalStateStore.getState();
    store.ensureTerminal(THREAD_REF, "terminal-2", { open: true, active: true });

    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("activity", {
        terminalId: "terminal-2",
        hasRunningSubprocess: true,
      }),
    );
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        THREAD_REF,
      ).runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.applyTerminalEvent(
      THREAD_REF,
      makeTerminalEvent("exited", {
        terminalId: "terminal-2",
        exitCode: 0,
        exitSignal: null,
      }),
    );

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      THREAD_REF,
    );
    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_REF,
      "terminal-2",
    );

    expect(terminalState.runningTerminalIds).toEqual([]);
    expect(entries.map((entry) => entry.event.type)).toEqual(["activity", "exited"]);
  });

  it("clears buffered terminal events when a thread terminal state is removed", () => {
    const store = useTerminalStateStore.getState();
    store.recordTerminalEvent(THREAD_REF, makeTerminalEvent("output"));
    store.removeTerminalState(THREAD_REF);

    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_REF,
      "default",
    );

    expect(entries).toEqual([]);
  });

  it("is a no-op when clearing terminal state for a thread with no state or buffered events", () => {
    const store = useTerminalStateStore.getState();
    const before = useTerminalStateStore.getState();

    store.clearTerminalState(THREAD_REF);

    expect(useTerminalStateStore.getState()).toBe(before);
  });
});
