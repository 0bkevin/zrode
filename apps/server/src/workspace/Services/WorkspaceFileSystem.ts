/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ProjectCopyPathInput,
  ProjectCreatePathInput,
  ProjectDeletePathInput,
  ProjectPathResult,
  ProjectReadDirInput,
  ProjectReadDirResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenamePathInput,
  ProjectStatInput,
  ProjectStatResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@zrode/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * WorkspaceFileSystemShape - Service API for workspace-relative file operations.
 */
export interface WorkspaceFileSystemShape {
  readonly readDir: (
    input: ProjectReadDirInput,
  ) => Effect.Effect<
    ProjectReadDirResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  readonly readFile: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<
    ProjectReadFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  readonly statPath: (
    input: ProjectStatInput,
  ) => Effect.Effect<ProjectStatResult, WorkspaceFileSystemError | WorkspacePathOutsideRootError>;

  /**
   * Write a file relative to the workspace root.
   *
   * Creates parent directories as needed and rejects paths that escape the
   * workspace root.
   */
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  readonly createFile: (
    input: ProjectCreatePathInput,
  ) => Effect.Effect<ProjectPathResult, WorkspaceFileSystemError | WorkspacePathOutsideRootError>;

  readonly createDirectory: (
    input: ProjectCreatePathInput,
  ) => Effect.Effect<ProjectPathResult, WorkspaceFileSystemError | WorkspacePathOutsideRootError>;

  readonly renamePath: (
    input: ProjectRenamePathInput,
  ) => Effect.Effect<ProjectPathResult, WorkspaceFileSystemError | WorkspacePathOutsideRootError>;

  readonly copyPath: (
    input: ProjectCopyPathInput,
  ) => Effect.Effect<ProjectPathResult, WorkspaceFileSystemError | WorkspacePathOutsideRootError>;

  readonly deletePath: (
    input: ProjectDeletePathInput,
  ) => Effect.Effect<ProjectPathResult, WorkspaceFileSystemError | WorkspacePathOutsideRootError>;
}

/**
 * WorkspaceFileSystem - Service tag for workspace file operations.
 */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("zrode/workspace/Services/WorkspaceFileSystem") {}
