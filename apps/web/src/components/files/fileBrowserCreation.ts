export type WorkspaceCreationKind = "file" | "directory";

export interface WorkspaceCreationSession {
  readonly kind: WorkspaceCreationKind;
  readonly path: string;
  readonly status: "editing" | "committing";
}

export interface OptimisticWorkspaceEntry {
  readonly id: number;
  readonly kind: WorkspaceCreationKind;
  readonly path: string;
  readonly expiresAt: number;
}

/**
 * Pierre intentionally suppresses `onRename` when the submitted basename is
 * unchanged. Creation still needs Enter/blur to commit the provisional row.
 * Queueing the fallback lets Pierre's synchronous rename/error callbacks win;
 * only a session that remains in `editing` is an unchanged-name commit.
 */
export function queueUnchangedPierreCreationCommit(
  getSession: () => WorkspaceCreationSession | null,
  commit: (session: WorkspaceCreationSession) => void,
): void {
  queueMicrotask(() => {
    const session = getSession();
    if (session?.status === "editing") commit(session);
  });
}

export function clearFailedPierreCreation(input: {
  readonly session: WorkspaceCreationSession | null;
  readonly remove: (path: string, recursive: boolean) => void;
  readonly clearSession: () => void;
  readonly reportError: (message: string) => void;
  readonly message: string;
}): void {
  if (input.session) {
    input.remove(input.session.path, input.session.kind === "directory");
  }
  input.clearSession();
  input.reportError(input.message);
}

export function reconcileOptimisticWorkspaceEntries(
  optimisticEntries: readonly OptimisticWorkspaceEntry[],
  authoritativePaths: ReadonlySet<string>,
  now: number,
): readonly OptimisticWorkspaceEntry[] {
  return optimisticEntries.filter(
    (entry) => !authoritativePaths.has(entry.path) && entry.expiresAt > now,
  );
}
