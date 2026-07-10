// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { ProjectFileDiskRevision } from "@t3tools/contracts";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

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
                (entry) => entry.startsWith(".race.txt.") && entry.endsWith(".tmp"),
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
            (entry) => entry.startsWith(".race.txt.") && entry.endsWith(".tmp"),
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
                (entry) => entry.startsWith(".created-during-save.txt.") && entry.endsWith(".tmp"),
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
            (entry) => entry.startsWith(".created-during-save.txt.") && entry.endsWith(".tmp"),
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
  });
});
