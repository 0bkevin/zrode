import { scopedThreadKey } from "@zrode/client-runtime";
import type { ScopedThreadRef } from "@zrode/contracts";
import type { DraftThreadState } from "../composerDraftStore";

export function scopedThreadRefsEqual(
  left: ScopedThreadRef | null,
  right: ScopedThreadRef | null,
): boolean {
  if (!left || !right) return left === right;
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function resolveDisposableThreadRefToDispose(input: {
  previousThreadRef: ScopedThreadRef | null;
  nextThreadRef: ScopedThreadRef | null;
  previousThreadWasTemporary?: boolean;
  draftThreadsByThreadKey: Record<string, DraftThreadState | undefined>;
}): ScopedThreadRef | null {
  const previousThreadRef = input.previousThreadRef;
  if (!previousThreadRef || scopedThreadRefsEqual(previousThreadRef, input.nextThreadRef)) {
    return null;
  }
  const previousDraftThread = input.draftThreadsByThreadKey[scopedThreadKey(previousThreadRef)];
  if (input.previousThreadWasTemporary !== true && previousDraftThread?.isTemporary !== true) {
    return null;
  }
  return previousThreadRef;
}
