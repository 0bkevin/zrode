import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as WorkspaceFileEvents from "./WorkspaceFileEvents.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceFileEvents.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileEvents", (it) => {
  it.effect("conservatively checks nullable parent-watcher filenames", () =>
    Effect.sync(() => {
      expect(WorkspaceFileEvents.workspaceParentWatchEventMayAffectRoot(null, "workspace")).toBe(
        true,
      );
      expect(
        WorkspaceFileEvents.workspaceParentWatchEventMayAffectRoot(
          Buffer.from("workspace"),
          "workspace",
        ),
      ).toBe(true);
      expect(
        WorkspaceFileEvents.workspaceParentWatchEventMayAffectRoot("unrelated", "workspace"),
      ).toBe(false);
    }),
  );

  it.effect("emits a ready marker followed by coalesced relative path hints", () =>
    Effect.gen(function* () {
      const fileEvents = yield* WorkspaceFileEvents.WorkspaceFileEvents;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "zrode-file-events-" });
      const stream = yield* fileEvents.subscribe({ cwd });

      const received = Array.from(
        yield* stream.pipe(
          Stream.tap((event) =>
            event.type === "ready"
              ? fileSystem.writeFileString(path.join(cwd, "notes.md"), "hello\n")
              : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        ),
      );

      expect(received[0]).toMatchObject({ version: 2, sequence: 0, type: "ready", cwd });
      expect(received[1]).toMatchObject({ version: 2, sequence: 1, type: "changed", cwd });
      expect(received[1]?.type === "changed" ? received[1].structuralPaths : []).toContain(
        "notes.md",
      );
    }),
  );

  it.effect("separates content changes from explorer structure changes", () =>
    Effect.gen(function* () {
      const fileEvents = yield* WorkspaceFileEvents.WorkspaceFileEvents;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "zrode-file-events-" });
      yield* fileSystem.writeFileString(path.join(cwd, "notes.md"), "before\n");
      const stream = yield* fileEvents.subscribe({ cwd });

      const received = Array.from(
        yield* stream.pipe(
          Stream.tap((event) =>
            event.type === "ready"
              ? fileSystem.writeFileString(path.join(cwd, "notes.md"), "after\n")
              : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        ),
      );

      expect(received[1]).toMatchObject({
        type: "changed",
        contentPaths: ["notes.md"],
        structuralPaths: [],
      });
    }),
  );

  it.effect("watches a canonical root reached through a symlink", () =>
    Effect.gen(function* () {
      const fileEvents = yield* WorkspaceFileEvents.WorkspaceFileEvents;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "zrode-file-events-" });
      const realRoot = path.join(parent, "real-root");
      const linkedRoot = path.join(parent, "linked-root");
      yield* fileSystem.makeDirectory(realRoot);
      yield* fileSystem.symlink(realRoot, linkedRoot);
      const stream = yield* fileEvents.subscribe({ cwd: linkedRoot });

      const received = Array.from(
        yield* stream.pipe(
          Stream.tap((event) =>
            event.type === "ready"
              ? fileSystem.writeFileString(path.join(realRoot, "linked.txt"), "hello\n")
              : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        ),
      );

      expect(received[0]).toMatchObject({ type: "ready", cwd: linkedRoot });
      expect(received[1]?.type === "changed" ? received[1].structuralPaths : []).toContain(
        "linked.txt",
      );
    }),
  );

  it.effect("does not ignore a workspace whose ancestor is named node_modules", () =>
    Effect.gen(function* () {
      const fileEvents = yield* WorkspaceFileEvents.WorkspaceFileEvents;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "zrode-file-events-" });
      const cwd = path.join(parent, "node_modules", "workspace");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      const stream = yield* fileEvents.subscribe({ cwd });

      const received = Array.from(
        yield* stream.pipe(
          Stream.tap((event) =>
            event.type === "ready"
              ? fileSystem.writeFileString(path.join(cwd, "visible.txt"), "hello\n")
              : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        ),
      );

      expect(received[1]?.type === "changed" ? received[1].structuralPaths : []).toContain(
        "visible.txt",
      );
    }),
  );

  it.effect("marks an over-capacity path-hint set for resynchronization", () =>
    Effect.sync(() => {
      const contentPaths = new Set<string>();
      const structuralPaths = new Set<string>();

      for (let index = 0; index < 256; index += 1) {
        expect(
          WorkspaceFileEvents.recordWorkspaceFileEventPathHint({
            contentPaths,
            structuralPaths,
            eventName: "add",
            relativePath: `file-${index}.txt`,
          }),
        ).toBe("recorded");
      }
      expect(
        WorkspaceFileEvents.recordWorkspaceFileEventPathHint({
          contentPaths,
          structuralPaths,
          eventName: "add",
          relativePath: "overflow.txt",
        }),
      ).toBe("overflow");
    }),
  );

  it.effect("signals root deletion instead of silently leaving a stale watcher", () =>
    Effect.gen(function* () {
      const fileEvents = yield* WorkspaceFileEvents.WorkspaceFileEvents;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "zrode-file-events-" });
      const cwd = path.join(parent, "workspace");
      yield* fileSystem.makeDirectory(cwd);
      const stream = yield* fileEvents.subscribe({ cwd });

      const received = Array.from(
        yield* stream.pipe(
          Stream.tap((event) =>
            event.type === "ready"
              ? fileSystem.remove(cwd, { recursive: true, force: true })
              : event.type === "resync" && event.reason === "root-deleted"
                ? fileSystem.makeDirectory(cwd)
                : Effect.void,
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        ),
      );

      expect(received[1]).toMatchObject({ type: "resync", reason: "root-deleted" });
      expect(received[2]).toMatchObject({ type: "ready", sequence: 2 });
    }),
  );
});
