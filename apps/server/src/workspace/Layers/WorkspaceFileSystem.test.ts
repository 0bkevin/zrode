import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "zrode-workspace-files-test-",
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

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("writeFile", () => {
    it.effect("reads root directory entries sorted with directories first", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");
        yield* writeTextFile(cwd, "README.md", "# Project\n");

        const result = yield* workspaceFileSystem.readDir({ cwd, relativePath: "" });

        expect(result).toEqual({
          relativePath: "",
          entries: [
            {
              name: "src",
              kind: "directory",
              relativePath: "src",
              isSymlink: false,
            },
            {
              name: "README.md",
              kind: "file",
              relativePath: "README.md",
              isSymlink: false,
            },
          ],
        });
      }),
    );

    it.effect("reads text file previews with metadata", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes/todo.md", "ship filesystem\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "notes/todo.md",
        });

        expect(result).toEqual({
          relativePath: "notes/todo.md",
          content: "ship filesystem\n",
          isBinary: false,
          size: "ship filesystem\n".length,
          truncated: false,
        });
      }),
    );

    it.effect("stats the workspace root when requested explicitly", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const result = yield* workspaceFileSystem.statPath({ cwd, relativePath: "" });

        expect(result.relativePath).toBe("");
        expect(result.isDirectory).toBe(true);
      }),
    );

    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("creates, renames, copies, and deletes workspace paths", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        expect(
          yield* workspaceFileSystem.createDirectory({
            cwd,
            relativePath: "docs",
          }),
        ).toEqual({ relativePath: "docs" });
        expect(
          yield* workspaceFileSystem.createFile({
            cwd,
            relativePath: "docs/draft.md",
          }),
        ).toEqual({ relativePath: "docs/draft.md" });
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "docs/draft.md",
          contents: "draft\n",
        });
        expect(
          yield* workspaceFileSystem.renamePath({
            cwd,
            oldRelativePath: "docs/draft.md",
            newRelativePath: "docs/final.md",
          }),
        ).toEqual({ relativePath: "docs/final.md" });
        expect(
          yield* workspaceFileSystem.copyPath({
            cwd,
            sourceRelativePath: "docs/final.md",
            destinationRelativePath: "docs/copy.md",
          }),
        ).toEqual({ relativePath: "docs/copy.md" });
        expect(
          yield* fileSystem.readFileString(path.join(cwd, "docs/copy.md")).pipe(Effect.orDie),
        ).toBe("draft\n");
        expect(
          yield* workspaceFileSystem.deletePath({
            cwd,
            relativePath: "docs/final.md",
          }),
        ).toEqual({ relativePath: "docs/final.md" });
        expect(
          yield* fileSystem.stat(path.join(cwd, "docs/final.md")).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          ),
        ).toBe(false);
      }),
    );

    it.effect("invalidates workspace entry search cache after path mutations", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const beforeCreate = yield* workspaceEntries.search({
          cwd,
          query: "created",
          limit: 10,
        });
        expect(beforeCreate.entries).toEqual([]);

        yield* workspaceFileSystem.createFile({
          cwd,
          relativePath: "created.md",
        });

        const afterCreate = yield* workspaceEntries.search({
          cwd,
          query: "created",
          limit: 10,
        });
        expect(afterCreate.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "created.md" })]),
        );
      }),
    );
  });
});
