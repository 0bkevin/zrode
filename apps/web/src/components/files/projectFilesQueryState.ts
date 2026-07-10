import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectFileEvent, ProjectListEntriesResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

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

  useEffect(() => {
    if (latestFileEvent !== null && shouldRefreshProjectEntries(latestFileEvent)) {
      refreshAtom();
    }
  }, [latestFileEvent, refreshAtom]);

  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}
