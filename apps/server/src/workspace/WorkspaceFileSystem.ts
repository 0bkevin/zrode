// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - safe, revisioned workspace file reads and writes.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  ProjectFileDiskRevision,
  ProjectWriteFilePrecondition,
  type ProjectCreateDirectoryInput,
  type ProjectCreateDirectoryResult,
  type ProjectDeleteEntryInput,
  type ProjectDeleteEntryResult,
  type ProjectPrepareDeleteEntryInput,
  type ProjectPrepareDeleteEntryResult,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TxReentrantLock from "effect/TxReentrantLock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { appendBoundedBytes, decodeBoundedBytes } from "../process/boundedOutput.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;
const REVISION_READ_BUFFER_BYTES = 64 * 1024;
const CREATE_DIRECTORY_STDERR_MAX_BYTES = 4_096;
const CREATE_DIRECTORY_HELPER_MAX_CONCURRENCY = 4;
const ENTRY_TREE_REVISION_CONCURRENCY = 32;
const CREATE_DIRECTORY_EXIT_ALREADY_EXISTS = ChildProcessSpawner.ExitCode(17);
const CREATE_DIRECTORY_EXIT_PARENT_CHANGED = ChildProcessSpawner.ExitCode(18);
const CREATE_DIRECTORY_HELPER_SOURCE = String.raw`
import * as fs from "node:fs/promises";

const [basename, expectedDevice, expectedInode] = process.argv.slice(-3);
const fail = (code, message) => {
  process.stderr.write(String(message).slice(0, 512));
  process.exitCode = code;
};

if (!basename || basename === "." || basename === ".." || basename.includes("/") || basename.includes("\\")) {
  fail(19, "INVALID_BASENAME");
} else {
  try {
    const parent = await fs.stat(".", { bigint: true });
    if (!parent.isDirectory() || parent.dev.toString() !== expectedDevice || parent.ino.toString() !== expectedInode) {
      fail(18, "PARENT_IDENTITY_MISMATCH");
    } else {
      try {
        await fs.mkdir(basename);
      } catch (cause) {
        if (cause && typeof cause === "object" && cause.code === "EEXIST") {
          fail(17, "EEXIST");
        } else {
          fail(20, cause && typeof cause === "object" && "code" in cause ? cause.code : "MKDIR_FAILED");
        }
      }
    }
  } catch (cause) {
    fail(20, cause && typeof cause === "object" && "code" in cause ? cause.code : "STAT_FAILED");
  }
}
`;
const READ_NO_FOLLOW_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW === undefined ? 0 : NodeFS.constants.O_NOFOLLOW);

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
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
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotDirectoryError extends Schema.TaggedErrorClass<WorkspacePathNotDirectoryError>()(
  "WorkspacePathNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a directory: ${this.resolvedPath}`;
  }
}

export class WorkspacePathAlreadyExistsError extends Schema.TaggedErrorClass<WorkspacePathAlreadyExistsError>()(
  "WorkspacePathAlreadyExistsError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' already exists in '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspaceDirectoryParentChangedError extends Schema.TaggedErrorClass<WorkspaceDirectoryParentChangedError>()(
  "WorkspaceDirectoryParentChangedError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    initialParentPath: Schema.String,
    currentParentPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace directory parent changed while creating '${this.relativePath}' in '${this.workspaceRoot}'.`;
  }
}

export class WorkspaceEntryChangedError extends Schema.TaggedErrorClass<WorkspaceEntryChangedError>()(
  "WorkspaceEntryChangedError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace entry '${this.relativePath}' changed before it could be deleted.`;
  }
}

export class WorkspaceDeleteRecoveryError extends Schema.TaggedErrorClass<WorkspaceDeleteRecoveryError>()(
  "WorkspaceDeleteRecoveryError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    recoveryPath: Schema.String,
    originalPathOccupied: Schema.Boolean,
    dataMayRemainHidden: Schema.Boolean,
    deletionCause: Schema.Defect(),
    recoveryCause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.dataMayRemainHidden
      ? `Deletion failed and recovery could not expose '${this.relativePath}'. Data may remain at '${this.recoveryPath}'.`
      : `Deletion failed; the entry was recovered at '${this.recoveryPath}'.`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export class WorkspaceFileRevisionConflictError extends Schema.TaggedErrorClass<WorkspaceFileRevisionConflictError>()(
  "WorkspaceFileRevisionConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    precondition: ProjectWriteFilePrecondition,
    actualExists: Schema.Boolean,
    actualDiskRevision: Schema.NullOr(ProjectFileDiskRevision),
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' changed before it could be saved.`;
  }
}

export class WorkspaceFileContentsTooLargeError extends Schema.TaggedErrorClass<WorkspaceFileContentsTooLargeError>()(
  "WorkspaceFileContentsTooLargeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    byteLength: Schema.Number,
    maxByteLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' is ${this.byteLength} bytes; writes are limited to ${this.maxByteLength} bytes.`;
  }
}

export const WorkspaceFileOperationError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspacePathNotDirectoryError,
  WorkspacePathAlreadyExistsError,
  WorkspaceDirectoryParentChangedError,
  WorkspaceEntryChangedError,
  WorkspaceDeleteRecoveryError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileOperationError = typeof WorkspaceFileOperationError.Type;

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspacePathNotDirectoryError,
  WorkspacePathAlreadyExistsError,
  WorkspaceDirectoryParentChangedError,
  WorkspaceEntryChangedError,
  WorkspaceDeleteRecoveryError,
  WorkspaceBinaryFileError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileContentsTooLargeError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Create a directory relative to the workspace root. */
    readonly createDirectory: (
      input: ProjectCreateDirectoryInput,
    ) => Effect.Effect<
      ProjectCreateDirectoryResult,
      WorkspaceFileOperationError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Permanently delete an entry without following a final symlink. */
    readonly deleteEntry: (
      input: ProjectDeleteEntryInput,
    ) => Effect.Effect<
      ProjectDeleteEntryResult,
      WorkspaceFileOperationError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Capture the exact authoritative entry/tree revision that a user confirms. */
    readonly prepareDeleteEntry: (
      input: ProjectPrepareDeleteEntryInput,
    ) => Effect.Effect<
      ProjectPrepareDeleteEntryResult,
      WorkspaceFileOperationError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileOperationError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Atomically write a file relative to the workspace root after checking the
     * caller's disk-revision precondition.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

function isWithinRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function revisionFromBytes(bytes: Uint8Array): ProjectFileDiskRevision {
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return ProjectFileDiskRevision.make(`sha256:${digest}:${bytes.byteLength}`);
}

type CanonicalWriteTarget = {
  readonly realWorkspaceRoot: string;
  readonly canonicalTargetPath: string;
};

type WorkspaceMutationTargetInput = {
  readonly cwd: string;
  readonly relativePath: string;
};

type PreparedWriteTarget = CanonicalWriteTarget & {
  readonly canonicalTargetDirectory: string;
  readonly directoryDevice: bigint;
  readonly directoryInode: bigint;
};

type PreparedAtomicWrite = {
  readonly tempPath: string;
  readonly targetDirectory: string;
};

export interface WorkspaceFileSystemMakeOptions {
  /** Test-only publication barrier, invoked after the temporary file is durable. */
  readonly beforePublish?: (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly canonicalTargetPath: string;
  }) => Effect.Effect<void>;
  /** Test-only race barrier, invoked before the directory parent is revalidated. */
  readonly beforeCreateDirectory?: (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly canonicalTargetPath: string;
  }) => Effect.Effect<void>;
  /** Test-only race barrier, invoked after parent identity validation and before child spawn. */
  readonly afterCreateDirectoryValidation?: (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly canonicalTargetPath: string;
  }) => Effect.Effect<void>;
  /** Test-only hook, invoked while holding one bounded directory-helper permit. */
  readonly onCreateDirectoryHelperPermitAcquired?: (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly canonicalTargetPath: string;
  }) => Effect.Effect<void>;
  /** Test-only override for the maximum number of directory helpers running concurrently. */
  readonly createDirectoryHelperConcurrency?: number;
  /** Test-only hook, invoked after one complete tree revision scan. */
  readonly onEntryTreeRevisionCompleted?: (input: {
    readonly relativePath: string;
    readonly descendantCount: number;
  }) => Effect.Effect<void>;
  /** Test-only race barrier, invoked after the initial target identity check. */
  readonly beforeDelete?: (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly canonicalTargetPath: string;
  }) => Effect.Effect<void>;
  /** Test hooks for deterministic recovery-failure coverage. */
  readonly removeDeletedEntry?: (input: {
    readonly path: string;
    readonly kind: "file" | "directory";
  }) => Promise<void>;
  readonly renameDeletedEntry?: (input: {
    readonly from: string;
    readonly to: string;
    readonly purpose: "detach" | "restore" | "recover";
  }) => Promise<void>;
}

type CurrentFileState = {
  readonly canonicalTargetPath: string;
  /** Null when the caller did not request hashing or the file exceeds the editable limit. */
  readonly diskRevision: ProjectFileDiskRevision | null;
  readonly mode: number;
};

type WriteTargetLock = {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
};
type WorkspaceMutationLock = {
  readonly lock: TxReentrantLock.TxReentrantLock;
  readonly users: number;
};

export const makeWithOptions = (options: WorkspaceFileSystemMakeOptions = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const createDirectoryHelperSemaphore = yield* Semaphore.make(
      Math.max(
        1,
        Math.floor(
          options.createDirectoryHelperConcurrency ?? CREATE_DIRECTORY_HELPER_MAX_CONCURRENCY,
        ),
      ),
    );
    const writeTargetLocksRef = yield* Ref.make<ReadonlyMap<string, WriteTargetLock>>(new Map());
    const workspaceMutationLocksRef = yield* Ref.make<ReadonlyMap<string, WorkspaceMutationLock>>(
      new Map(),
    );

    const operationError = (input: {
      readonly workspaceRoot: string;
      readonly relativePath: string;
      readonly resolvedPath: string;
      readonly operationPath: string;
      readonly operation: WorkspaceFileSystemOperationError["operation"];
      readonly cause: unknown;
    }) => new WorkspaceFileSystemOperationError(input);

    const assertWithinRoot = Effect.fn("WorkspaceFileSystem.assertWithinRoot")(function* (input: {
      readonly workspaceRoot: string;
      readonly relativePath: string;
      readonly realWorkspaceRoot: string;
      readonly resolvedPath: string;
    }) {
      if (!isWithinRoot(path, input.realWorkspaceRoot, input.resolvedPath)) {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: input.realWorkspaceRoot,
          resolvedPath: input.resolvedPath,
        });
      }
    });

    const realWorkspaceRoot = Effect.fn("WorkspaceFileSystem.realWorkspaceRoot")(function* (input: {
      readonly workspaceRoot: string;
      readonly relativePath: string;
      readonly resolvedPath: string;
    }) {
      return yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.workspaceRoot),
        catch: (cause) =>
          operationError({
            ...input,
            operationPath: input.workspaceRoot,
            operation: "realpath-workspace-root",
            cause,
          }),
      });
    });

    /** Resolve existing targets, or the nearest existing ancestor for new targets. */
    const resolveCanonicalWriteTarget = Effect.fn(
      "WorkspaceFileSystem.resolveCanonicalWriteTarget",
    )(function* (input: WorkspaceMutationTargetInput, absolutePath: string) {
      const resolvedWorkspaceRoot = yield* realWorkspaceRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: absolutePath,
      });
      let probe = absolutePath;
      const missingSegments: Array<string> = [];

      while (true) {
        const exists = yield* Effect.tryPromise({
          try: () => NodeFSP.lstat(probe),
          catch: (cause) =>
            isNotFound(cause)
              ? ({ _tag: "NotFound" } as const)
              : operationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: absolutePath,
                  operationPath: probe,
                  operation: "stat",
                  cause,
                }),
        }).pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              cause._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(cause),
            onSuccess: () => Effect.succeed(true),
          }),
        );

        if (exists) {
          const realProbe = yield* Effect.tryPromise({
            try: () => NodeFSP.realpath(probe),
            catch: (cause) =>
              operationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: absolutePath,
                operationPath: probe,
                operation: "realpath-target",
                cause,
              }),
          });
          yield* assertWithinRoot({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            realWorkspaceRoot: resolvedWorkspaceRoot,
            resolvedPath: realProbe,
          });
          const canonicalTargetPath = path.resolve(realProbe, ...missingSegments);
          yield* assertWithinRoot({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            realWorkspaceRoot: resolvedWorkspaceRoot,
            resolvedPath: canonicalTargetPath,
          });
          return {
            realWorkspaceRoot: resolvedWorkspaceRoot,
            canonicalTargetPath,
          } satisfies CanonicalWriteTarget;
        }

        const parent = path.dirname(probe);
        if (parent === probe) {
          return yield* operationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: absolutePath,
            operationPath: probe,
            operation: "realpath-target",
            cause: new Error("No existing ancestor was found for the workspace target."),
          });
        }
        missingSegments.unshift(path.basename(probe));
        probe = parent;
      }
    });

    const currentFileState = Effect.fn("WorkspaceFileSystem.currentFileState")(function* (
      input: ProjectWriteFileInput,
      target: CanonicalWriteTarget,
    ) {
      const exists = yield* Effect.tryPromise({
        try: () => NodeFSP.lstat(target.canonicalTargetPath),
        catch: (cause) =>
          isNotFound(cause)
            ? ({ _tag: "NotFound" } as const)
            : operationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: target.canonicalTargetPath,
                operationPath: target.canonicalTargetPath,
                operation: "stat",
                cause,
              }),
      }).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            cause._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(cause),
          onSuccess: () => Effect.succeed(true),
        }),
      );
      if (!exists) return null;

      const canonicalTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(target.canonicalTargetPath),
        catch: (cause) =>
          operationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.canonicalTargetPath,
            operationPath: target.canonicalTargetPath,
            operation: "realpath-target",
            cause,
          }),
      });
      yield* assertWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        realWorkspaceRoot: target.realWorkspaceRoot,
        resolvedPath: canonicalTargetPath,
      });

      if (input.precondition._tag === "unconditional") {
        const stat = yield* Effect.tryPromise({
          // `lstat` deliberately avoids following a final entry swapped in
          // after canonicalization. Unconditional replacement only needs
          // existence, type, and mode; it never reads or hashes file contents.
          try: () => NodeFSP.lstat(canonicalTargetPath),
          catch: (cause) =>
            operationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: canonicalTargetPath,
              operationPath: canonicalTargetPath,
              operation: "stat",
              cause,
            }),
        });
        if (!stat.isFile()) {
          return yield* new WorkspacePathNotFileError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: canonicalTargetPath,
          });
        }
        return {
          canonicalTargetPath,
          diskRevision: null,
          mode: stat.mode & 0o7777,
        } satisfies CurrentFileState;
      }

      if (input.precondition._tag === "must-not-exist") {
        const stat = yield* Effect.tryPromise({
          try: () => NodeFSP.lstat(canonicalTargetPath),
          catch: (cause) =>
            operationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: canonicalTargetPath,
              operationPath: canonicalTargetPath,
              operation: "stat",
              cause,
            }),
        });
        if (!stat.isFile()) {
          return yield* new WorkspaceFileRevisionConflictError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: canonicalTargetPath,
            precondition: input.precondition,
            actualExists: true,
            actualDiskRevision: null,
          });
        }
      }

      const state = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(canonicalTargetPath, READ_NO_FOLLOW_FLAGS);
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) return { _tag: "NotFile" as const };

            let diskRevision: ProjectFileDiskRevision | null = null;
            if (stat.size <= PROJECT_READ_FILE_MAX_BYTES) {
              const hash = NodeCrypto.createHash("sha256");
              const buffer = Buffer.allocUnsafe(REVISION_READ_BUFFER_BYTES);
              let byteLength = 0;
              while (byteLength <= PROJECT_READ_FILE_MAX_BYTES) {
                const remaining = PROJECT_READ_FILE_MAX_BYTES + 1 - byteLength;
                const { bytesRead } = await handle.read(
                  buffer,
                  0,
                  Math.min(buffer.byteLength, remaining),
                  null,
                );
                if (bytesRead === 0) break;
                hash.update(buffer.subarray(0, bytesRead));
                byteLength += bytesRead;
              }
              if (byteLength <= PROJECT_READ_FILE_MAX_BYTES) {
                diskRevision = ProjectFileDiskRevision.make(
                  `sha256:${hash.digest("hex")}:${byteLength}`,
                );
              }
            }

            return {
              _tag: "File" as const,
              canonicalTargetPath,
              diskRevision,
              mode: stat.mode & 0o7777,
            };
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          operationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: canonicalTargetPath,
            operationPath: canonicalTargetPath,
            operation: "read",
            cause,
          }),
      });
      if (state._tag === "File") return state satisfies CurrentFileState;
      if (input.precondition._tag === "must-not-exist") {
        return yield* new WorkspaceFileRevisionConflictError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: canonicalTargetPath,
          precondition: input.precondition,
          actualExists: true,
          actualDiskRevision: null,
        });
      }
      return yield* new WorkspacePathNotFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: canonicalTargetPath,
      });
    });

    const acquireWriteTargetLock = (key: string) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const candidate = yield* Semaphore.make(1);
          return yield* Ref.modify(writeTargetLocksRef, (locks) => {
            const existing = locks.get(key);
            const semaphore = existing?.semaphore ?? candidate;
            const next = new Map(locks);
            next.set(key, { semaphore, users: (existing?.users ?? 0) + 1 });
            return [semaphore, next] as const;
          });
        }),
        () =>
          Ref.update(writeTargetLocksRef, (locks) => {
            const existing = locks.get(key);
            if (!existing) return locks;
            const next = new Map(locks);
            if (existing.users === 1) next.delete(key);
            else next.set(key, { ...existing, users: existing.users - 1 });
            return next;
          }),
      );

    const withWriteTargetLock = <A, E, R>(
      key: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.scoped(
        Effect.flatMap(acquireWriteTargetLock(key), (semaphore) => semaphore.withPermit(effect)),
      );

    const acquireWorkspaceMutationLock = (key: string) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const candidate = yield* TxReentrantLock.make();
          return yield* Ref.modify(workspaceMutationLocksRef, (locks) => {
            const existing = locks.get(key);
            const lock = existing?.lock ?? candidate;
            const next = new Map(locks);
            next.set(key, { lock, users: (existing?.users ?? 0) + 1 });
            return [lock, next] as const;
          });
        }),
        () =>
          Ref.update(workspaceMutationLocksRef, (locks) => {
            const existing = locks.get(key);
            if (!existing) return locks;
            const next = new Map(locks);
            if (existing.users === 1) next.delete(key);
            else next.set(key, { ...existing, users: existing.users - 1 });
            return next;
          }),
      );

    const withWorkspaceMutationLock = <A, E, R>(
      key: string,
      mode: "shared" | "exclusive",
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.scoped(
        Effect.flatMap(acquireWorkspaceMutationLock(key), (lock) =>
          mode === "exclusive"
            ? TxReentrantLock.withWriteLock(lock, effect)
            : TxReentrantLock.withReadLock(lock, effect),
        ),
      );

    type CanonicalDirectoryParent = {
      readonly requestedParentPath: string;
      readonly canonicalParentPath: string;
      readonly canonicalTargetPath: string;
      readonly device: bigint;
      readonly inode: bigint;
    };

    const canonicalDirectoryParent = Effect.fn("WorkspaceFileSystem.canonicalDirectoryParent")(
      function* (input: ProjectCreateDirectoryInput, absoluteTargetPath: string, root: string) {
        const requestedParentPath = path.dirname(absoluteTargetPath);
        const canonicalParentPath = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(requestedParentPath),
          catch: (cause) =>
            operationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: absoluteTargetPath,
              operationPath: requestedParentPath,
              operation: "realpath-target",
              cause,
            }),
        });
        yield* assertWithinRoot({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          realWorkspaceRoot: root,
          resolvedPath: canonicalParentPath,
        });
        const parentStat = yield* Effect.tryPromise({
          try: () => NodeFSP.stat(canonicalParentPath, { bigint: true }),
          catch: (cause) =>
            operationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: absoluteTargetPath,
              operationPath: canonicalParentPath,
              operation: "stat",
              cause,
            }),
        });
        if (!parentStat.isDirectory()) {
          return yield* new WorkspacePathNotDirectoryError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: canonicalParentPath,
          });
        }
        const canonicalTargetPath = path.join(
          canonicalParentPath,
          path.basename(absoluteTargetPath),
        );
        yield* assertWithinRoot({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          realWorkspaceRoot: root,
          resolvedPath: canonicalTargetPath,
        });
        return {
          requestedParentPath,
          canonicalParentPath,
          canonicalTargetPath,
          device: parentStat.dev,
          inode: parentStat.ino,
        } satisfies CanonicalDirectoryParent;
      },
    );

    const createDirectoryRelativeToPinnedParent = Effect.fn(
      "WorkspaceFileSystem.createDirectoryRelativeToPinnedParent",
    )(function* (input: ProjectCreateDirectoryInput, parent: CanonicalDirectoryParent) {
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              CREATE_DIRECTORY_HELPER_SOURCE,
              "--",
              path.basename(parent.canonicalTargetPath),
              parent.device.toString(),
              parent.inode.toString(),
            ],
            {
              cwd: parent.canonicalParentPath,
              env: { ELECTRON_RUN_AS_NODE: "1" },
              extendEnv: true,
            },
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            operationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: parent.canonicalTargetPath,
              operationPath: parent.canonicalParentPath,
              operation: "make-directory",
              cause,
            }),
          ),
        );
      yield* Effect.addFinalizer(() =>
        handle.isRunning.pipe(
          Effect.flatMap((running) => (running ? handle.kill() : Effect.void)),
          Effect.ignore,
        ),
      );

      const stderrRef = yield* Ref.make<Uint8Array>(new Uint8Array(0));
      const stderrFiber = yield* handle.stderr.pipe(
        Stream.runForEach((chunk) =>
          Ref.update(stderrRef, (current) =>
            appendBoundedBytes(current, chunk, CREATE_DIRECTORY_STDERR_MAX_BYTES),
          ),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );
      const stdoutFiber = yield* handle.stdout.pipe(
        Stream.runDrain,
        Effect.ignore,
        Effect.forkScoped,
      );
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError((cause) =>
          operationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: parent.canonicalTargetPath,
            operationPath: parent.canonicalParentPath,
            operation: "make-directory",
            cause,
          }),
        ),
      );
      yield* Effect.all([Fiber.join(stderrFiber), Fiber.join(stdoutFiber)], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.ignore);

      if (exitCode === ChildProcessSpawner.ExitCode(0)) return;
      if (exitCode === CREATE_DIRECTORY_EXIT_ALREADY_EXISTS) {
        return yield* new WorkspacePathAlreadyExistsError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: parent.canonicalTargetPath,
        });
      }
      if (exitCode === CREATE_DIRECTORY_EXIT_PARENT_CHANGED) {
        return yield* new WorkspaceDirectoryParentChangedError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          initialParentPath: parent.canonicalParentPath,
          currentParentPath: parent.canonicalParentPath,
        });
      }
      const detail = decodeBoundedBytes(yield* Ref.get(stderrRef)).trim();
      return yield* operationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: parent.canonicalTargetPath,
        operationPath: parent.canonicalParentPath,
        operation: "make-directory",
        cause: new Error(detail || `Directory helper exited with code ${exitCode}.`),
      });
    });

    const createDirectory: WorkspaceFileSystem["Service"]["createDirectory"] = Effect.fn(
      "WorkspaceFileSystem.createDirectory",
    )(function* (input) {
      const requestedTarget = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      const initialTarget = yield* resolveCanonicalWriteTarget(input, requestedTarget.absolutePath);

      return yield* withWorkspaceMutationLock(
        initialTarget.realWorkspaceRoot,
        "shared",
        withWriteTargetLock(
          initialTarget.canonicalTargetPath,
          Effect.gen(function* () {
            const root = yield* realWorkspaceRoot({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: requestedTarget.absolutePath,
            });
            const initialParent = yield* canonicalDirectoryParent(
              input,
              requestedTarget.absolutePath,
              root,
            );

            yield* (
              options.beforeCreateDirectory?.({
                cwd: input.cwd,
                relativePath: requestedTarget.relativePath,
                canonicalTargetPath: initialParent.canonicalTargetPath,
              }) ?? Effect.void
            );

            // Resolve and identify the parent again immediately before the only
            // mutation. A parent swapped to a symlink outside the root is rejected
            // by canonicalDirectoryParent; an in-root replacement is rejected by
            // the identity comparison.
            const finalParent = yield* canonicalDirectoryParent(
              input,
              requestedTarget.absolutePath,
              root,
            );
            if (
              finalParent.canonicalParentPath !== initialParent.canonicalParentPath ||
              finalParent.device !== initialParent.device ||
              finalParent.inode !== initialParent.inode
            ) {
              return yield* new WorkspaceDirectoryParentChangedError({
                workspaceRoot: input.cwd,
                relativePath: requestedTarget.relativePath,
                initialParentPath: initialParent.canonicalParentPath,
                currentParentPath: finalParent.canonicalParentPath,
              });
            }

            yield* (
              options.afterCreateDirectoryValidation?.({
                cwd: input.cwd,
                relativePath: requestedTarget.relativePath,
                canonicalTargetPath: finalParent.canonicalTargetPath,
              }) ?? Effect.void
            );

            // The child opens `canonicalParentPath` as its cwd, verifies the
            // pinned directory's dev+ino via stat("."), then performs one
            // non-recursive mkdir(basename). A path swapped to an outside symlink
            // before spawn therefore fails identity validation, while a swap
            // after spawn cannot redirect the relative mkdir through that path.
            // Residual platform risk: Node exposes no mkdirat(dirfd), so an actor
            // able to rename the already-pinned parent inode itself can move that
            // inode elsewhere while the child still creates inside the same inode.
            yield* createDirectoryHelperSemaphore.withPermit(
              Effect.gen(function* () {
                yield* (
                  options.onCreateDirectoryHelperPermitAcquired?.({
                    cwd: input.cwd,
                    relativePath: requestedTarget.relativePath,
                    canonicalTargetPath: finalParent.canonicalTargetPath,
                  }) ?? Effect.void
                );
                yield* Effect.scoped(createDirectoryRelativeToPinnedParent(input, finalParent));
              }),
            );

            yield* workspaceEntries
              .refresh(input.cwd)
              .pipe(
                Effect.ignoreCause({ log: true }),
                Effect.forkDetach({ startImmediately: true }),
              );
            return { relativePath: requestedTarget.relativePath };
          }),
        ),
      );
    });

    const prepareTargetDirectory = Effect.fn("WorkspaceFileSystem.prepareTargetDirectory")(
      function* (input: ProjectWriteFileInput, target: CanonicalWriteTarget) {
        const targetDirectory = path.dirname(target.canonicalTargetPath);
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(targetDirectory, { recursive: true }),
          catch: (cause) =>
            operationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.canonicalTargetPath,
              operationPath: targetDirectory,
              operation: "make-directory",
              cause,
            }),
        });
        const realTargetDirectory = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(targetDirectory),
          catch: (cause) =>
            operationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.canonicalTargetPath,
              operationPath: targetDirectory,
              operation: "realpath-target",
              cause,
            }),
        });
        yield* assertWithinRoot({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          realWorkspaceRoot: target.realWorkspaceRoot,
          resolvedPath: realTargetDirectory,
        });
        const directoryStat = yield* Effect.tryPromise({
          try: () => NodeFSP.stat(realTargetDirectory, { bigint: true }),
          catch: (cause) =>
            operationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.canonicalTargetPath,
              operationPath: realTargetDirectory,
              operation: "stat",
              cause,
            }),
        });
        if (!directoryStat.isDirectory()) {
          return yield* new WorkspacePathNotDirectoryError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetDirectory,
          });
        }
        return {
          ...target,
          canonicalTargetDirectory: realTargetDirectory,
          canonicalTargetPath: path.join(
            realTargetDirectory,
            path.basename(target.canonicalTargetPath),
          ),
          directoryDevice: directoryStat.dev,
          directoryInode: directoryStat.ino,
        } satisfies PreparedWriteTarget;
      },
    );

    const prepareAtomicWrite = Effect.fn("WorkspaceFileSystem.prepareAtomicWrite")(function* (
      input: ProjectWriteFileInput,
      canonicalTargetPath: string,
      mode: number | null,
    ) {
      const targetDirectory = path.dirname(canonicalTargetPath);
      return yield* Effect.tryPromise({
        try: async () => {
          const tempPath = path.join(
            targetDirectory,
            `.zrode-${process.pid}-${NodeCrypto.randomUUID()}.tmp`,
          );
          let handle: NodeFSP.FileHandle | null = null;
          let prepared = false;
          try {
            handle = await NodeFSP.open(tempPath, "wx", mode ?? 0o666);
            await handle.writeFile(input.contents, "utf8");
            if (mode !== null) await handle.chmod(mode);
            await handle.sync();
            await handle.close();
            handle = null;
            prepared = true;
            return { tempPath, targetDirectory } satisfies PreparedAtomicWrite;
          } finally {
            if (handle) await handle.close().catch(() => undefined);
            if (!prepared) await NodeFSP.unlink(tempPath).catch(() => undefined);
          }
        },
        catch: (cause) =>
          operationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: canonicalTargetPath,
            operationPath: canonicalTargetPath,
            operation: "write-file",
            cause,
          }),
      });
    });

    const entryTreeRevision = Effect.fn("WorkspaceFileSystem.entryTreeRevision")(function* (
      input: ProjectPrepareDeleteEntryInput,
      targetPath: string,
      root: string,
      rootCtimeOverride?: bigint,
    ) {
      return yield* Effect.tryPromise({
        try: async () => {
          const hash = NodeCrypto.createHash("sha256");
          hash.update(root);
          hash.update("\0");
          hash.update(input.relativePath);
          hash.update("\0");
          hash.update(input.expectedKind);
          hash.update(input.recursive ? "\x001" : "\x000");
          const loadEntry = async (absolutePath: string, relativePath: string) => {
            const stat = await NodeFSP.lstat(absolutePath, { bigint: true });
            const names = stat.isDirectory() ? await NodeFSP.readdir(absolutePath) : [];
            names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
            return { absolutePath, relativePath, stat, names };
          };
          let descendantCount = 0;
          const visit = async (entry: Awaited<ReturnType<typeof loadEntry>>): Promise<void> => {
            const { absolutePath, relativePath, stat, names } = entry;
            const kind = stat.isFile()
              ? "file"
              : stat.isDirectory()
                ? "directory"
                : stat.isSymbolicLink()
                  ? "symlink"
                  : "other";
            hash.update("\0");
            hash.update(relativePath);
            hash.update("\0");
            hash.update(
              `${kind}:${stat.dev.toString()}:${stat.ino.toString()}:${(relativePath === "" &&
              rootCtimeOverride !== undefined
                ? rootCtimeOverride
                : stat.ctimeNs
              ).toString()}`,
            );
            for (let offset = 0; offset < names.length; offset += ENTRY_TREE_REVISION_CONCURRENCY) {
              const children = await Promise.all(
                names
                  .slice(offset, offset + ENTRY_TREE_REVISION_CONCURRENCY)
                  .map((name) =>
                    loadEntry(
                      path.join(absolutePath, name),
                      relativePath ? `${relativePath}/${name}` : name,
                    ),
                  ),
              );
              descendantCount += children.length;
              for (const child of children) await visit(child);
            }
          };
          await visit(await loadEntry(targetPath, ""));
          return { entryRevision: hash.digest("hex"), descendantCount };
        },
        catch: (cause) =>
          operationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: targetPath,
            operationPath: targetPath,
            operation: "stat",
            cause,
          }),
      }).pipe(
        Effect.tap(
          (snapshot) =>
            options.onEntryTreeRevisionCompleted?.({
              relativePath: input.relativePath,
              descendantCount: snapshot.descendantCount,
            }) ?? Effect.void,
        ),
      );
    });

    const prepareDeleteEntry: WorkspaceFileSystem["Service"]["prepareDeleteEntry"] = Effect.fn(
      "WorkspaceFileSystem.prepareDeleteEntry",
    )(function* (input) {
      const requestedTarget = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      const root = yield* realWorkspaceRoot({
        workspaceRoot: input.cwd,
        relativePath: requestedTarget.relativePath,
        resolvedPath: requestedTarget.absolutePath,
      });
      return yield* withWorkspaceMutationLock(
        root,
        "shared",
        Effect.gen(function* () {
          const parent = yield* canonicalDirectoryParent(input, requestedTarget.absolutePath, root);
          const stat = yield* Effect.tryPromise({
            try: () => NodeFSP.lstat(parent.canonicalTargetPath, { bigint: true }),
            catch: (cause) =>
              operationError({
                workspaceRoot: input.cwd,
                relativePath: requestedTarget.relativePath,
                resolvedPath: parent.canonicalTargetPath,
                operationPath: parent.canonicalTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (input.expectedKind === "file" ? !stat.isFile() : !stat.isDirectory()) {
            return yield* input.expectedKind === "file"
              ? new WorkspacePathNotFileError({
                  workspaceRoot: input.cwd,
                  relativePath: requestedTarget.relativePath,
                  resolvedPath: parent.canonicalTargetPath,
                })
              : new WorkspacePathNotDirectoryError({
                  workspaceRoot: input.cwd,
                  relativePath: requestedTarget.relativePath,
                  resolvedPath: parent.canonicalTargetPath,
                });
          }
          const snapshot = yield* entryTreeRevision(input, parent.canonicalTargetPath, root);
          return {
            relativePath: requestedTarget.relativePath,
            expectedKind: input.expectedKind,
            recursive: input.recursive,
            ...snapshot,
          };
        }),
      );
    });

    const deleteEntry: WorkspaceFileSystem["Service"]["deleteEntry"] = Effect.fn(
      "WorkspaceFileSystem.deleteEntry",
    )(function* (input) {
      const requestedTarget = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      const root = yield* realWorkspaceRoot({
        workspaceRoot: input.cwd,
        relativePath: requestedTarget.relativePath,
        resolvedPath: requestedTarget.absolutePath,
      });
      const initialParent = yield* canonicalDirectoryParent(
        input,
        requestedTarget.absolutePath,
        root,
      );

      return yield* withWorkspaceMutationLock(
        root,
        "exclusive",
        withWriteTargetLock(
          initialParent.canonicalTargetPath,
          Effect.gen(function* () {
            const readIdentity = (targetPath: string) =>
              Effect.tryPromise({
                try: () => NodeFSP.lstat(targetPath, { bigint: true }),
                catch: (cause) =>
                  operationError({
                    workspaceRoot: input.cwd,
                    relativePath: requestedTarget.relativePath,
                    resolvedPath: initialParent.canonicalTargetPath,
                    operationPath: targetPath,
                    operation: "stat",
                    cause,
                  }),
              });
            const initialStat = yield* readIdentity(initialParent.canonicalTargetPath);
            const expectedTypeMatches =
              input.expectedKind === "file" ? initialStat.isFile() : initialStat.isDirectory();
            if (!expectedTypeMatches) {
              return yield* input.expectedKind === "file"
                ? new WorkspacePathNotFileError({
                    workspaceRoot: input.cwd,
                    relativePath: requestedTarget.relativePath,
                    resolvedPath: initialParent.canonicalTargetPath,
                  })
                : new WorkspacePathNotDirectoryError({
                    workspaceRoot: input.cwd,
                    relativePath: requestedTarget.relativePath,
                    resolvedPath: initialParent.canonicalTargetPath,
                  });
            }
            yield* (
              options.beforeDelete?.({
                cwd: input.cwd,
                relativePath: requestedTarget.relativePath,
                canonicalTargetPath: initialParent.canonicalTargetPath,
              }) ?? Effect.void
            );

            const finalParent = yield* canonicalDirectoryParent(
              input,
              requestedTarget.absolutePath,
              root,
            );
            if (
              finalParent.canonicalParentPath !== initialParent.canonicalParentPath ||
              finalParent.device !== initialParent.device ||
              finalParent.inode !== initialParent.inode
            ) {
              return yield* new WorkspaceDirectoryParentChangedError({
                workspaceRoot: input.cwd,
                relativePath: requestedTarget.relativePath,
                initialParentPath: initialParent.canonicalParentPath,
                currentParentPath: finalParent.canonicalParentPath,
              });
            }

            const finalStat = yield* readIdentity(finalParent.canonicalTargetPath);
            if (
              finalStat.dev !== initialStat.dev ||
              finalStat.ino !== initialStat.ino ||
              finalStat.isFile() !== initialStat.isFile() ||
              finalStat.isDirectory() !== initialStat.isDirectory()
            ) {
              return yield* new WorkspaceEntryChangedError({
                workspaceRoot: input.cwd,
                relativePath: requestedTarget.relativePath,
                resolvedPath: finalParent.canonicalTargetPath,
              });
            }
            const finalSnapshot = yield* entryTreeRevision(
              input,
              finalParent.canonicalTargetPath,
              root,
            );
            if (finalSnapshot.entryRevision !== input.entryRevision) {
              return yield* new WorkspaceEntryChangedError({
                workspaceRoot: input.cwd,
                relativePath: requestedTarget.relativePath,
                resolvedPath: finalParent.canonicalTargetPath,
              });
            }

            // Atomically detach the validated entry from its user-visible name.
            // Removal then operates on the private tombstone. The post-rename
            // identity check detects a final-name replacement racing the rename.
            const tombstonePath = path.join(
              finalParent.canonicalParentPath,
              `.zrode-delete-${process.pid}-${NodeCrypto.randomUUID()}`,
            );
            // Once the entry is detached, interruption must wait for removal
            // or restoration; otherwise a canceled RPC could strand a hidden
            // tombstone and make the original path appear deleted.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const renameDeletedEntry = (
                  from: string,
                  to: string,
                  purpose: "detach" | "restore" | "recover",
                ) =>
                  options.renameDeletedEntry?.({ from, to, purpose }) ?? NodeFSP.rename(from, to);
                yield* Effect.tryPromise({
                  try: () =>
                    renameDeletedEntry(finalParent.canonicalTargetPath, tombstonePath, "detach"),
                  catch: (cause) =>
                    operationError({
                      workspaceRoot: input.cwd,
                      relativePath: requestedTarget.relativePath,
                      resolvedPath: finalParent.canonicalTargetPath,
                      operationPath: finalParent.canonicalTargetPath,
                      operation: "move-entry",
                      cause,
                    }),
                });

                const recoverTombstone = (deletionCause: unknown) =>
                  Effect.promise(async () => {
                    let originalPathOccupied = true;
                    try {
                      await NodeFSP.lstat(finalParent.canonicalTargetPath);
                    } catch (cause) {
                      if (!isNotFound(cause)) throw cause;
                      originalPathOccupied = false;
                    }
                    let recoveryCause: unknown;
                    if (!originalPathOccupied) {
                      try {
                        await renameDeletedEntry(
                          tombstonePath,
                          finalParent.canonicalTargetPath,
                          "restore",
                        );
                        return { restored: true as const };
                      } catch (cause) {
                        recoveryCause = cause;
                      }
                    }
                    const basename = path.basename(finalParent.canonicalTargetPath);
                    const recoveryPath = path.join(
                      finalParent.canonicalParentPath,
                      `${basename}.zrode-recovered-${NodeCrypto.randomUUID()}`,
                    );
                    try {
                      await renameDeletedEntry(tombstonePath, recoveryPath, "recover");
                      return {
                        restored: false as const,
                        error: new WorkspaceDeleteRecoveryError({
                          workspaceRoot: input.cwd,
                          relativePath: requestedTarget.relativePath,
                          resolvedPath: finalParent.canonicalTargetPath,
                          recoveryPath,
                          originalPathOccupied,
                          dataMayRemainHidden: false,
                          deletionCause,
                          recoveryCause,
                        }),
                      };
                    } catch (cause) {
                      return {
                        restored: false as const,
                        error: new WorkspaceDeleteRecoveryError({
                          workspaceRoot: input.cwd,
                          relativePath: requestedTarget.relativePath,
                          resolvedPath: finalParent.canonicalTargetPath,
                          recoveryPath: tombstonePath,
                          originalPathOccupied,
                          dataMayRemainHidden: true,
                          deletionCause,
                          recoveryCause: cause,
                        }),
                      };
                    }
                  });

                const tombstoneStat = yield* readIdentity(tombstonePath);
                if (
                  tombstoneStat.dev !== initialStat.dev ||
                  tombstoneStat.ino !== initialStat.ino
                ) {
                  const recovery = yield* recoverTombstone(new Error("Detached identity changed."));
                  if (!recovery.restored) return yield* recovery.error;
                  return yield* new WorkspaceEntryChangedError({
                    workspaceRoot: input.cwd,
                    relativePath: requestedTarget.relativePath,
                    resolvedPath: finalParent.canonicalTargetPath,
                  });
                }
                const tombstoneSnapshot = yield* entryTreeRevision(
                  input,
                  tombstonePath,
                  root,
                  initialStat.ctimeNs,
                );
                if (tombstoneSnapshot.entryRevision !== input.entryRevision) {
                  const recovery = yield* recoverTombstone(new Error("Detached tree changed."));
                  if (!recovery.restored) return yield* recovery.error;
                  return yield* new WorkspaceEntryChangedError({
                    workspaceRoot: input.cwd,
                    relativePath: requestedTarget.relativePath,
                    resolvedPath: finalParent.canonicalTargetPath,
                  });
                }

                const deletion = yield* Effect.tryPromise({
                  try: () =>
                    options.removeDeletedEntry?.({
                      path: tombstonePath,
                      kind: input.expectedKind,
                    }) ??
                    (input.expectedKind === "directory"
                      ? NodeFSP.rm(tombstonePath, { recursive: true })
                      : NodeFSP.unlink(tombstonePath)),
                  catch: (cause) =>
                    new WorkspaceFileSystemOperationError({
                      workspaceRoot: input.cwd,
                      relativePath: requestedTarget.relativePath,
                      resolvedPath: finalParent.canonicalTargetPath,
                      operationPath: tombstonePath,
                      operation: "delete-entry",
                      cause,
                    }),
                }).pipe(Effect.result);
                if (deletion._tag === "Failure") {
                  const recovery = yield* recoverTombstone(deletion.failure);
                  if (!recovery.restored) return yield* recovery.error;
                  return yield* operationError({
                    workspaceRoot: input.cwd,
                    relativePath: requestedTarget.relativePath,
                    resolvedPath: finalParent.canonicalTargetPath,
                    operationPath: finalParent.canonicalTargetPath,
                    operation: "delete-entry",
                    cause: deletion.failure,
                  });
                }
              }),
            );

            yield* workspaceEntries
              .refresh(input.cwd)
              .pipe(
                Effect.ignoreCause({ log: true }),
                Effect.forkDetach({ startImmediately: true }),
              );
            return {
              relativePath: requestedTarget.relativePath,
              deletedKind: input.expectedKind,
            };
          }),
        ),
      );
    });

    const syncDirectoryBestEffort = (targetDirectory: string) =>
      Effect.promise(async () => {
        try {
          const directoryHandle = await NodeFSP.open(targetDirectory, "r");
          try {
            await directoryHandle.sync();
          } finally {
            await directoryHandle.close();
          }
        } catch {
          // Directory syncing is unsupported on some platforms. Publication
          // already succeeded, so durability hardening here is best effort.
        }
      });

    const updatePreparedMode = Effect.fn("WorkspaceFileSystem.updatePreparedMode")(function* (
      input: ProjectWriteFileInput,
      prepared: PreparedAtomicWrite,
      mode: number | null,
    ) {
      if (mode === null) return;
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.chmod(prepared.tempPath, mode);
          const handle = await NodeFSP.open(prepared.tempPath, "r+");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          operationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: prepared.tempPath,
            operationPath: prepared.tempPath,
            operation: "write-file",
            cause,
          }),
      });
    });

    const publishReplacement = Effect.fn("WorkspaceFileSystem.publishReplacement")(function* (
      input: ProjectWriteFileInput,
      prepared: PreparedAtomicWrite,
      canonicalTargetPath: string,
    ) {
      yield* Effect.tryPromise({
        try: () => NodeFSP.rename(prepared.tempPath, canonicalTargetPath),
        catch: (cause) =>
          operationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: canonicalTargetPath,
            operationPath: canonicalTargetPath,
            operation: "write-file",
            cause,
          }),
      });
      yield* syncDirectoryBestEffort(prepared.targetDirectory);
    });

    const publishNewFile = Effect.fn("WorkspaceFileSystem.publishNewFile")(function* (
      input: ProjectWriteFileInput,
      prepared: PreparedAtomicWrite,
      canonicalTargetPath: string,
    ) {
      const linked = yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.link(prepared.tempPath, canonicalTargetPath);
          return true;
        },
        catch: (cause) =>
          cause instanceof Error && (cause as NodeJS.ErrnoException).code === "EEXIST"
            ? ({ _tag: "CreatePublishCollision" } as const)
            : operationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: canonicalTargetPath,
                operationPath: canonicalTargetPath,
                operation: "write-file",
                cause,
              }),
      }).pipe(Effect.catchTag("CreatePublishCollision", () => Effect.succeed(false)));
      if (!linked) return false;
      yield* syncDirectoryBestEffort(prepared.targetDirectory);
      return true;
    });

    const cleanupPreparedWrite = (prepared: PreparedAtomicWrite) =>
      Effect.promise(() => NodeFSP.unlink(prepared.tempPath).catch(() => undefined));

    const revisionConflict = (
      input: ProjectWriteFileInput,
      relativePath: string,
      targetPath: string,
      current: CurrentFileState | null,
    ) =>
      new WorkspaceFileRevisionConflictError({
        workspaceRoot: input.cwd,
        relativePath,
        resolvedPath: current?.canonicalTargetPath ?? targetPath,
        precondition: input.precondition,
        actualExists: current !== null,
        actualDiskRevision: current?.diskRevision ?? null,
      });

    const preconditionFailed = (
      precondition: ProjectWriteFilePrecondition,
      current: CurrentFileState | null,
    ): boolean =>
      (precondition._tag === "match" && current?.diskRevision !== precondition.diskRevision) ||
      (precondition._tag === "must-not-exist" && current !== null);

    const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
      "WorkspaceFileSystem.readFile",
    )(function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      const resolvedWorkspaceRoot = yield* realWorkspaceRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
      });
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(target.absolutePath),
        catch: (cause) =>
          operationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "realpath-target",
            cause,
          }),
      });
      yield* assertWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        realWorkspaceRoot: resolvedWorkspaceRoot,
        resolvedPath: realTargetPath,
      });

      return yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => NodeFSP.open(realTargetPath, READ_NO_FOLLOW_FLAGS),
          catch: (cause) =>
            operationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "open",
              cause,
            }),
        }),
        (handle) =>
          Effect.gen(function* () {
            const stat = yield* Effect.tryPromise({
              try: () => handle.stat(),
              catch: (cause) =>
                operationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "stat",
                  cause,
                }),
            });
            if (!stat.isFile()) {
              return yield* new WorkspacePathNotFileError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
              });
            }

            const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
            const buffer = Buffer.alloc(bytesToRead);
            const bytesRead = yield* Effect.tryPromise({
              try: async () => {
                let offset = 0;
                while (offset < bytesToRead) {
                  const result = await handle.read(buffer, offset, bytesToRead - offset, offset);
                  if (result.bytesRead === 0) break;
                  offset += result.bytesRead;
                }
                return offset;
              },
              catch: (cause) =>
                operationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "read",
                  cause,
                }),
            });
            const fileBytes = buffer.subarray(0, bytesRead);
            if (fileBytes.includes(0)) {
              return yield* new WorkspaceBinaryFileError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
              });
            }
            const truncated = stat.size > PROJECT_READ_FILE_MAX_BYTES;
            const contents = yield* Effect.try({
              // A truncated preview may end in the middle of a valid multi-byte
              // code point. Streaming mode retains that incomplete suffix while
              // still rejecting malformed UTF-8 elsewhere in the preview.
              try: () =>
                new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fileBytes, {
                  stream: truncated,
                }),
              catch: () =>
                new WorkspaceBinaryFileError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                }),
            });

            return {
              relativePath: target.relativePath,
              contents,
              byteLength: stat.size,
              truncated,
              diskRevision: truncated ? null : revisionFromBytes(fileBytes),
            };
          }),
        (handle) =>
          Effect.tryPromise({
            try: () => handle.close(),
            catch: (cause) =>
              operationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "close",
                cause,
              }),
          }),
      );
    });

    const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
      "WorkspaceFileSystem.writeFile",
    )(function* (input) {
      const inputByteLength = Buffer.byteLength(input.contents, "utf8");
      if (inputByteLength > PROJECT_READ_FILE_MAX_BYTES) {
        return yield* new WorkspaceFileContentsTooLargeError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          byteLength: inputByteLength,
          maxByteLength: PROJECT_READ_FILE_MAX_BYTES,
        });
      }

      const requestedTarget = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      const initialTarget = yield* resolveCanonicalWriteTarget(input, requestedTarget.absolutePath);

      return yield* withWorkspaceMutationLock(
        initialTarget.realWorkspaceRoot,
        "shared",
        withWriteTargetLock(
          initialTarget.canonicalTargetPath,
          Effect.gen(function* () {
            // Resolve again while holding the per-target lock. This catches
            // in-process creates queued behind an earlier writer and revalidates
            // canonical containment immediately before mutation.
            const target = yield* resolveCanonicalWriteTarget(input, requestedTarget.absolutePath);
            const unpreparedCurrent = yield* currentFileState(input, target);
            if (preconditionFailed(input.precondition, unpreparedCurrent)) {
              return yield* revisionConflict(
                input,
                requestedTarget.relativePath,
                target.canonicalTargetPath,
                unpreparedCurrent,
              );
            }
            const preparedTarget = yield* prepareTargetDirectory(input, target);
            const current = yield* currentFileState(input, preparedTarget);

            if (preconditionFailed(input.precondition, current)) {
              return yield* revisionConflict(
                input,
                requestedTarget.relativePath,
                preparedTarget.canonicalTargetPath,
                current,
              );
            }

            const canonicalTargetPath =
              current?.canonicalTargetPath ?? preparedTarget.canonicalTargetPath;
            const contents = Buffer.from(input.contents, "utf8");
            const diskRevision = revisionFromBytes(contents);

            const created = yield* Effect.acquireUseRelease(
              prepareAtomicWrite(input, canonicalTargetPath, current?.mode ?? null),
              (durableWrite) =>
                Effect.gen(function* () {
                  yield* (
                    options.beforePublish?.({
                      cwd: input.cwd,
                      relativePath: requestedTarget.relativePath,
                      canonicalTargetPath,
                    }) ?? Effect.void
                  );

                  // The potentially slow write and fsync are complete. Re-resolve
                  // the parent identity and re-hash the target as close as portable
                  // Node APIs permit to publication.
                  const finalTarget = yield* resolveCanonicalWriteTarget(
                    input,
                    requestedTarget.absolutePath,
                  );
                  const finalUnpreparedCurrent = yield* currentFileState(input, finalTarget);
                  if (preconditionFailed(input.precondition, finalUnpreparedCurrent)) {
                    return yield* revisionConflict(
                      input,
                      requestedTarget.relativePath,
                      finalTarget.canonicalTargetPath,
                      finalUnpreparedCurrent,
                    );
                  }
                  const finalPreparedTarget = yield* prepareTargetDirectory(input, finalTarget);
                  const finalCurrent = yield* currentFileState(input, finalPreparedTarget);
                  const targetIdentityChanged =
                    finalPreparedTarget.canonicalTargetPath !==
                      preparedTarget.canonicalTargetPath ||
                    finalPreparedTarget.canonicalTargetDirectory !==
                      preparedTarget.canonicalTargetDirectory ||
                    finalPreparedTarget.directoryDevice !== preparedTarget.directoryDevice ||
                    finalPreparedTarget.directoryInode !== preparedTarget.directoryInode;
                  if (
                    targetIdentityChanged ||
                    preconditionFailed(input.precondition, finalCurrent)
                  ) {
                    return yield* revisionConflict(
                      input,
                      requestedTarget.relativePath,
                      finalPreparedTarget.canonicalTargetPath,
                      finalCurrent,
                    );
                  }

                  yield* updatePreparedMode(input, durableWrite, finalCurrent?.mode ?? null);
                  if (finalCurrent === null) {
                    const published = yield* publishNewFile(
                      input,
                      durableWrite,
                      finalPreparedTarget.canonicalTargetPath,
                    );
                    if (!published) {
                      const collided = yield* currentFileState(input, finalPreparedTarget);
                      return yield* revisionConflict(
                        input,
                        requestedTarget.relativePath,
                        finalPreparedTarget.canonicalTargetPath,
                        collided,
                      );
                    }
                    return true;
                  }

                  yield* publishReplacement(input, durableWrite, finalCurrent.canonicalTargetPath);
                  return false;
                }),
              cleanupPreparedWrite,
            );

            if (created) {
              yield* workspaceEntries
                .refresh(input.cwd)
                .pipe(
                  Effect.ignoreCause({ log: true }),
                  Effect.forkDetach({ startImmediately: true }),
                );
            }

            return {
              relativePath: requestedTarget.relativePath,
              diskRevision,
              created,
            };
          }),
        ),
      );
    });

    return WorkspaceFileSystem.of({
      createDirectory,
      deleteEntry,
      prepareDeleteEntry,
      readFile,
      writeFile,
    });
  });

export const make = makeWithOptions();

export const layer = Layer.effect(WorkspaceFileSystem, make);
