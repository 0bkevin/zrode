import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectFileDiskRevision,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";

export type ProjectFileWriteRequest = {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectWriteFileInput;
};

export type ProjectFileWriter<E> = (
  request: ProjectFileWriteRequest,
) => Promise<AtomCommandResult<ProjectWriteFileResult, E>>;

export type ConfirmedProjectFileSaveOutcome<E> =
  | { readonly _tag: "Saved"; readonly value: ProjectWriteFileResult }
  | { readonly _tag: "Cancelled" }
  | {
      readonly _tag: "Failure";
      readonly result: Extract<AtomCommandResult<ProjectWriteFileResult, E>, { _tag: "Failure" }>;
    };

function existingFileConflictRevision(error: unknown): ProjectFileDiskRevision | null | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ProjectWriteFileConflictError" &&
    "actualExists" in error &&
    error.actualExists === true &&
    "actualDiskRevision" in error
  ) {
    const revision = error.actualDiskRevision;
    return typeof revision === "string" ? (revision as ProjectFileDiskRevision) : null;
  }
  return undefined;
}

/**
 * Create a workspace export without clobbering, then offer one explicit
 * replacement decision when the selected path already exists.
 */
export async function saveProjectFileWithReplaceConfirmation<E>(input: {
  readonly environmentId: EnvironmentId;
  readonly file: Omit<ProjectWriteFileInput, "precondition">;
  readonly write: ProjectFileWriter<E>;
  readonly confirmReplace: (relativePath: string) => boolean | Promise<boolean>;
}): Promise<ConfirmedProjectFileSaveOutcome<E>> {
  const initial = await input.write({
    environmentId: input.environmentId,
    input: { ...input.file, precondition: { _tag: "must-not-exist" } },
  });
  if (initial._tag === "Success") return { _tag: "Saved", value: initial.value };

  const error = squashAtomCommandFailure(initial);
  const actualDiskRevision = existingFileConflictRevision(error);
  if (actualDiskRevision === undefined) return { _tag: "Failure", result: initial };
  if (!(await input.confirmReplace(input.file.relativePath))) return { _tag: "Cancelled" };

  const replacement = await input.write({
    environmentId: input.environmentId,
    input: {
      ...input.file,
      precondition:
        actualDiskRevision === null
          ? { _tag: "unconditional" }
          : { _tag: "match", diskRevision: actualDiskRevision },
    },
  });
  return replacement._tag === "Success"
    ? { _tag: "Saved", value: replacement.value }
    : { _tag: "Failure", result: replacement };
}
