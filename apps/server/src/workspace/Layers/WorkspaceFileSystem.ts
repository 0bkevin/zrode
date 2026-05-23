// @effect-diagnostics nodeBuiltinImport:off
import { constants } from "node:fs";
import fsPromises from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const TEXT_FILE_READ_MAX_BYTES = 512 * 1024;
const PREVIEWABLE_BINARY_MAX_BYTES = 10 * 1024 * 1024;

const PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, 8192);
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function toFilesystemError(
  cwd: string,
  relativePath: string | undefined,
  operation: string,
  cause: unknown,
): WorkspaceFileSystemError {
  return new WorkspaceFileSystemError({
    cwd,
    relativePath,
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const resolveTarget = Effect.fn("WorkspaceFileSystem.resolveTarget")(function* (
    cwd: string,
    relativePath: string,
    options?: { readonly allowRoot?: boolean },
  ) {
    const input =
      options?.allowRoot === undefined
        ? { workspaceRoot: cwd, relativePath }
        : { workspaceRoot: cwd, relativePath, allowRoot: options.allowRoot };
    return yield* workspacePaths.resolveRelativePathWithinRoot({
      ...input,
    });
  });

  const assertNoSymlinkAncestor = Effect.fn("WorkspaceFileSystem.assertNoSymlinkAncestor")(
    function* (input: {
      readonly cwd: string;
      readonly absolutePath: string;
      readonly relativePath: string;
      readonly includeLeaf: boolean;
    }) {
      const relativeToRoot = path.relative(input.cwd, input.absolutePath);
      const segments = relativeToRoot
        .split(/[\\/]+/)
        .filter((segment) => segment.length > 0 && segment !== ".");
      const segmentsToCheck = input.includeLeaf ? segments : segments.slice(0, -1);
      let current = input.cwd;
      for (const segment of segmentsToCheck) {
        current = path.join(current, segment);
        const stats = yield* Effect.tryPromise({
          try: () => fsPromises.lstat(current),
          catch: (cause) =>
            toFilesystemError(
              input.cwd,
              input.relativePath,
              "workspaceFileSystem.lstatSymlinkGuard",
              cause,
            ),
        }).pipe(
          Effect.catchIf(
            (error) => isEnoent(error.cause),
            () => Effect.succeed(null),
          ),
        );
        if (!stats) {
          return;
        }
        if (stats.isSymbolicLink()) {
          return yield* new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.symlinkGuard",
            detail: `Symbolic links are not supported for workspace file operations: ${input.relativePath}`,
          });
        }
      }
    },
  );

  const assertPathDoesNotExist = Effect.fn("WorkspaceFileSystem.assertPathDoesNotExist")(function* (
    cwd: string,
    relativePath: string,
    absolutePath: string,
  ) {
    const exists = yield* Effect.tryPromise({
      try: () => fsPromises.lstat(absolutePath),
      catch: (cause) => toFilesystemError(cwd, relativePath, "workspaceFileSystem.lstat", cause),
    }).pipe(
      Effect.map(() => true),
      Effect.catchIf(
        (error) => isEnoent(error.cause),
        () => Effect.succeed(false),
      ),
    );
    if (exists) {
      return yield* new WorkspaceFileSystemError({
        cwd,
        relativePath,
        operation: "workspaceFileSystem.noClobber",
        detail: `A file or directory already exists at ${relativePath}`,
      });
    }
  });

  const invalidateWorkspace = (cwd: string) => workspaceEntries.invalidate(cwd);

  const readDir: WorkspaceFileSystemShape["readDir"] = Effect.fn("WorkspaceFileSystem.readDir")(
    function* (input) {
      const target = yield* resolveTarget(input.cwd, input.relativePath, { allowRoot: true });
      yield* assertNoSymlinkAncestor({
        cwd: input.cwd,
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
        includeLeaf: true,
      });
      const entries = yield* Effect.tryPromise({
        try: async () => {
          const dirents = await fsPromises.readdir(target.absolutePath, { withFileTypes: true });
          return dirents
            .filter((entry) => entry.name !== "." && entry.name !== "..")
            .map((entry) => {
              const relativePath = target.relativePath
                ? `${target.relativePath}/${entry.name}`
                : entry.name;
              return {
                name: entry.name,
                kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
                relativePath,
                isSymlink: entry.isSymbolicLink(),
              };
            })
            .sort((left, right) => {
              if (left.kind !== right.kind) {
                return left.kind === "directory" ? -1 : 1;
              }
              return left.name.localeCompare(right.name);
            });
        },
        catch: (cause) =>
          toFilesystemError(input.cwd, input.relativePath, "workspaceFileSystem.readDir", cause),
      });
      return { relativePath: target.relativePath, entries };
    },
  );

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* resolveTarget(input.cwd, input.relativePath);
      yield* assertNoSymlinkAncestor({
        cwd: input.cwd,
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
        includeLeaf: true,
      });
      const stats = yield* Effect.tryPromise({
        try: () => fsPromises.stat(target.absolutePath),
        catch: (cause) =>
          toFilesystemError(input.cwd, input.relativePath, "workspaceFileSystem.stat", cause),
      });
      if (stats.isDirectory()) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Cannot read a directory as a file.",
        });
      }

      const extension = path.extname(target.absolutePath).toLowerCase();
      const mimeType = PREVIEWABLE_BINARY_MIME_TYPES[extension];
      if (mimeType) {
        if (stats.size > PREVIEWABLE_BINARY_MAX_BYTES) {
          return yield* new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: "File is too large to preview.",
          });
        }
        const buffer = yield* Effect.tryPromise({
          try: () => fsPromises.readFile(target.absolutePath),
          catch: (cause) =>
            toFilesystemError(input.cwd, input.relativePath, "workspaceFileSystem.readFile", cause),
        });
        return {
          relativePath: target.relativePath,
          content: buffer.toString("base64"),
          isBinary: true,
          isImage: mimeType.startsWith("image/"),
          mimeType,
          size: stats.size,
          truncated: false,
        };
      }

      const readLimit = Math.min(stats.size, TEXT_FILE_READ_MAX_BYTES + 1);
      const buffer = yield* Effect.tryPromise({
        try: async () => {
          const handle = await fsPromises.open(target.absolutePath, "r");
          try {
            const content = Buffer.alloc(readLimit);
            const { bytesRead } = await handle.read(content, 0, readLimit, 0);
            return content.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          toFilesystemError(input.cwd, input.relativePath, "workspaceFileSystem.readFile", cause),
      });
      if (isBinaryBuffer(buffer)) {
        return {
          relativePath: target.relativePath,
          content: "",
          isBinary: true,
          size: stats.size,
          truncated: false,
        };
      }
      const truncated = buffer.byteLength > TEXT_FILE_READ_MAX_BYTES;
      return {
        relativePath: target.relativePath,
        content: buffer.subarray(0, TEXT_FILE_READ_MAX_BYTES).toString("utf8"),
        isBinary: false,
        size: stats.size,
        truncated,
      };
    },
  );

  const statPath: WorkspaceFileSystemShape["statPath"] = Effect.fn("WorkspaceFileSystem.statPath")(
    function* (input) {
      const target = yield* resolveTarget(input.cwd, input.relativePath, { allowRoot: true });
      yield* assertNoSymlinkAncestor({
        cwd: input.cwd,
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
        includeLeaf: true,
      });
      const stats = yield* Effect.tryPromise({
        try: () => fsPromises.stat(target.absolutePath),
        catch: (cause) =>
          toFilesystemError(input.cwd, input.relativePath, "workspaceFileSystem.stat", cause),
      });
      return {
        relativePath: target.relativePath,
        size: stats.size,
        isDirectory: stats.isDirectory(),
        mtime: stats.mtimeMs,
      };
    },
  );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* resolveTarget(input.cwd, input.relativePath);
    yield* assertNoSymlinkAncestor({
      cwd: input.cwd,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      includeLeaf: true,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  const createFile: WorkspaceFileSystemShape["createFile"] = Effect.fn(
    "WorkspaceFileSystem.createFile",
  )(function* (input) {
    const target = yield* resolveTarget(input.cwd, input.relativePath);
    yield* assertNoSymlinkAncestor({
      cwd: input.cwd,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      includeLeaf: false,
    });
    yield* fileSystem
      .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          toFilesystemError(
            input.cwd,
            input.relativePath,
            "workspaceFileSystem.makeDirectory",
            cause,
          ),
        ),
      );
    yield* Effect.tryPromise({
      try: () => fsPromises.writeFile(target.absolutePath, "", { encoding: "utf8", flag: "wx" }),
      catch: (cause) =>
        toFilesystemError(input.cwd, input.relativePath, "workspaceFileSystem.createFile", cause),
    });
    yield* invalidateWorkspace(input.cwd);
    return { relativePath: target.relativePath };
  });

  const createDirectory: WorkspaceFileSystemShape["createDirectory"] = Effect.fn(
    "WorkspaceFileSystem.createDirectory",
  )(function* (input) {
    const target = yield* resolveTarget(input.cwd, input.relativePath);
    yield* assertNoSymlinkAncestor({
      cwd: input.cwd,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      includeLeaf: false,
    });
    yield* assertPathDoesNotExist(input.cwd, target.relativePath, target.absolutePath);
    yield* fileSystem
      .makeDirectory(target.absolutePath, { recursive: false })
      .pipe(
        Effect.mapError((cause) =>
          toFilesystemError(
            input.cwd,
            input.relativePath,
            "workspaceFileSystem.createDirectory",
            cause,
          ),
        ),
      );
    yield* invalidateWorkspace(input.cwd);
    return { relativePath: target.relativePath };
  });

  const renamePath: WorkspaceFileSystemShape["renamePath"] = Effect.fn(
    "WorkspaceFileSystem.renamePath",
  )(function* (input) {
    const oldTarget = yield* resolveTarget(input.cwd, input.oldRelativePath);
    const newTarget = yield* resolveTarget(input.cwd, input.newRelativePath);
    yield* assertNoSymlinkAncestor({
      cwd: input.cwd,
      absolutePath: oldTarget.absolutePath,
      relativePath: oldTarget.relativePath,
      includeLeaf: false,
    });
    yield* assertNoSymlinkAncestor({
      cwd: input.cwd,
      absolutePath: newTarget.absolutePath,
      relativePath: newTarget.relativePath,
      includeLeaf: false,
    });
    yield* assertPathDoesNotExist(input.cwd, newTarget.relativePath, newTarget.absolutePath);
    yield* fileSystem
      .rename(oldTarget.absolutePath, newTarget.absolutePath)
      .pipe(
        Effect.mapError((cause) =>
          toFilesystemError(
            input.cwd,
            input.oldRelativePath,
            "workspaceFileSystem.renamePath",
            cause,
          ),
        ),
      );
    yield* invalidateWorkspace(input.cwd);
    return { relativePath: newTarget.relativePath };
  });

  const copyPath: WorkspaceFileSystemShape["copyPath"] = Effect.fn("WorkspaceFileSystem.copyPath")(
    function* (input) {
      const sourceTarget = yield* resolveTarget(input.cwd, input.sourceRelativePath);
      const destinationTarget = yield* resolveTarget(input.cwd, input.destinationRelativePath);
      yield* assertNoSymlinkAncestor({
        cwd: input.cwd,
        absolutePath: sourceTarget.absolutePath,
        relativePath: sourceTarget.relativePath,
        includeLeaf: true,
      });
      yield* assertNoSymlinkAncestor({
        cwd: input.cwd,
        absolutePath: destinationTarget.absolutePath,
        relativePath: destinationTarget.relativePath,
        includeLeaf: false,
      });
      yield* assertPathDoesNotExist(
        input.cwd,
        destinationTarget.relativePath,
        destinationTarget.absolutePath,
      );
      yield* fileSystem
        .makeDirectory(path.dirname(destinationTarget.absolutePath), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            toFilesystemError(
              input.cwd,
              input.destinationRelativePath,
              "workspaceFileSystem.makeDirectory",
              cause,
            ),
          ),
        );
      yield* Effect.tryPromise({
        try: async () => {
          const stats = await fsPromises.stat(sourceTarget.absolutePath);
          if (stats.isDirectory()) {
            await fsPromises.cp(sourceTarget.absolutePath, destinationTarget.absolutePath, {
              recursive: true,
              force: false,
              errorOnExist: true,
              verbatimSymlinks: true,
            });
            return;
          }
          await fsPromises.copyFile(
            sourceTarget.absolutePath,
            destinationTarget.absolutePath,
            constants.COPYFILE_EXCL,
          );
        },
        catch: (cause) =>
          toFilesystemError(
            input.cwd,
            input.sourceRelativePath,
            "workspaceFileSystem.copyPath",
            cause,
          ),
      });
      yield* invalidateWorkspace(input.cwd);
      return { relativePath: destinationTarget.relativePath };
    },
  );

  const deletePath: WorkspaceFileSystemShape["deletePath"] = Effect.fn(
    "WorkspaceFileSystem.deletePath",
  )(function* (input) {
    const target = yield* resolveTarget(input.cwd, input.relativePath);
    yield* assertNoSymlinkAncestor({
      cwd: input.cwd,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      includeLeaf: false,
    });
    yield* fileSystem
      .remove(target.absolutePath, { recursive: input.recursive === true, force: true })
      .pipe(
        Effect.mapError((cause) =>
          toFilesystemError(input.cwd, input.relativePath, "workspaceFileSystem.deletePath", cause),
        ),
      );
    yield* invalidateWorkspace(input.cwd);
    return { relativePath: target.relativePath };
  });

  return {
    readDir,
    readFile,
    statPath,
    writeFile,
    createFile,
    createDirectory,
    renamePath,
    copyPath,
    deletePath,
  } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
