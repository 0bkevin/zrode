import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_FILE_DISK_REVISION_MAX_LENGTH = 96;
const PROJECT_FILE_EVENT_MAX_PATHS = 256;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectWatchFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectWatchFilesInput = typeof ProjectWatchFilesInput.Type;

const ProjectFileEventPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH),
);

/**
 * A lossy workspace invalidation stream. `paths` are hints, never a complete
 * journal: consumers must re-read authoritative state after every event.
 */
export const ProjectFileEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    sequence: NonNegativeInt,
    type: Schema.Literal("ready"),
    cwd: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    sequence: NonNegativeInt,
    type: Schema.Literal("changed"),
    cwd: TrimmedNonEmptyString,
    contentPaths: Schema.Array(ProjectFileEventPath).check(
      Schema.isMaxLength(PROJECT_FILE_EVENT_MAX_PATHS),
    ),
    structuralPaths: Schema.Array(ProjectFileEventPath).check(
      Schema.isMaxLength(PROJECT_FILE_EVENT_MAX_PATHS),
    ),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    sequence: NonNegativeInt,
    type: Schema.Literal("resync"),
    cwd: TrimmedNonEmptyString,
    reason: Schema.Literals(["overflow", "root-deleted", "watcher-error"]),
  }),
]);
export type ProjectFileEvent = typeof ProjectFileEvent.Type;

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The structured fields are optional on the wire so newer peers can decode legacy message-only
  // failures. New application code must provide them through this constructor.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedErrorClass<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectWatchFilesError extends Schema.TaggedErrorClass<ProjectWatchFilesError>()(
  "ProjectWatchFilesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to watch workspace files in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

/**
 * An opaque, content-addressed version of a workspace file on disk.
 *
 * Callers must treat this value as an equality token. Its concrete encoding is
 * intentionally an implementation detail of the server.
 */
export const ProjectFileDiskRevision = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_FILE_DISK_REVISION_MAX_LENGTH),
  Schema.isPattern(/^sha256:[0-9a-f]{64}:[0-9]+$/),
).pipe(Schema.brand("ProjectFileDiskRevision"));
export type ProjectFileDiskRevision = typeof ProjectFileDiskRevision.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
  diskRevision: Schema.NullOr(ProjectFileDiskRevision),
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_found",
  "path_not_file",
  "binary_file",
  "contents_too_large",
  "operation_failed",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "read",
  "close",
  "make-directory",
  "write-file",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
  readonly byteLength?: number;
  readonly maxByteLength?: number;
};

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
    byteLength: Schema.optional(NonNegativeInt),
    maxByteLength: Schema.optional(PositiveInt),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectWriteFilePrecondition = Schema.Union([
  Schema.TaggedStruct("match", {
    diskRevision: ProjectFileDiskRevision,
  }),
  Schema.TaggedStruct("must-not-exist", {}),
  Schema.TaggedStruct("unconditional", {}),
]);
export type ProjectWriteFilePrecondition = typeof ProjectWriteFilePrecondition.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
  precondition: ProjectWriteFilePrecondition,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  diskRevision: ProjectFileDiskRevision,
  created: Schema.Boolean,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileConflictError extends Schema.TaggedErrorClass<ProjectWriteFileConflictError>()(
  "ProjectWriteFileConflictError",
  {
    cwd: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
    precondition: ProjectWriteFilePrecondition,
    actualExists: Schema.Boolean,
    actualDiskRevision: Schema.NullOr(ProjectFileDiskRevision),
    message: TrimmedNonEmptyString,
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly precondition: ProjectWriteFilePrecondition;
    readonly actualExists: boolean;
    readonly actualDiskRevision: ProjectFileDiskRevision | null;
    readonly message?: string;
  }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        (props.precondition._tag === "must-not-exist"
          ? `Workspace file '${props.relativePath}' already exists.`
          : `Workspace file '${props.relativePath}' changed on disk before it could be saved.`),
    } as any);
  }
}

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
    byteLength: Schema.optional(NonNegativeInt),
    maxByteLength: Schema.optional(PositiveInt),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}
