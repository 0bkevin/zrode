import { useAtomValue } from "@effect/atom-react";
import type {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThreadActivity,
  ScopedThreadRef,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";

interface ThreadLifecycle {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: OrchestrationSession | null;
}

export interface OptimisticThreadDispatch {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly startedAt: string;
  readonly latestTurnTurnId: TurnId | null;
  readonly latestTurnRequestedAt: string | null;
  readonly latestTurnStartedAt: string | null;
  readonly latestTurnCompletedAt: string | null;
  readonly sessionStatus: OrchestrationSession["status"] | null;
  readonly sessionUpdatedAt: string | null;
  readonly sessionLastError: string | null;
}

export type OptimisticThreadDispatches = Readonly<Record<string, OptimisticThreadDispatch>>;

export interface RegisterOptimisticThreadDispatchInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly startedAt: string;
  readonly thread: ThreadLifecycle | null;
}

export const optimisticThreadDispatchesAtom = Atom.make<OptimisticThreadDispatches>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread:optimistic-dispatches"),
);

function isAuthoritativelyBusy(thread: ThreadLifecycle | null): boolean {
  return thread?.session?.status === "starting" || thread?.session?.status === "running";
}

export function registerOptimisticThreadDispatchState(
  current: OptimisticThreadDispatches,
  input: RegisterOptimisticThreadDispatchInput,
): OptimisticThreadDispatches {
  const key = scopedThreadKey(input.environmentId, input.threadId);
  if (current[key] !== undefined || isAuthoritativelyBusy(input.thread)) {
    return current;
  }

  const latestTurn = input.thread?.latestTurn ?? null;
  const session = input.thread?.session ?? null;
  return {
    ...current,
    [key]: {
      environmentId: input.environmentId,
      threadId: input.threadId,
      commandId: input.commandId,
      messageId: input.messageId,
      startedAt: input.startedAt,
      latestTurnTurnId: latestTurn?.turnId ?? null,
      latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
      latestTurnStartedAt: latestTurn?.startedAt ?? null,
      latestTurnCompletedAt: latestTurn?.completedAt ?? null,
      sessionStatus: session?.status ?? null,
      sessionUpdatedAt: session?.updatedAt ?? null,
      sessionLastError: session?.lastError ?? null,
    },
  };
}

export function registerOptimisticThreadDispatch(
  input: RegisterOptimisticThreadDispatchInput,
): void {
  const current = appAtomRegistry.get(optimisticThreadDispatchesAtom);
  const next = registerOptimisticThreadDispatchState(current, input);
  if (next !== current) {
    appAtomRegistry.set(optimisticThreadDispatchesAtom, next);
  }
}

export interface ClearOptimisticThreadDispatchInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId?: MessageId;
  readonly commandId?: CommandId;
}

export function clearOptimisticThreadDispatchState(
  current: OptimisticThreadDispatches,
  input: ClearOptimisticThreadDispatchInput,
): OptimisticThreadDispatches {
  const key = scopedThreadKey(input.environmentId, input.threadId);
  const dispatch = current[key];
  if (
    dispatch === undefined ||
    (input.messageId !== undefined && dispatch.messageId !== input.messageId) ||
    (input.commandId !== undefined && dispatch.commandId !== input.commandId)
  ) {
    return current;
  }

  const next = { ...current };
  delete next[key];
  return next;
}

export function clearOptimisticThreadDispatch(input: ClearOptimisticThreadDispatchInput): void {
  const current = appAtomRegistry.get(optimisticThreadDispatchesAtom);
  const next = clearOptimisticThreadDispatchState(current, input);
  if (next === current) {
    return;
  }
  appAtomRegistry.set(optimisticThreadDispatchesAtom, next);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function hasMatchingProviderFailure(
  dispatch: OptimisticThreadDispatch,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "provider.turn.start.failed" || !isRecord(activity.payload)) {
      return false;
    }
    return activity.payload.messageId === dispatch.messageId;
  });
}

/**
 * True only after authoritative turn lifecycle data or a terminal provider
 * failure has replaced the local handoff. Message/queued-turn projections are
 * deliberately absent from this decision because they arrive before a turn is
 * actually starting and would create a visible idle gap.
 */
export function hasAuthoritativeOptimisticDispatchOutcome(input: {
  readonly dispatch: OptimisticThreadDispatch;
  readonly thread: ThreadLifecycle | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): boolean {
  if (hasMatchingProviderFailure(input.dispatch, input.activities)) {
    return true;
  }

  const latestTurn = input.thread?.latestTurn ?? null;
  const session = input.thread?.session ?? null;
  const latestTurnChanged =
    input.dispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.dispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.dispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.dispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (
    latestTurnChanged &&
    latestTurn !== null &&
    (latestTurn.startedAt !== null || latestTurn.completedAt !== null)
  ) {
    if (
      session?.status === "running" &&
      session.activeTurnId !== null &&
      session.activeTurnId !== latestTurn?.turnId
    ) {
      return false;
    }
    return true;
  }

  return (
    session?.status === "error" &&
    session?.lastError !== null &&
    session?.lastError !== undefined &&
    (input.dispatch.sessionLastError !== session.lastError ||
      input.dispatch.sessionStatus !== session.status)
  );
}

export function useOptimisticThreadDispatch(
  ref: ScopedThreadRef | null,
): OptimisticThreadDispatch | null {
  const dispatches = useAtomValue(optimisticThreadDispatchesAtom);
  return ref === null
    ? null
    : (dispatches[scopedThreadKey(ref.environmentId, ref.threadId)] ?? null);
}
