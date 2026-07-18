import {
  WS_METHODS,
  type ProjectSearchTextEvent,
  type ProjectSearchTextMatch,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcStreamQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export interface ProjectSearchTextSnapshot {
  readonly matches: ReadonlyArray<ProjectSearchTextMatch>;
  readonly matchCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly complete: boolean;
}

export const EMPTY_PROJECT_SEARCH_TEXT_SNAPSHOT: ProjectSearchTextSnapshot = Object.freeze({
  matches: [],
  matchCount: 0,
  fileCount: 0,
  truncated: false,
  complete: false,
});

export function applyProjectSearchTextEvent(
  current: ProjectSearchTextSnapshot,
  event: ProjectSearchTextEvent,
): ProjectSearchTextSnapshot {
  if (event.type === "matches") {
    return { ...current, matches: [...current.matches, ...event.matches] };
  }
  return {
    ...current,
    matchCount: event.matchCount,
    fileCount: event.fileCount,
    truncated: event.truncated,
    complete: true,
  };
}

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
    }),
    searchText: createEnvironmentRpcStreamQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-text",
      tag: WS_METHODS.projectsSearchText,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(Stream.scan(EMPTY_PROJECT_SEARCH_TEXT_SNAPSHOT, applyProjectSearchTextEvent)),
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    listDirectory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-directory",
      tag: WS_METHODS.projectsListDirectory,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    inspectFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:inspect-file",
      tag: WS_METHODS.projectsInspectFile,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    fileEvents: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:projects:file-events",
      tag: WS_METHODS.projectsWatchFiles,
      idleTtlMs: 1_000,
    }),
    createDirectory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:create-directory",
      tag: WS_METHODS.projectsCreateDirectory,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
    copyFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:copy-file",
      tag: WS_METHODS.projectsCopyFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.destinationDirectoryRelativePath]),
      },
    }),
    deleteEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:delete-entry",
      tag: WS_METHODS.projectsDeleteEntry,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
    prepareDeleteEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:prepare-delete-entry",
      tag: WS_METHODS.projectsPrepareDeleteEntry,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
  };
}
