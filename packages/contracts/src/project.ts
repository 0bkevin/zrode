import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_FILE_CONTENT_MAX_LENGTH = 10 * 1024 * 1024;

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
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const ProjectRelativePath = Schema.String.check(
  Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH),
);

const ProjectNonEmptyRelativePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH),
);

const ProjectFileKind = Schema.Literals(["file", "directory"]);

export const ProjectPathInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectRelativePath,
});
export type ProjectPathInput = typeof ProjectPathInput.Type;

export const ProjectReadFileInput = ProjectPathInput;
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: ProjectRelativePath,
  content: Schema.String.check(Schema.isMaxLength(PROJECT_FILE_CONTENT_MAX_LENGTH)),
  isBinary: Schema.Boolean,
  isImage: Schema.optional(Schema.Boolean),
  mimeType: Schema.optional(TrimmedNonEmptyString),
  size: Schema.Number,
  truncated: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectReadDirInput = ProjectPathInput;
export type ProjectReadDirInput = typeof ProjectReadDirInput.Type;

export const ProjectDirEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: ProjectFileKind,
  relativePath: ProjectRelativePath,
  isSymlink: Schema.Boolean,
});
export type ProjectDirEntry = typeof ProjectDirEntry.Type;

export const ProjectReadDirResult = Schema.Struct({
  relativePath: ProjectRelativePath,
  entries: Schema.Array(ProjectDirEntry),
});
export type ProjectReadDirResult = typeof ProjectReadDirResult.Type;

export const ProjectStatInput = ProjectPathInput;
export type ProjectStatInput = typeof ProjectStatInput.Type;

export const ProjectStatResult = Schema.Struct({
  relativePath: ProjectRelativePath,
  size: Schema.Number,
  isDirectory: Schema.Boolean,
  mtime: Schema.Number,
});
export type ProjectStatResult = typeof ProjectStatResult.Type;

export const ProjectCreatePathInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectNonEmptyRelativePath,
});
export type ProjectCreatePathInput = typeof ProjectCreatePathInput.Type;

export const ProjectRenamePathInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  oldRelativePath: ProjectNonEmptyRelativePath,
  newRelativePath: ProjectNonEmptyRelativePath,
});
export type ProjectRenamePathInput = typeof ProjectRenamePathInput.Type;

export const ProjectCopyPathInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceRelativePath: ProjectNonEmptyRelativePath,
  destinationRelativePath: ProjectNonEmptyRelativePath,
});
export type ProjectCopyPathInput = typeof ProjectCopyPathInput.Type;

export const ProjectDeletePathInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectNonEmptyRelativePath,
  recursive: Schema.optional(Schema.Boolean),
});
export type ProjectDeletePathInput = typeof ProjectDeletePathInput.Type;

export const ProjectPathResult = Schema.Struct({
  relativePath: ProjectRelativePath,
});
export type ProjectPathResult = typeof ProjectPathResult.Type;

export class ProjectFileSystemError extends Schema.TaggedErrorClass<ProjectFileSystemError>()(
  "ProjectFileSystemError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
