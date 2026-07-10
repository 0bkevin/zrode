// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { type FSWatcher as ChokidarWatcher, watch } from "chokidar";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ProjectFileEvent, ProjectWatchFilesInput } from "@t3tools/contracts";

import * as WorkspacePaths from "./WorkspacePaths.ts";

const COALESCE_WINDOW_MS = 75;
const RESTART_DELAY_MS = 250;
const MAX_PATHS_PER_EVENT = 256;
const MAX_RELATIVE_PATH_LENGTH = 512;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

type ChangedEvent = Extract<ProjectFileEvent, { readonly type: "changed" }>;
type ResyncReason = Extract<ProjectFileEvent, { readonly type: "resync" }>["reason"];
type SharedEvent =
  | Omit<Extract<ProjectFileEvent, { readonly type: "ready" }>, "cwd">
  | Omit<ChangedEvent, "cwd">
  | Omit<Extract<ProjectFileEvent, { readonly type: "resync" }>, "cwd">;

type SharedWatcher = {
  readonly canonicalRoot: string;
  readonly listeners: Set<(event: SharedEvent) => void>;
  watcher: ChokidarWatcher | null;
  parentWatcher: NodeFS.FSWatcher | null;
  ready: boolean;
  closed: boolean;
  sequence: number;
  pendingContentPaths: Set<string>;
  pendingStructuralPaths: Set<string>;
  pendingResyncReason: ResyncReason | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
};

export class WorkspaceFileEvents extends Context.Service<
  WorkspaceFileEvents,
  {
    /**
     * Subscribe to lossy workspace invalidations. The stream deliberately
     * carries path hints instead of pretending to be a durable filesystem
     * journal; `resync` means the consumer must discard all hints.
     */
    readonly subscribe: (
      input: ProjectWatchFilesInput,
    ) => Effect.Effect<
      Stream.Stream<ProjectFileEvent>,
      | WorkspacePaths.WorkspaceRootNotExistsError
      | WorkspacePaths.WorkspaceRootCreateFailedError
      | WorkspacePaths.WorkspaceRootStatFailedError
      | WorkspacePaths.WorkspaceRootNotDirectoryError
    >;
  }
>()("t3/workspace/WorkspaceFileEvents") {}

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const sharedWatchers = new Map<string, SharedWatcher>();

  const emit = (shared: SharedWatcher, event: SharedEvent) => {
    for (const listener of shared.listeners) listener(event);
  };

  const scheduleFlush = (shared: SharedWatcher) => {
    // Chokidar callbacks are outside Effect; the timer is cancelled during the
    // last subscriber's awaited teardown.
    if (shared.flushTimer === null) {
      // @effect-diagnostics-next-line globalTimers:off
      shared.flushTimer = setTimeout(() => flush(shared), COALESCE_WINDOW_MS);
    }
  };

  const requireResync = (shared: SharedWatcher, reason: ResyncReason) => {
    if (shared.pendingResyncReason === null || reason === "root-deleted") {
      shared.pendingResyncReason = reason;
    }
    // Stop accumulating hints once their authoritative meaning has been lost.
    shared.pendingContentPaths.clear();
    shared.pendingStructuralPaths.clear();
    scheduleFlush(shared);
  };

  const flush = (shared: SharedWatcher) => {
    shared.flushTimer = null;
    if (shared.closed) return;
    if (shared.pendingResyncReason !== null) {
      const reason = shared.pendingResyncReason;
      shared.pendingResyncReason = null;
      shared.sequence += 1;
      emit(shared, { version: 1, sequence: shared.sequence, type: "resync", reason });
      return;
    }
    if (shared.pendingContentPaths.size === 0 && shared.pendingStructuralPaths.size === 0) return;
    const contentPaths = [...shared.pendingContentPaths].sort();
    const structuralPaths = [...shared.pendingStructuralPaths].sort();
    shared.pendingContentPaths.clear();
    shared.pendingStructuralPaths.clear();
    shared.sequence += 1;
    emit(shared, {
      version: 1,
      sequence: shared.sequence,
      type: "changed",
      contentPaths,
      structuralPaths,
    });
  };

  const isIgnored = (shared: SharedWatcher, candidatePath: string): boolean => {
    const relativePath = path.relative(shared.canonicalRoot, candidatePath);
    if (
      relativePath.length === 0 ||
      relativePath === "." ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return false;
    }
    return relativePath.split(/[\\/]/u).some((segment) => IGNORED_DIRECTORY_NAMES.has(segment));
  };

  const recordPath = (shared: SharedWatcher, eventName: string, changedPath: string) => {
    const relativePath = path.relative(shared.canonicalRoot, changedPath).replaceAll("\\", "/");
    if (relativePath.length === 0 || relativePath === ".") {
      if (eventName === "unlinkDir") {
        requireResync(shared, "root-deleted");
        restart(shared);
      }
      return;
    }
    if (relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
      return;
    }
    if (shared.pendingResyncReason !== null) return;
    if (relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
      requireResync(shared, "overflow");
      return;
    }

    if (eventName === "change") {
      if (!shared.pendingStructuralPaths.has(relativePath)) {
        shared.pendingContentPaths.add(relativePath);
      }
    } else {
      shared.pendingContentPaths.delete(relativePath);
      shared.pendingStructuralPaths.add(relativePath);
    }
    if (
      shared.pendingContentPaths.size + shared.pendingStructuralPaths.size >
      MAX_PATHS_PER_EVENT
    ) {
      requireResync(shared, "overflow");
      return;
    }
    scheduleFlush(shared);
  };

  const start = (shared: SharedWatcher) => {
    if (shared.closed || shared.watcher !== null) return;
    const watcher = watch(shared.canonicalRoot, {
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      followSymlinks: false,
      ignoreInitial: true,
      ignored: (candidatePath) => isIgnored(shared, candidatePath),
      persistent: true,
    });
    shared.watcher = watcher;
    watcher.on("all", (eventName, changedPath) => recordPath(shared, eventName, changedPath));
    watcher.on("error", () => {
      requireResync(shared, "watcher-error");
      restart(shared);
    });
    watcher.once("ready", () => {
      if (shared.closed || shared.watcher !== watcher) return;
      shared.ready = true;
      emit(shared, { version: 1, sequence: shared.sequence, type: "ready" });
    });
  };

  const startParentWatcher = (shared: SharedWatcher) => {
    if (shared.closed || shared.parentWatcher !== null) return;
    const parentPath = path.dirname(shared.canonicalRoot);
    const rootName = path.basename(shared.canonicalRoot);
    const parentWatcher = NodeFS.watch(parentPath, { persistent: true }, (_event, filename) => {
      if (filename === null || filename.toString() !== rootName || shared.closed) return;
      void NodeFSP.stat(shared.canonicalRoot)
        .then((stat) => {
          if (!stat.isDirectory()) {
            requireResync(shared, "root-deleted");
            restart(shared);
          } else if (!shared.ready) {
            scheduleRestart(shared);
          }
        })
        .catch(() => {
          requireResync(shared, "root-deleted");
          restart(shared);
        });
    });
    shared.parentWatcher = parentWatcher;
    parentWatcher.on("error", () => {
      requireResync(shared, "watcher-error");
      parentWatcher.close();
      if (shared.parentWatcher === parentWatcher) shared.parentWatcher = null;
    });
  };

  const scheduleRestart = (shared: SharedWatcher) => {
    if (shared.closed || shared.restartTimer !== null) return;
    // @effect-diagnostics-next-line globalTimers:off
    shared.restartTimer = setTimeout(() => {
      shared.restartTimer = null;
      if (shared.closed) return;
      void NodeFSP.stat(shared.canonicalRoot)
        .then((stat) => {
          if (stat.isDirectory()) start(shared);
          else scheduleRestart(shared);
        })
        .catch(() => scheduleRestart(shared));
    }, RESTART_DELAY_MS);
  };

  function restart(shared: SharedWatcher) {
    if (shared.closed) return;
    shared.ready = false;
    const watcher = shared.watcher;
    shared.watcher = null;
    if (watcher === null) {
      scheduleRestart(shared);
      return;
    }
    void watcher.close().finally(() => scheduleRestart(shared));
  }

  const acquireSharedWatcher = (canonicalRoot: string): SharedWatcher => {
    const existing = sharedWatchers.get(canonicalRoot);
    if (existing) return existing;
    const shared: SharedWatcher = {
      canonicalRoot,
      listeners: new Set(),
      watcher: null,
      parentWatcher: null,
      ready: false,
      closed: false,
      sequence: 0,
      pendingContentPaths: new Set(),
      pendingStructuralPaths: new Set(),
      pendingResyncReason: null,
      flushTimer: null,
      restartTimer: null,
    };
    sharedWatchers.set(canonicalRoot, shared);
    startParentWatcher(shared);
    start(shared);
    return shared;
  };

  const releaseSharedWatcher = (shared: SharedWatcher) =>
    Effect.promise(async () => {
      if (shared.listeners.size > 0) return;
      shared.closed = true;
      sharedWatchers.delete(shared.canonicalRoot);
      if (shared.flushTimer !== null) clearTimeout(shared.flushTimer);
      if (shared.restartTimer !== null) clearTimeout(shared.restartTimer);
      shared.flushTimer = null;
      shared.restartTimer = null;
      const watcher = shared.watcher;
      shared.watcher = null;
      shared.parentWatcher?.close();
      shared.parentWatcher = null;
      if (watcher !== null) await watcher.close();
    });

  const subscribe: WorkspaceFileEvents["Service"]["subscribe"] = Effect.fn(
    "WorkspaceFileEvents.subscribe",
  )(function* (input) {
    const normalizedCwd = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
    const canonicalRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(normalizedCwd),
      catch: (cause) =>
        new WorkspacePaths.WorkspaceRootStatFailedError({
          workspaceRoot: input.cwd,
          normalizedWorkspaceRoot: normalizedCwd,
          phase: "validate-existing",
          cause,
        }),
    });

    return Stream.callback<ProjectFileEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const shared = acquireSharedWatcher(canonicalRoot);
          const listener = (event: SharedEvent) => {
            Queue.offerUnsafe(queue, { ...event, cwd: input.cwd } as ProjectFileEvent);
          };
          shared.listeners.add(listener);
          // Every subscription, including a transport reconnect reusing an
          // existing shared watcher, starts with an authoritative refresh.
          if (shared.ready) listener({ version: 1, sequence: shared.sequence, type: "ready" });
          return { listener, shared };
        }),
        ({ listener, shared }) =>
          Effect.sync(() => shared.listeners.delete(listener)).pipe(
            Effect.andThen(releaseSharedWatcher(shared)),
          ),
      ),
    );
  });

  return WorkspaceFileEvents.of({ subscribe });
});

export const layer = Layer.effect(WorkspaceFileEvents, make);
