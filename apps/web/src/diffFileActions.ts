import type { ScopedThreadRef } from "@t3tools/contracts";

import { resolvePathLinkTarget } from "./terminal-links";
import { openWorkspaceFileOrEditor } from "./workspaceFileActions";

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly openInEditor: (targetPath: string) => void;
}

export function openDiffFilePrimaryAction({
  threadRef,
  filePath,
  activeCwd,
  openInEditor,
}: OpenDiffFilePrimaryActionInput): void {
  // Diff paths are already repo-relative, so any thread context can preview them.
  openWorkspaceFileOrEditor({
    threadRef,
    workspaceRelativePath: threadRef ? filePath : null,
    openInEditor: () =>
      openInEditor(activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath),
  });
}
