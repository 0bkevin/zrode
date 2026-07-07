import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";
import { openWorkspaceFileOrEditor } from "./workspaceFileActions";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("openWorkspaceFileOrEditor", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {} });
  });

  it("opens in-workspace files in the in-app preview and reveals the line", () => {
    const openInEditor = vi.fn();

    openWorkspaceFileOrEditor({
      threadRef: THREAD_REF,
      workspaceRelativePath: "src/main.ts",
      line: 42,
      openInEditor,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:src/main.ts",
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("falls back to the editor when there is no thread context", () => {
    const openInEditor = vi.fn();

    openWorkspaceFileOrEditor({
      threadRef: null,
      workspaceRelativePath: "src/main.ts",
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledOnce();
  });

  it("falls back to the editor for paths outside the workspace", () => {
    const openInEditor = vi.fn();

    openWorkspaceFileOrEditor({
      threadRef: THREAD_REF,
      workspaceRelativePath: null,
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledOnce();
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ isOpen: false });
  });
});
