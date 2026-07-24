import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/zrode/checkpoints";
export const LEGACY_T3_CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

const READABLE_CHECKPOINT_REF_PATTERN =
  /^(refs\/(?:zrode|t3)\/checkpoints)\/([A-Za-z0-9_-]+)\/(?:turn|baseline)\/[0-9]+$/u;

function checkpointFamilyForThread(
  checkpointRef: CheckpointRef,
  threadId: ThreadId,
): string | null {
  const match = READABLE_CHECKPOINT_REF_PATTERN.exec(checkpointRef);
  if (!match?.[1] || match[2] !== Encoding.encodeBase64Url(threadId)) {
    return null;
  }
  return match[1];
}

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

/**
 * The immutable workspace snapshot taken immediately before a turn starts.
 *
 * This is intentionally separate from the completed-turn checkpoint ref. A
 * completed checkpoint must stay immutable so older turn diffs and reverts do
 * not change when the workspace is edited between turns.
 */
export function checkpointBaselineRefForThreadTurn(
  threadId: ThreadId,
  turnCount: number,
): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/baseline/${turnCount}`,
  );
}

/**
 * Resolve a completed-turn ref in the same known Zrode/T3 family as a stored
 * ref. This is read compatibility only: new captures always use refs/zrode.
 */
export function checkpointRefForThreadTurnInManagedFamily(
  managedRef: CheckpointRef,
  threadId: ThreadId,
  turnCount: number,
): CheckpointRef | null {
  const family = checkpointFamilyForThread(managedRef, threadId);
  return family === null
    ? null
    : CheckpointRef.make(`${family}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`);
}

/**
 * Resolve an immutable pre-turn baseline in the same known Zrode/T3 family as
 * a stored completed-turn ref.
 */
export function checkpointBaselineRefForThreadTurnInManagedFamily(
  managedRef: CheckpointRef,
  threadId: ThreadId,
  turnCount: number,
): CheckpointRef | null {
  const family = checkpointFamilyForThread(managedRef, threadId);
  return family === null
    ? null
    : CheckpointRef.make(`${family}/${Encoding.encodeBase64Url(threadId)}/baseline/${turnCount}`);
}

/** True only for refs owned by Zrode and therefore safe for Zrode to delete. */
export function isZrodeCheckpointRef(checkpointRef: CheckpointRef, threadId?: ThreadId): boolean {
  const prefix = `${CHECKPOINT_REFS_PREFIX}/`;
  if (!checkpointRef.startsWith(prefix)) {
    return false;
  }
  if (threadId === undefined) {
    return READABLE_CHECKPOINT_REF_PATTERN.test(checkpointRef);
  }
  return checkpointFamilyForThread(checkpointRef, threadId) === CHECKPOINT_REFS_PREFIX;
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
