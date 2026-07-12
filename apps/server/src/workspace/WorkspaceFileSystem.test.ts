// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { ProjectFileDiskRevision } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "zrode-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

function diskRevision(contents: string): string {
  const bytes = Buffer.from(contents, "utf8");
  return `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}:${bytes.byteLength}`;
}

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("createDirectory", () => {
    it.effect("creates one directory under an existing parent and rejects an existing target", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const created = yield* workspaceFileSystem.createDirectory({
          cwd,
          relativePath: "src/features",
        });
        const collision = yield* workspaceFileSystem
          .createDirectory({
            cwd,
            relativePath: "src/features",
          })
          .pipe(Effect.flip);

        expect(created).toEqual({ relativePath: "src/features" });
        expect(collision).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathAlreadyExistsError);
        expect((yield* fileSystem.stat(path.join(cwd, "src/features"))).type).toBe("Directory");
      }),
    );

    it.effect("treats a leading-dash directory basename as data, not a Node option", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const relativePath = "--import=zrode-must-not-load";

        const created = yield* workspaceFileSystem.createDirectory({ cwd, relativePath });

        expect(created).toEqual({ relativePath });
        expect((yield* fileSystem.stat(path.join(cwd, relativePath))).type).toBe("Directory");
      }),
    );

    it.effect("uses normalized backslash paths consistently on POSIX", () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const directory = yield* workspaceFileSystem.createDirectory({
          cwd,
          relativePath: "src\\nested",
        });
        const written = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "src\\nested\\notes.md",
          contents: "normalized\n",
          precondition: { _tag: "must-not-exist" },
        });
        const read = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src\\nested\\notes.md",
        });

        expect(directory.relativePath).toBe("src/nested");
        expect(written.relativePath).toBe("src/nested/notes.md");
        expect(read).toMatchObject({
          relativePath: "src/nested/notes.md",
          contents: "normalized\n",
        });
        expect(yield* fileSystem.exists(path.join(cwd, "src/nested/notes.md"))).toBe(true);
        expect(yield* fileSystem.exists(path.join(cwd, "src\\nested\\notes.md"))).toBe(false);
      }),
    );

    it.effect("does not create missing parent directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "missing/child" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({ operation: "realpath-target" });
        expect(yield* fileSystem.exists(path.join(cwd, "missing"))).toBe(false);
      }),
    );

    it.effect("revalidates a swapped parent before creating anything outside the workspace", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        const parent = path.join(cwd, "parent");
        yield* fileSystem.makeDirectory(parent);
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          beforeCreateDirectory: () =>
            Effect.promise(async () => {
              await NodeFSP.rename(parent, path.join(cwd, "parent-original"));
              await NodeFSP.symlink(outside, parent);
            }),
        });

        const error = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "parent/escaped" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(yield* fileSystem.exists(path.join(outside, "escaped"))).toBe(false);
      }),
    );

    it.effect("pins parent identity after validation so a final symlink swap cannot escape", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        const parent = path.join(cwd, "parent");
        const originalParent = path.join(cwd, "parent-original");
        yield* fileSystem.makeDirectory(parent);
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          afterCreateDirectoryValidation: () =>
            Effect.promise(async () => {
              await NodeFSP.rename(parent, originalParent);
              await NodeFSP.symlink(outside, parent);
            }),
        });

        const error = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "parent/escaped" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceDirectoryParentChangedError);
        expect(yield* fileSystem.exists(path.join(outside, "escaped"))).toBe(false);
        expect(yield* fileSystem.exists(path.join(originalParent, "escaped"))).toBe(false);
      }),
    );

    it.effect("rejects an in-workspace parent replacement by filesystem identity", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const parent = path.join(cwd, "parent");
        const originalParent = path.join(cwd, "parent-original");
        yield* fileSystem.makeDirectory(parent);
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          beforeCreateDirectory: () =>
            Effect.promise(async () => {
              await NodeFSP.rename(parent, originalParent);
              await NodeFSP.mkdir(parent);
            }),
        });

        const error = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "parent/child" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceDirectoryParentChangedError);
        expect(yield* fileSystem.exists(path.join(parent, "child"))).toBe(false);
        expect(yield* fileSystem.exists(path.join(originalParent, "child"))).toBe(false);
      }),
    );

    it.effect("rejects traversal and symlinks that resolve outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* fileSystem.symlink(outside, path.join(cwd, "outside-link"));

        const traversalError = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "../escape" })
          .pipe(Effect.flip);
        const symlinkError = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "outside-link/escape" })
          .pipe(Effect.flip);

        expect(traversalError).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        expect(symlinkError).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(
          yield* fileSystem
            .stat(path.join(outside, "escape"))
            .pipe(Effect.orElseSucceed(() => null)),
        ).toBeNull();
      }),
    );

    it.effect("rejects a file at the requested directory path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "occupied", "file\n");

        const error = yield* workspaceFileSystem
          .createDirectory({ cwd, relativePath: "occupied" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathAlreadyExistsError);
      }),
    );

    it.effect("serializes concurrent creation of the same target", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "shared"));

        const outcomes = yield* Effect.all(
          [1, 2].map(() =>
            workspaceFileSystem
              .createDirectory({ cwd, relativePath: "shared/directory" })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );

        expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
        const failures = outcomes.filter((outcome) => outcome._tag === "Failure");
        expect(failures).toHaveLength(1);
        expect(failures[0]?.failure).toBeInstanceOf(
          WorkspaceFileSystem.WorkspacePathAlreadyExistsError,
        );
      }),
    );

    it.effect("bounds concurrent directory helper processes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "parent"));
        const acquired = yield* Ref.make(0);
        const limitReached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          createDirectoryHelperConcurrency: 2,
          onCreateDirectoryHelperPermitAcquired: () =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(acquired, (value) => value + 1);
              if (count === 2) yield* Deferred.succeed(limitReached, undefined);
              yield* Deferred.await(release);
            }),
        });

        const creations = yield* Effect.all(
          Array.from({ length: 6 }, (_, index) =>
            workspaceFileSystem.createDirectory({
              cwd,
              relativePath: `parent/child-${index}`,
            }),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);

        yield* Deferred.await(limitReached).pipe(Effect.timeout("2 seconds"));
        yield* Effect.yieldNow;
        expect(yield* Ref.get(acquired)).toBe(2);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(creations);
        expect(yield* Ref.get(acquired)).toBe(6);
      }),
    );
  });

  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
          diskRevision: diskRevision("export const answer = 42;\n"),
        });
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-secret.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("rejects malformed UTF-8 instead of replacing bytes before an edit", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.writeFile(
          path.join(cwd, "legacy.txt"),
          Uint8Array.from([0x66, 0x6f, 0x80, 0x6f]),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "legacy.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("keeps a UTF-8 BOM and preserves exact bytes across a no-op save", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "bom.txt");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]));

        const before = yield* workspaceFileSystem.readFile({ cwd, relativePath: "bom.txt" });
        expect(before.contents).toBe("\uFEFFa");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "bom.txt",
          contents: before.contents,
          precondition: { _tag: "match", diskRevision: before.diskRevision! },
        });
        expect(Array.from(yield* fileSystem.readFile(absolutePath))).toEqual([
          0xef, 0xbb, 0xbf, 0x61,
        ]);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );

    it.effect("omits disk revisions for truncated previews", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "large.txt", "a".repeat(1024 * 1024 + 1));

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: "large.txt" });

        expect(result.truncated).toBe(true);
        expect(result.diskRevision).toBeNull();
      }),
    );

    it.effect("detects same-size changes even when the mtime is restored", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "same-size.txt");
        yield* writeTextFile(cwd, "same-size.txt", "first\n");
        const before = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "same-size.txt",
        });
        const originalStat = yield* Effect.promise(() => NodeFSP.stat(absolutePath));

        yield* Effect.promise(() => NodeFSP.writeFile(absolutePath, "other\n", "utf8"));
        yield* Effect.promise(() =>
          NodeFSP.utimes(absolutePath, originalStat.atime, originalStat.mtime),
        );
        const after = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "same-size.txt",
        });

        expect(after.byteLength).toBe(before.byteLength);
        expect(after.diskRevision).not.toBe(before.diskRevision);
        expect(after.diskRevision).toBe(diskRevision("other\n"));
      }),
    );

    it.effect("does not reject a truncated preview ending inside a UTF-8 code point", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const prefix = "a".repeat(1024 * 1024 - 1);
        yield* writeTextFile(cwd, "unicode-large.txt", `${prefix}€`);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "unicode-large.txt",
        });

        expect(result.truncated).toBe(true);
        expect(result.contents).toBe(prefix);
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("rejects oversized UTF-8 contents before creating target directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "new/large.txt",
            contents: "é".repeat(512 * 1024 + 1),
            precondition: { _tag: "must-not-exist" },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileContentsTooLargeError);
        expect(error).toMatchObject({
          byteLength: 1024 * 1024 + 2,
          maxByteLength: 1024 * 1024,
        });
        expect(
          yield* fileSystem.stat(path.join(cwd, "new")).pipe(Effect.orElseSucceed(() => null)),
        ).toBeNull();
      }),
    );

    it.effect("allows a small explicit replacement of an oversized target", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "large.txt", "a".repeat(1024 * 1024 + 1));

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "large.txt",
          contents: "small\n",
          precondition: { _tag: "unconditional" },
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "large.txt"))).toBe("small\n");
      }),
    );

    it.effect("does not create missing parents for a failed matching save", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "missing/child.txt",
            contents: "local\n",
            precondition: {
              _tag: "match",
              diskRevision: ProjectFileDiskRevision.make(diskRevision("base\n")),
            },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(error).toMatchObject({ actualExists: false, actualDiskRevision: null });
        expect(
          yield* fileSystem.stat(path.join(cwd, "missing")).pipe(Effect.orElseSucceed(() => null)),
        ).toBeNull();
      }),
    );

    it.effect("reports a directory collision as must-not-exist conflict", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "plan.md"));

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "plan.md",
            contents: "plan\n",
            precondition: { _tag: "must-not-exist" },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(error).toMatchObject({ actualExists: true, actualDiskRevision: null });
      }),
    );

    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
          precondition: { _tag: "must-not-exist" },
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({
          relativePath: "plans/effect-rpc.md",
          diskRevision: diskRevision("# Plan\n"),
          created: true,
        });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("makes newly-created entries visible on the next index refresh", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
          precondition: { _tag: "must-not-exist" },
        });
        // Creation schedules this refresh in the background in production.
        // Run it explicitly here so the assertion does not depend on fiber
        // scheduling or native watcher timing.
        yield* workspaceEntries.refresh(cwd);

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
            precondition: { _tag: "unconditional" },
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("rejects a stale matching revision without changing disk", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "base\n");
        const base = yield* workspaceFileSystem.readFile({ cwd, relativePath: "src/index.ts" });
        yield* writeTextFile(cwd, "src/index.ts", "external\n");

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "src/index.ts",
            contents: "local\n",
            precondition: { _tag: "match", diskRevision: base.diskRevision! },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(error).toMatchObject({
          precondition: { _tag: "match", diskRevision: base.diskRevision },
          actualExists: true,
          actualDiskRevision: diskRevision("external\n"),
        });
        expect(yield* fileSystem.readFileString(path.join(cwd, "src/index.ts"))).toBe("external\n");
      }),
    );

    it.effect("accepts a matching revision and returns the new revision", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "matched.txt", "before\n");
        const before = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "matched.txt",
        });

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "matched.txt",
          contents: "after\n",
          precondition: { _tag: "match", diskRevision: before.diskRevision! },
        });
        const after = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "matched.txt",
        });

        expect(result).toEqual({
          relativePath: "matched.txt",
          diskRevision: diskRevision("after\n"),
          created: false,
        });
        expect(after.diskRevision).toBe(result.diskRevision);
        expect(after.contents).toBe("after\n");
      }),
    );

    it.effect("creates and replaces a long valid basename atomically", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const relativePath = `${"a".repeat(236)}.txt`;

        const created = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath,
          contents: "created\n",
          precondition: { _tag: "must-not-exist" },
        });
        const replaced = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath,
          contents: "replaced\n",
          precondition: { _tag: "match", diskRevision: created.diskRevision },
        });

        expect(relativePath).toHaveLength(240);
        expect(replaced).toMatchObject({ relativePath, created: false });
        expect(yield* fileSystem.readFileString(path.join(cwd, relativePath))).toBe("replaced\n");
      }),
    );

    it.effect("enforces must-not-exist and supports explicit unconditional writes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "existing\n");

        const conflict = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "notes.md",
            contents: "must not win\n",
            precondition: { _tag: "must-not-exist" },
          })
          .pipe(Effect.flip);
        expect(conflict).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        if (conflict._tag !== "WorkspaceFileRevisionConflictError") {
          return yield* Effect.die("Expected a workspace file revision conflict");
        }
        expect(conflict.actualExists).toBe(true);
        expect(conflict.actualDiskRevision).toBe(diskRevision("existing\n"));

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "notes.md",
          contents: "overwritten\n",
          precondition: { _tag: "unconditional" },
        });
        expect(result).toEqual({
          relativePath: "notes.md",
          diskRevision: diskRevision("overwritten\n"),
          created: false,
        });
        expect(yield* fileSystem.readFileString(path.join(cwd, "notes.md"))).toBe("overwritten\n");
      }),
    );

    it.effect("rechecks a matching target after the temporary file is durable", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "race.txt");
        yield* writeTextFile(cwd, "race.txt", "base\n");
        let observedDurableTemp = false;
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          beforePublish: ({ canonicalTargetPath }) =>
            Effect.promise(async () => {
              const entries = await NodeFSP.readdir(path.dirname(canonicalTargetPath));
              observedDurableTemp = entries.some(
                (entry) => entry.startsWith(".zrode-") && entry.endsWith(".tmp"),
              );
              await NodeFSP.writeFile(canonicalTargetPath, "external\n", "utf8");
            }),
        });
        const base = yield* workspaceFileSystem.readFile({ cwd, relativePath: "race.txt" });

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "race.txt",
            contents: "local\n",
            precondition: { _tag: "match", diskRevision: base.diskRevision! },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(error).toMatchObject({
          actualExists: true,
          actualDiskRevision: diskRevision("external\n"),
        });
        expect(observedDurableTemp).toBe(true);
        expect(yield* Effect.promise(() => NodeFSP.readFile(absolutePath, "utf8"))).toBe(
          "external\n",
        );
        expect(
          (yield* Effect.promise(() => NodeFSP.readdir(cwd))).some(
            (entry) => entry.startsWith(".zrode-") && entry.endsWith(".tmp"),
          ),
        ).toBe(false);
      }),
    );

    it.effect("does not hash an oversized target while checking a match", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const contents = "a".repeat(1024 * 1024 + 1);
        yield* writeTextFile(cwd, "oversized.txt", contents);

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "oversized.txt",
            contents: "must not replace the large file\n",
            precondition: {
              _tag: "match",
              diskRevision: ProjectFileDiskRevision.make(diskRevision("unrelated\n")),
            },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(error).toMatchObject({
          actualExists: true,
          actualDiskRevision: null,
        });
        expect(yield* fileSystem.readFileString(path.join(cwd, "oversized.txt"))).toBe(contents);
      }),
    );

    it.effect("does not overwrite a file created after temporary-file preparation", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "created-during-save.txt");
        let observedDurableTemp = false;
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          beforePublish: ({ canonicalTargetPath }) =>
            Effect.promise(async () => {
              const entries = await NodeFSP.readdir(path.dirname(canonicalTargetPath));
              observedDurableTemp = entries.some(
                (entry) => entry.startsWith(".zrode-") && entry.endsWith(".tmp"),
              );
              await NodeFSP.writeFile(canonicalTargetPath, "external creator\n", {
                encoding: "utf8",
                flag: "wx",
              });
            }),
        });

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "created-during-save.txt",
            contents: "local creator\n",
            precondition: { _tag: "must-not-exist" },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileRevisionConflictError);
        expect(error).toMatchObject({
          actualExists: true,
          actualDiskRevision: diskRevision("external creator\n"),
        });
        expect(observedDurableTemp).toBe(true);
        expect(yield* Effect.promise(() => NodeFSP.readFile(absolutePath, "utf8"))).toBe(
          "external creator\n",
        );
        expect(
          (yield* Effect.promise(() => NodeFSP.readdir(cwd))).some(
            (entry) => entry.startsWith(".zrode-") && entry.endsWith(".tmp"),
          ),
        ).toBe(false);
      }),
    );

    it.effect("rejects target and parent symlinks that escape the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "target-link.txt"),
        );
        yield* fileSystem.symlink(outsideDir, path.join(cwd, "parent-link"));

        const targetError = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "target-link.txt",
            contents: "nope\n",
            precondition: { _tag: "unconditional" },
          })
          .pipe(Effect.flip);
        const parentError = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "parent-link/created.txt",
            contents: "nope\n",
            precondition: { _tag: "must-not-exist" },
          })
          .pipe(Effect.flip);

        expect(targetError).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(parentError).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(yield* fileSystem.readFileString(path.join(outsideDir, "secret.txt"))).toBe(
          "outside\n",
        );
        expect(
          yield* fileSystem
            .stat(path.join(outsideDir, "created.txt"))
            .pipe(Effect.orElseSucceed(() => null)),
        ).toBeNull();
      }),
    );

    it.effect("follows in-root symlinks without replacing the symlink", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "actual/target.txt", "before\n");
        yield* fileSystem.symlink(
          path.join(cwd, "actual", "target.txt"),
          path.join(cwd, "linked.txt"),
        );
        yield* fileSystem.symlink(path.join(cwd, "actual"), path.join(cwd, "linked-directory"));

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "linked.txt",
          contents: "after\n",
          precondition: { _tag: "unconditional" },
        });
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "linked-directory/created.txt",
          contents: "created through directory link\n",
          precondition: { _tag: "must-not-exist" },
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "actual", "target.txt"))).toBe(
          "after\n",
        );
        expect(
          (yield* Effect.promise(() =>
            NodeFSP.lstat(path.join(cwd, "linked.txt")),
          )).isSymbolicLink(),
        ).toBe(true);
        expect(yield* fileSystem.readFileString(path.join(cwd, "actual", "created.txt"))).toBe(
          "created through directory link\n",
        );
        expect(
          (yield* Effect.promise(() =>
            NodeFSP.lstat(path.join(cwd, "linked-directory")),
          )).isSymbolicLink(),
        ).toBe(true);
      }),
    );

    it.effect("preserves the mode of an overwritten file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "script.sh");
        yield* writeTextFile(cwd, "script.sh", "#!/bin/sh\nexit 0\n");
        yield* Effect.promise(() => NodeFSP.chmod(absolutePath, 0o6751));

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "script.sh",
          contents: "#!/bin/sh\nexit 1\n",
          precondition: { _tag: "unconditional" },
        });

        const stat = yield* Effect.promise(() => NodeFSP.stat(absolutePath));
        expect(stat.mode & 0o7777).toBe(0o6751);
      }),
    );

    it.effect("permanently deletes files and recursive directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "remove.txt", "remove me\n");
        yield* writeTextFile(cwd, "nested/child.txt", "remove me too\n");
        const preparedFile = yield* workspaceFileSystem.prepareDeleteEntry({
          cwd,
          relativePath: "remove.txt",
          expectedKind: "file",
          recursive: false,
        });
        const preparedDirectory = yield* workspaceFileSystem.prepareDeleteEntry({
          cwd,
          relativePath: "nested",
          expectedKind: "directory",
          recursive: true,
        });

        expect(
          yield* workspaceFileSystem.deleteEntry({
            cwd,
            relativePath: "remove.txt",
            expectedKind: "file",
            recursive: false,
            entryRevision: preparedFile.entryRevision,
            permanentlyDelete: true,
          }),
        ).toEqual({ relativePath: "remove.txt", deletedKind: "file" });
        yield* workspaceFileSystem.deleteEntry({
          cwd,
          relativePath: "nested",
          expectedKind: "directory",
          recursive: true,
          entryRevision: preparedDirectory.entryRevision,
          permanentlyDelete: true,
        });

        expect(
          yield* Effect.promise(() => NodeFSP.stat(path.join(cwd, "remove.txt")).catch(() => null)),
        ).toBeNull();
        expect(
          yield* Effect.promise(() => NodeFSP.stat(path.join(cwd, "nested")).catch(() => null)),
        ).toBeNull();
      }),
    );

    it.effect("uses only two validation scans while exclusively deleting a tree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "tree/a.txt", "a\n");
        yield* writeTextFile(cwd, "tree/nested/b.txt", "b\n");
        const completedScans = yield* Ref.make<ReadonlyArray<number>>([]);
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          onEntryTreeRevisionCompleted: ({ descendantCount }) =>
            Ref.update(completedScans, (counts) => [...counts, descendantCount]),
        });
        const prepared = yield* workspaceFileSystem.prepareDeleteEntry({
          cwd,
          relativePath: "tree",
          expectedKind: "directory",
          recursive: true,
        });

        yield* workspaceFileSystem.deleteEntry({
          cwd,
          relativePath: "tree",
          expectedKind: "directory",
          recursive: true,
          entryRevision: prepared.entryRevision,
          permanentlyDelete: true,
        });

        // One preparation scan, then one immediately before detach and one on
        // the private tombstone. The former duplicate pre-detach scan is gone.
        expect(yield* Ref.get(completedScans)).toEqual([3, 3, 3]);
      }),
    );

    it.effect("restores the original name when removal fails", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "kept/child.txt", "keep\n");
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          removeDeletedEntry: async () => {
            throw new Error("forced removal failure");
          },
        });
        const prepared = yield* workspaceFileSystem.prepareDeleteEntry({
          cwd,
          relativePath: "kept",
          expectedKind: "directory",
          recursive: true,
        });

        const error = yield* workspaceFileSystem
          .deleteEntry({
            cwd,
            relativePath: "kept",
            expectedKind: "directory",
            recursive: true,
            entryRevision: prepared.entryRevision,
            permanentlyDelete: true,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(path.join(cwd, "kept/child.txt"), "utf8")),
        ).toBe("keep\n");
        expect(
          (yield* Effect.promise(() => NodeFSP.readdir(cwd))).some((name) =>
            name.startsWith(".zrode-delete-"),
          ),
        ).toBe(false);
      }),
    );

    it.effect("rejects type confusion and final symlinks without deleting their targets", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "target.txt", "keep\n");
        yield* Effect.promise(() => NodeFSP.symlink("target.txt", path.join(cwd, "link.txt")));

        const wrongKind = yield* workspaceFileSystem
          .prepareDeleteEntry({
            cwd,
            relativePath: "target.txt",
            expectedKind: "directory",
            recursive: true,
          })
          .pipe(Effect.flip);
        const symlink = yield* workspaceFileSystem
          .prepareDeleteEntry({
            cwd,
            relativePath: "link.txt",
            expectedKind: "file",
            recursive: false,
          })
          .pipe(Effect.flip);

        expect(wrongKind).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotDirectoryError);
        expect(symlink).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(path.join(cwd, "target.txt"), "utf8")),
        ).toBe("keep\n");
      }),
    );

    it.effect("refuses to delete a target replaced after its initial identity check", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const target = path.join(cwd, "target.txt");
        const original = path.join(cwd, "original.txt");
        yield* writeTextFile(cwd, "target.txt", "original\n");
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          beforeDelete: () =>
            Effect.promise(async () => {
              await NodeFSP.rename(target, original);
              await NodeFSP.writeFile(target, "replacement\n");
            }),
        });
        const prepared = yield* workspaceFileSystem.prepareDeleteEntry({
          cwd,
          relativePath: "target.txt",
          expectedKind: "file",
          recursive: false,
        });

        const error = yield* workspaceFileSystem
          .deleteEntry({
            cwd,
            relativePath: "target.txt",
            expectedKind: "file",
            recursive: false,
            entryRevision: prepared.entryRevision,
            permanentlyDelete: true,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceEntryChangedError);
        expect(yield* Effect.promise(() => NodeFSP.readFile(target, "utf8"))).toBe("replacement\n");
        expect(yield* Effect.promise(() => NodeFSP.readFile(original, "utf8"))).toBe("original\n");
      }),
    );

    it.effect("refuses a recursive delete when a descendant changed after confirmation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "tree/child.txt", "confirmed\n");
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const prepared = yield* workspaceFileSystem.prepareDeleteEntry({
          cwd,
          relativePath: "tree",
          expectedKind: "directory",
          recursive: true,
        });
        yield* writeTextFile(cwd, "tree/child.txt", "changed after confirmation\n");

        const error = yield* workspaceFileSystem
          .deleteEntry({
            cwd,
            relativePath: "tree",
            expectedKind: "directory",
            recursive: true,
            entryRevision: prepared.entryRevision,
            permanentlyDelete: true,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceEntryChangedError);
        expect(yield* Effect.promise(() => NodeFSP.readFile(`${cwd}/tree/child.txt`, "utf8"))).toBe(
          "changed after confirmation\n",
        );
      }),
    );

    it.effect("exposes a visible recovery path when the original name is reoccupied", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const target = path.join(cwd, "important.txt");
        yield* writeTextFile(cwd, "important.txt", "original data\n");
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          removeDeletedEntry: async () => {
            await NodeFSP.writeFile(target, "replacement data\n", "utf8");
            throw new Error("forced removal failure");
          },
        });
        const prepared = yield* workspaceFileSystem.prepareDeleteEntry({
          cwd,
          relativePath: "important.txt",
          expectedKind: "file",
          recursive: false,
        });

        const error = yield* workspaceFileSystem
          .deleteEntry({
            cwd,
            relativePath: "important.txt",
            expectedKind: "file",
            recursive: false,
            entryRevision: prepared.entryRevision,
            permanentlyDelete: true,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceDeleteRecoveryError);
        if (error._tag !== "WorkspaceDeleteRecoveryError") return;
        expect(error.originalPathOccupied).toBe(true);
        expect(error.dataMayRemainHidden).toBe(false);
        expect(path.basename(error.recoveryPath)).toMatch(/^important\.txt\.zrode-recovered-/u);
        expect(yield* Effect.promise(() => NodeFSP.readFile(error.recoveryPath, "utf8"))).toBe(
          "original data\n",
        );
        expect(yield* Effect.promise(() => NodeFSP.readFile(target, "utf8"))).toBe(
          "replacement data\n",
        );
        expect(
          (yield* Effect.promise(() => NodeFSP.readdir(cwd))).some((name) =>
            name.startsWith(".zrode-delete-"),
          ),
        ).toBe(false);
      }),
    );

    it.effect("falls back to a visible recovery name when direct restoration fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "recover.txt", "valuable\n");
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          removeDeletedEntry: async () => {
            throw new Error("forced removal failure");
          },
          renameDeletedEntry: async ({ from, to, purpose }) => {
            if (purpose === "restore") throw new Error("forced restore failure");
            await NodeFSP.rename(from, to);
          },
        });
        const prepared = yield* workspaceFileSystem.prepareDeleteEntry({
          cwd,
          relativePath: "recover.txt",
          expectedKind: "file",
          recursive: false,
        });
        const error = yield* workspaceFileSystem
          .deleteEntry({
            cwd,
            relativePath: "recover.txt",
            expectedKind: "file",
            recursive: false,
            entryRevision: prepared.entryRevision,
            permanentlyDelete: true,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceDeleteRecoveryError);
        if (error._tag !== "WorkspaceDeleteRecoveryError") return;
        expect(error.dataMayRemainHidden).toBe(false);
        expect(yield* Effect.promise(() => NodeFSP.readFile(error.recoveryPath, "utf8"))).toBe(
          "valuable\n",
        );
      }),
    );

    it.effect("allows exactly one concurrent writer for a shared matching revision", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "shared.txt", "base\n");
        const base = yield* workspaceFileSystem.readFile({ cwd, relativePath: "shared.txt" });

        const outcomes = yield* Effect.all(
          ["writer-a\n", "writer-b\n"].map((contents) =>
            workspaceFileSystem
              .writeFile({
                cwd,
                relativePath: "shared.txt",
                contents,
                precondition: { _tag: "match", diskRevision: base.diskRevision! },
              })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );

        expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
        const failures = outcomes.filter((outcome) => outcome._tag === "Failure");
        expect(failures).toHaveLength(1);
        expect(failures[0]?.failure).toBeInstanceOf(
          WorkspaceFileSystem.WorkspaceFileRevisionConflictError,
        );
        expect(["writer-a\n", "writer-b\n"]).toContain(
          yield* fileSystem.readFileString(path.join(cwd, "shared.txt")),
        );
      }),
    );

    it.effect("allows independent workspace writes to publish concurrently", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");
        const started = yield* Ref.make(0);
        const bothStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          beforePublish: () =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(started, (value) => value + 1);
              if (count === 2) yield* Deferred.succeed(bothStarted, undefined);
              yield* Deferred.await(bothStarted);
              yield* Deferred.await(release);
            }),
        });
        const revisionA = (yield* workspaceFileSystem.readFile({ cwd, relativePath: "a.txt" }))
          .diskRevision!;
        const revisionB = (yield* workspaceFileSystem.readFile({ cwd, relativePath: "b.txt" }))
          .diskRevision!;
        const writerA = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "a.txt",
            contents: "updated a\n",
            precondition: { _tag: "match", diskRevision: revisionA },
          })
          .pipe(Effect.forkChild);
        const writerB = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "b.txt",
            contents: "updated b\n",
            precondition: { _tag: "match", diskRevision: revisionB },
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(bothStarted).pipe(Effect.timeout("2 seconds"));
        yield* Deferred.succeed(release, undefined);
        yield* Effect.all([Fiber.join(writerA), Fiber.join(writerB)], {
          concurrency: "unbounded",
          discard: true,
        });
      }),
    );

    it.effect("keeps recursive delete exclusive against descendant writes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "tree/child.txt", "base\n");
        const deleteEntered = yield* Deferred.make<void>();
        const releaseDelete = yield* Deferred.make<void>();
        const writerPublished = yield* Ref.make(false);
        const workspaceFileSystem = yield* WorkspaceFileSystem.makeWithOptions({
          beforeDelete: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(deleteEntered, undefined);
              yield* Deferred.await(releaseDelete);
            }),
          beforePublish: () => Ref.set(writerPublished, true),
        });
        const prepared = yield* workspaceFileSystem.prepareDeleteEntry({
          cwd,
          relativePath: "tree",
          expectedKind: "directory",
          recursive: true,
        });
        const childRevision = (yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "tree/child.txt",
        })).diskRevision!;
        const deleting = yield* workspaceFileSystem
          .deleteEntry({
            cwd,
            relativePath: "tree",
            expectedKind: "directory",
            recursive: true,
            entryRevision: prepared.entryRevision,
            permanentlyDelete: true,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(deleteEntered);
        const writing = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "tree/child.txt",
            contents: "racing\n",
            precondition: { _tag: "match", diskRevision: childRevision },
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(yield* Ref.get(writerPublished)).toBe(false);
        yield* Deferred.succeed(releaseDelete, undefined);
        yield* Fiber.join(deleting);
        expect((yield* Fiber.join(writing))._tag).toBe("Failure");
      }),
    );
  });
});
