import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectFileEvent, ProjectListEntriesResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef } from "react";

import { projectEnvironment } from "~/state/projects";

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function getProjectEntriesQueryAtom(environmentId: EnvironmentId, cwd: string) {
  return projectEnvironment.listEntries({ environmentId, input: { cwd } });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath },
  });
}

function errorMessage<A>(result: AsyncResult.AsyncResult<A, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

export function shouldRefreshProjectEntries(event: ProjectFileEvent): boolean {
  return event.type !== "changed" || event.structuralPaths.length > 0;
}

export interface ProjectEntriesRefreshDecision {
  readonly sequence: number | null;
  readonly shouldRefresh: boolean;
}

export function projectEntriesRefreshDecision(
  previousSequence: number | null,
  event: ProjectFileEvent,
): ProjectEntriesRefreshDecision {
  if (!("sequence" in event)) {
    return { sequence: null, shouldRefresh: true };
  }
  const sequenceWasSkippedOrReset =
    previousSequence === null ||
    event.sequence > previousSequence + 1 ||
    event.sequence < previousSequence;
  return {
    sequence: event.sequence,
    shouldRefresh: sequenceWasSkippedOrReset || shouldRefreshProjectEntries(event),
  };
}

export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const atom = getProjectEntriesQueryAtom(environmentId, cwd);
  const result = useAtomValue(atom);
  const fileEventResult = useAtomValue(
    projectEnvironment.fileEvents({ environmentId, input: { cwd } }),
  );
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  const latestFileEvent = Option.getOrNull(AsyncResult.value(fileEventResult));
  const eventSequenceRef = useRef<{
    readonly queryKey: string;
    sequence: number | null;
  } | null>(null);
  const queryKey = `${environmentId}\0${cwd}`;

  useEffect(() => {
    const sequenceState = eventSequenceRef.current;
    const previousSequence = sequenceState?.queryKey === queryKey ? sequenceState.sequence : null;
    if (latestFileEvent === null || latestFileEvent.cwd !== cwd) {
      if (sequenceState?.queryKey !== queryKey) {
        eventSequenceRef.current = { queryKey, sequence: null };
      }
      return;
    }
    const decision = projectEntriesRefreshDecision(previousSequence, latestFileEvent);
    eventSequenceRef.current = { queryKey, sequence: decision.sequence };
    if (decision.shouldRefresh) {
      refreshAtom();
    }
  }, [cwd, latestFileEvent, queryKey, refreshAtom]);

  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}
