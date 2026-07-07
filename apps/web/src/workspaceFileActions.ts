import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "./rightPanelStore";

interface OpenWorkspaceFileInput {
  readonly threadRef: ScopedThreadRef | null | undefined;
  /** Workspace-relative path, or null when the target lives outside the workspace. */
  readonly workspaceRelativePath: string | null;
  readonly line?: number | undefined;
  /** Invoked when the file can't be shown in zrode's in-app preview. */
  readonly openInEditor: () => void;
}

// Opens a file in zrode's in-app preview (the right panel) when it resolves to a
// workspace-relative path, otherwise falls back to the user's external editor.
// Shared by the terminal, diff, and chat markdown surfaces so the "preview vs
// editor" decision lives in exactly one place.
export function openWorkspaceFileOrEditor({
  threadRef,
  workspaceRelativePath,
  line,
  openInEditor,
}: OpenWorkspaceFileInput): void {
  if (threadRef && workspaceRelativePath) {
    useRightPanelStore.getState().openFile(threadRef, workspaceRelativePath, line);
    return;
  }
  openInEditor();
}
