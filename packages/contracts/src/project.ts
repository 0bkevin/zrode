import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_TEXT_MAX_LIMIT = 2_000;
export const PROJECT_SEARCH_TEXT_MAX_PATTERNS_PER_LIST = 32;
export const PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH = 512;
export const PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH = 256;
const PROJECT_SEARCH_TEXT_PREVIEW_MAX_LENGTH = 4_096;
export const PROJECT_WORKSPACE_RELATIVE_PATH_MAX_CODE_UNITS = 512;
export const PROJECT_WORKSPACE_RELATIVE_PATH_MAX_BYTES = 1_024;
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
  path: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WORKSPACE_RELATIVE_PATH_MAX_CODE_UNITS),
  ),
  kind: ProjectEntryKind,
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

const ProjectSearchTextGlob = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH),
);

export const ProjectSearchTextInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH),
  ),
  isRegex: Schema.Boolean,
  matchCase: Schema.Boolean,
  wholeWord: Schema.Boolean,
  includes: Schema.Array(ProjectSearchTextGlob).check(
    Schema.isMaxLength(PROJECT_SEARCH_TEXT_MAX_PATTERNS_PER_LIST),
  ),
  excludes: Schema.Array(ProjectSearchTextGlob).check(
    Schema.isMaxLength(PROJECT_SEARCH_TEXT_MAX_PATTERNS_PER_LIST),
  ),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_TEXT_MAX_LIMIT)),
});
export type ProjectSearchTextInput = typeof ProjectSearchTextInput.Type;

/**
 * A single ripgrep match. Columns are one-based UTF-16 code-unit offsets.
 * `lineText` may be a bounded preview that begins at `lineTextStartColumn`.
 */
export const ProjectSearchTextMatch = Schema.Struct({
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WORKSPACE_RELATIVE_PATH_MAX_CODE_UNITS),
  ),
  line: PositiveInt,
  column: PositiveInt,
  endColumn: PositiveInt,
  lineTextStartColumn: PositiveInt,
  lineText: Schema.String.check(Schema.isMaxLength(PROJECT_SEARCH_TEXT_PREVIEW_MAX_LENGTH)),
  matchText: Schema.String.check(Schema.isMaxLength(PROJECT_SEARCH_TEXT_PREVIEW_MAX_LENGTH)),
});
export type ProjectSearchTextMatch = typeof ProjectSearchTextMatch.Type;

export const ProjectSearchTextEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("matches"),
    matches: Schema.Array(ProjectSearchTextMatch).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    matchCount: NonNegativeInt,
    fileCount: NonNegativeInt,
    truncated: Schema.Boolean,
  }),
]);
export type ProjectSearchTextEvent = typeof ProjectSearchTextEvent.Type;

export const ProjectSearchTextFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "spawn_failed",
  "output_parse_failed",
  "output_limit_exceeded",
  "timed_out",
  "command_failed",
]);
export type ProjectSearchTextFailure = typeof ProjectSearchTextFailure.Type;

export class ProjectSearchTextError extends Schema.TaggedErrorClass<ProjectSearchTextError>()(
  "ProjectSearchTextError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    failure: Schema.optional(ProjectSearchTextFailure),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly cwd: string;
    readonly queryLength: number;
    readonly failure: ProjectSearchTextFailure;
    readonly detail?: string;
    readonly cause?: unknown;
    readonly message?: string;
  }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to search workspace text in '${props.cwd}'.`,
    } as any);
  }
}

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
  Schema.isMaxLength(PROJECT_WORKSPACE_RELATIVE_PATH_MAX_CODE_UNITS),
);

/**
 * A lossy workspace invalidation stream. `paths` are hints, never a complete
 * journal: consumers must re-read authoritative state after every event.
 * `sequence` is monotonic within one subscription; a gap or reset means the
 * consumer must assume an invalidation was not observed.
 */
export const ProjectFileEvent = Schema.Union([
  // Legacy events did not carry a sequence. Keep decoding them during rolling
  // upgrades; consumers must conservatively treat each as a full invalidation.
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("ready"),
    cwd: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
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
    type: Schema.Literal("resync"),
    cwd: TrimmedNonEmptyString,
    reason: Schema.Literals(["overflow", "root-deleted", "watcher-error"]),
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    sequence: NonNegativeInt,
    type: Schema.Literal("ready"),
    cwd: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
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
    version: Schema.Literal(2),
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
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WORKSPACE_RELATIVE_PATH_MAX_CODE_UNITS),
  ),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectCreateDirectoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WORKSPACE_RELATIVE_PATH_MAX_CODE_UNITS),
  ),
});
export type ProjectCreateDirectoryInput = typeof ProjectCreateDirectoryInput.Type;

export const ProjectCreateDirectoryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectCreateDirectoryResult = typeof ProjectCreateDirectoryResult.Type;

/**
 * Permanently remove one workspace entry. Deletion is deliberately explicit:
 * directories require `recursive`, and every caller must acknowledge that the
 * operation does not use an operating-system trash/recycle bin.
 */
const ProjectDeleteFileSelection = Schema.Struct({
  expectedKind: Schema.Literal("file"),
  recursive: Schema.Literal(false),
});
const ProjectDeleteDirectorySelection = Schema.Struct({
  expectedKind: Schema.Literal("directory"),
  recursive: Schema.Literal(true),
});
const ProjectDeleteTarget = {
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WORKSPACE_RELATIVE_PATH_MAX_CODE_UNITS),
  ),
};

export const ProjectPrepareDeleteEntryInput = Schema.Union([
  Schema.Struct({ ...ProjectDeleteTarget, ...ProjectDeleteFileSelection.fields }),
  Schema.Struct({ ...ProjectDeleteTarget, ...ProjectDeleteDirectorySelection.fields }),
]);
export type ProjectPrepareDeleteEntryInput = typeof ProjectPrepareDeleteEntryInput.Type;

export const ProjectPrepareDeleteEntryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  expectedKind: ProjectEntryKind,
  recursive: Schema.Boolean,
  /** Opaque revision covering root/path/kind and the complete recursive tree. */
  entryRevision: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  descendantCount: NonNegativeInt,
});
export type ProjectPrepareDeleteEntryResult = typeof ProjectPrepareDeleteEntryResult.Type;

const ProjectDeleteCommit = {
  ...ProjectDeleteTarget,
  entryRevision: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  permanentlyDelete: Schema.Literal(true),
};
export const ProjectDeleteEntryInput = Schema.Union([
  Schema.Struct({ ...ProjectDeleteCommit, ...ProjectDeleteFileSelection.fields }),
  Schema.Struct({ ...ProjectDeleteCommit, ...ProjectDeleteDirectorySelection.fields }),
]);
export type ProjectDeleteEntryInput = typeof ProjectDeleteEntryInput.Type;

export const ProjectDeleteEntryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  deletedKind: ProjectEntryKind,
});
export type ProjectDeleteEntryResult = typeof ProjectDeleteEntryResult.Type;

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
  "path_already_exists",
  "directory_parent_changed",
  "entry_changed",
  "directory_not_empty",
  "delete_recovery_partial",
  "path_not_file",
  "path_not_directory",
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
  "delete-entry",
  "move-entry",
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
  readonly recoveryPath?: string;
  readonly originalPathOccupied?: boolean;
  readonly dataMayRemainHidden?: boolean;
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

export class ProjectCreateDirectoryError extends Schema.TaggedErrorClass<ProjectCreateDirectoryError>()(
  "ProjectCreateDirectoryError",
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
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to create workspace directory '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectDeleteEntryError extends Schema.TaggedErrorClass<ProjectDeleteEntryError>()(
  "ProjectDeleteEntryError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    recoveryPath: Schema.optional(TrimmedNonEmptyString),
    originalPathOccupied: Schema.optional(Schema.Boolean),
    dataMayRemainHidden: Schema.optional(Schema.Boolean),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to permanently delete workspace entry '${props.relativePath}' in '${props.cwd}'.`,
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
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WORKSPACE_RELATIVE_PATH_MAX_CODE_UNITS),
  ),
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
