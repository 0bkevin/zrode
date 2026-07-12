import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProjectSearchTextInput, ProjectSearchTextMatch } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as WorkspaceContentSearch from "./WorkspaceContentSearch.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const SearchLayer = WorkspaceContentSearch.layer.pipe(Layer.provide(WorkspacePaths.layer));
const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(SearchLayer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "zrode-workspace-content-search-",
  });
});

const writeTextFile = Effect.fn("WorkspaceContentSearchTest.writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

function input(
  cwd: string,
  overrides: Partial<Omit<ProjectSearchTextInput, "cwd">> = {},
): ProjectSearchTextInput {
  return {
    cwd,
    query: "needle",
    isRegex: false,
    matchCase: false,
    wholeWord: false,
    includes: [],
    excludes: [],
    limit: 100,
    ...overrides,
  };
}

function collectMatches(
  events: ReadonlyArray<
    | { readonly type: "matches"; readonly matches: ReadonlyArray<ProjectSearchTextMatch> }
    | { readonly type: "complete" }
  >,
): ReadonlyArray<ProjectSearchTextMatch> {
  return events.flatMap((event) => (event.type === "matches" ? event.matches : []));
}

const writeNodeScript = Effect.fn("WorkspaceContentSearchTest.writeNodeScript")(function* (
  cwd: string,
  name: string,
  source: string,
) {
  const path = yield* Path.Path;
  yield* writeTextFile(cwd, name, source);
  return path.join(cwd, name);
});

describe("buildRipgrepArguments", () => {
  it("uses an argv array and terminates options before the query", () => {
    expect(
      WorkspaceContentSearch.buildRipgrepArguments(
        input("/workspace", {
          query: "--glob=*; echo unsafe",
          isRegex: true,
          matchCase: true,
          wholeWord: true,
          includes: ["src/**"],
          excludes: ["**/*.test.ts"],
        }),
      ),
    ).toEqual([
      "--no-config",
      "--json",
      "--hidden",
      "--color",
      "never",
      "--max-columns",
      "20000",
      "--max-columns-preview",
      "--word-regexp",
      "--glob",
      "src/**",
      "--glob",
      "!**/*.test.ts",
      "--glob",
      "!**/.git/**",
      "--",
      "--glob=*; echo unsafe",
      ".",
    ]);
  });
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceContentSearch", (it) => {
  it.effect("resolves packaged ripgrep binaries from app.asar.unpacked only when present", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempDir;
      const ordinary = path.join(root, "node_modules", "ripgrep", "rg");
      const packaged = path.join(root, "app.asar", "node_modules", "ripgrep", "rg");
      const unpacked = path.join(root, "app.asar.unpacked", "node_modules", "ripgrep", "rg");

      expect(WorkspaceContentSearch.resolveUnpackedAsarPath(ordinary)).toBe(ordinary);
      expect(WorkspaceContentSearch.resolveUnpackedAsarPath(packaged)).toBe(packaged);
      yield* fileSystem.makeDirectory(path.dirname(unpacked), { recursive: true });
      yield* fileSystem.writeFileString(unpacked, "binary");
      expect(WorkspaceContentSearch.resolveUnpackedAsarPath(packaged)).toBe(unpacked);
    }),
  );

  it.effect("applies literal, case, whole-word, include, and exclude options", () =>
    Effect.gen(function* () {
      const search = yield* WorkspaceContentSearch.WorkspaceContentSearch;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "src/a.ts", "😀é needle NEEDLE needlessly\n");
      yield* writeTextFile(cwd, "src/a.test.ts", "needle\n");
      yield* writeTextFile(cwd, "docs/a.md", "needle\n");

      const events = Array.from(
        yield* search
          .search(
            input(cwd, {
              matchCase: true,
              wholeWord: true,
              includes: ["src/**"],
              excludes: ["**/*.test.ts"],
            }),
          )
          .pipe(Stream.runCollect),
      );
      const matches = collectMatches(events);

      expect(matches).toEqual([
        {
          relativePath: "src/a.ts",
          line: 1,
          column: 5,
          endColumn: 11,
          lineTextStartColumn: 1,
          lineText: "😀é needle NEEDLE needlessly",
          matchText: "needle",
        },
      ]);
      expect(events.at(-1)).toEqual({
        type: "complete",
        matchCount: 1,
        fileCount: 1,
        truncated: false,
      });
    }),
  );

  it.effect("bounds previews for matches on very long lines", () =>
    Effect.gen(function* () {
      const search = yield* WorkspaceContentSearch.WorkspaceContentSearch;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "long.txt", `${"a".repeat(20_000)}needle tail\n`);

      const events = Array.from(yield* search.search(input(cwd)).pipe(Stream.runCollect));
      const [match] = collectMatches(events);

      expect(match).toMatchObject({
        relativePath: "long.txt",
        line: 1,
        column: 20_001,
        endColumn: 20_007,
        matchText: "needle",
      });
      expect(match?.lineText.length).toBeLessThanOrEqual(4_096);
      expect(match?.lineTextStartColumn).toBeGreaterThan(1);
      expect(
        match?.lineText.slice(
          match.column - match.lineTextStartColumn,
          match.endColumn - match.lineTextStartColumn,
        ),
      ).toBe("needle");
    }),
  );

  it.effect("ignores a hostile RIPGREP_CONFIG_PATH", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const path = yield* Path.Path;
      const configPath = path.join(cwd, "hostile-ripgrep.config");
      yield* writeTextFile(cwd, "hostile-ripgrep.config", "--ignore-case\n");
      yield* writeTextFile(cwd, "target.txt", "NEEDLE\n");
      const search = yield* WorkspaceContentSearch.makeWithOptions({
        processEnvironment: { RIPGREP_CONFIG_PATH: configPath },
      });

      const events = Array.from(
        yield* search
          .search(input(cwd, { query: "needle", matchCase: true }))
          .pipe(Stream.runCollect),
      );

      expect(collectMatches(events)).toEqual([]);
      expect(events.at(-1)).toEqual({
        type: "complete",
        matchCount: 0,
        fileCount: 0,
        truncated: false,
      });
    }),
  );

  it.effect("rejects an oversized JSON line before decoding it", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "hostile.txt", `${"x".repeat(5_000)}needle\n`);
      const search = yield* WorkspaceContentSearch.makeWithOptions({ maxJsonLineBytes: 1_024 });

      const error = yield* search.search(input(cwd)).pipe(Stream.runCollect, Effect.flip);

      expect(error).toBeInstanceOf(WorkspaceContentSearch.WorkspaceContentSearchOutputLimitError);
      expect(error).toMatchObject({ cwd, limit: 1_024 });
    }),
  );

  it.effect("rejects a hostile huge source line at the production framing limit", () =>
    Effect.gen(function* () {
      const search = yield* WorkspaceContentSearch.WorkspaceContentSearch;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "huge.txt", `${"x".repeat(300_000)}needle\n`);

      const error = yield* search.search(input(cwd)).pipe(Stream.runCollect, Effect.flip);

      expect(error).toBeInstanceOf(WorkspaceContentSearch.WorkspaceContentSearchOutputLimitError);
      expect(error).toMatchObject({ cwd, limit: 256 * 1_024 });
    }),
  );

  it.effect("caps submatches before mapping and marks the result truncated", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "many.txt", `${"a".repeat(100)}\n`);
      const search = yield* WorkspaceContentSearch.makeWithOptions({
        maxSubmatchesPerRecord: 8,
      });

      const events = Array.from(
        yield* search
          .search(input(cwd, { query: "a", matchCase: true, limit: 100 }))
          .pipe(Stream.runCollect),
      );

      expect(collectMatches(events)).toHaveLength(8);
      expect(events.at(-1)).toEqual({
        type: "complete",
        matchCount: 8,
        fileCount: 1,
        truncated: true,
      });
    }),
  );

  it.effect("times out a hostile process and runs its cancellation finalizer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      const markerPath = path.join(cwd, "timeout-killed");
      const scriptPath = yield* writeNodeScript(
        cwd,
        "hang-timeout.mjs",
        `import fs from "node:fs";
const marker = process.argv[2];
process.on("SIGTERM", () => { fs.writeFileSync(marker, "killed"); process.exit(0); });
setInterval(() => {}, 1_000);
`,
      );
      const finalized = yield* Ref.make(0);
      const search = yield* WorkspaceContentSearch.makeWithOptions({
        executablePath: process.execPath,
        argumentPrefix: [scriptPath, markerPath],
        runtimeTimeout: "100 millis",
        onProcessFinalize: () => Ref.update(finalized, (count) => count + 1),
      });

      const error = yield* search.search(input(cwd)).pipe(Stream.runCollect, Effect.flip);

      expect(error).toBeInstanceOf(WorkspaceContentSearch.WorkspaceContentSearchTimeoutError);
      expect(yield* fileSystem.readFileString(markerPath)).toBe("killed");
      expect(yield* Ref.get(finalized)).toBe(1);
    }),
  );

  it.effect("kills the child when a consumer cancels the result stream", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      const markerPath = path.join(cwd, "cancel-killed");
      const scriptPath = yield* writeNodeScript(
        cwd,
        "hang-after-output.mjs",
        `import fs from "node:fs";
const marker = process.argv[2];
process.on("SIGTERM", () => { fs.writeFileSync(marker, "killed"); process.exit(0); });
const event = { type: "match", data: { path: { text: "./file.txt" }, lines: { text: "needle\\n" }, line_number: 1, submatches: [{ start: 0, end: 6 }] } };
for (let index = 0; index < 32; index += 1) process.stdout.write(JSON.stringify(event) + "\\n");
setInterval(() => {}, 1_000);
`,
      );
      const search = yield* WorkspaceContentSearch.makeWithOptions({
        executablePath: process.execPath,
        argumentPrefix: [scriptPath, markerPath],
        runtimeTimeout: "5 seconds",
      });

      const events = Array.from(
        yield* search.search(input(cwd)).pipe(Stream.take(1), Stream.runCollect),
      );

      expect(events[0]?.type).toBe("matches");
      expect(yield* fileSystem.readFileString(markerPath)).toBe("killed");
    }),
  );

  it.effect("bounds concurrent searches per workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const scriptPath = yield* writeNodeScript(
          cwd,
          "hang-concurrency.mjs",
          "setInterval(() => {}, 1_000);\n",
        );
        const starts = yield* Ref.make(0);
        const active = yield* Ref.make(0);
        const maximum = yield* Ref.make(0);
        const twoStarted = yield* Deferred.make<void>();
        const search = yield* WorkspaceContentSearch.makeWithOptions({
          executablePath: process.execPath,
          argumentPrefix: [scriptPath],
          runtimeTimeout: "5 seconds",
          globalConcurrency: 4,
          perWorkspaceConcurrency: 2,
          onProcessStart: () =>
            Effect.gen(function* () {
              const activeCount = yield* Ref.updateAndGet(active, (count) => count + 1);
              yield* Ref.update(maximum, (current) => Math.max(current, activeCount));
              const startCount = yield* Ref.updateAndGet(starts, (count) => count + 1);
              if (startCount === 2) yield* Deferred.succeed(twoStarted, undefined);
            }),
          onProcessFinalize: () => Ref.update(active, (count) => count - 1),
        });
        const fibers = yield* Effect.forEach(["one", "two", "three"], (query) =>
          search.search(input(cwd, { query })).pipe(Stream.runDrain, Effect.forkScoped),
        );

        yield* Deferred.await(twoStarted).pipe(Effect.timeout("2 seconds"));
        yield* Effect.sleep("100 millis");
        expect(yield* Ref.get(starts)).toBe(2);
        expect(yield* Ref.get(maximum)).toBe(2);
        yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
        expect(yield* Ref.get(active)).toBe(0);
      }),
    ),
  );

  it.effect("starts the hard timeout while a search is waiting for a gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const scriptPath = yield* writeNodeScript(
          cwd,
          "hang-gate-timeout.mjs",
          "setInterval(() => {}, 1_000);\n",
        );
        const starts = yield* Ref.make(0);
        const holderStarted = yield* Deferred.make<void>();
        const search = yield* WorkspaceContentSearch.makeWithOptions({
          executablePath: process.execPath,
          argumentPrefix: [scriptPath],
          runtimeTimeout: (request) => (request.query === "holder" ? "5 seconds" : "100 millis"),
          globalConcurrency: 1,
          perWorkspaceConcurrency: 1,
          onProcessStart: () =>
            Ref.updateAndGet(starts, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 1 ? Deferred.succeed(holderStarted, undefined) : Effect.void,
              ),
              Effect.asVoid,
            ),
        });
        const holder = yield* search
          .search(input(cwd, { query: "holder" }))
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* Deferred.await(holderStarted).pipe(Effect.timeout("2 seconds"));

        const error = yield* search
          .search(input(cwd, { query: "waiter" }))
          .pipe(Stream.runCollect, Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceContentSearch.WorkspaceContentSearchTimeoutError);
        expect(yield* Ref.get(starts)).toBe(1);
        yield* Fiber.interrupt(holder);
      }),
    ),
  );

  it.effect("bounds concurrent searches globally across workspaces", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scriptCwd = yield* makeTempDir;
        const scriptPath = yield* writeNodeScript(
          scriptCwd,
          "hang-global.mjs",
          "setInterval(() => {}, 1_000);\n",
        );
        const workspaces = yield* Effect.all([makeTempDir, makeTempDir, makeTempDir]);
        const starts = yield* Ref.make(0);
        const active = yield* Ref.make(0);
        const maximum = yield* Ref.make(0);
        const twoStarted = yield* Deferred.make<void>();
        const search = yield* WorkspaceContentSearch.makeWithOptions({
          executablePath: process.execPath,
          argumentPrefix: [scriptPath],
          runtimeTimeout: "5 seconds",
          globalConcurrency: 2,
          perWorkspaceConcurrency: 2,
          onProcessStart: () =>
            Effect.gen(function* () {
              const activeCount = yield* Ref.updateAndGet(active, (count) => count + 1);
              yield* Ref.update(maximum, (current) => Math.max(current, activeCount));
              const startCount = yield* Ref.updateAndGet(starts, (count) => count + 1);
              if (startCount === 2) yield* Deferred.succeed(twoStarted, undefined);
            }),
          onProcessFinalize: () => Ref.update(active, (count) => count - 1),
        });
        const fibers = yield* Effect.forEach(workspaces, (cwd, index) =>
          search
            .search(input(cwd, { query: `query-${index}` }))
            .pipe(Stream.runDrain, Effect.forkScoped),
        );

        yield* Deferred.await(twoStarted).pipe(Effect.timeout("2 seconds"));
        yield* Effect.sleep("100 millis");
        expect(yield* Ref.get(starts)).toBe(2);
        expect(yield* Ref.get(maximum)).toBe(2);
        yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
        expect(yield* Ref.get(active)).toBe(0);
      }),
    ),
  );

  it.effect("streams regex matches up to the global limit and reports truncation", () =>
    Effect.gen(function* () {
      const search = yield* WorkspaceContentSearch.WorkspaceContentSearch;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "matches.txt", "Needle\nneedle\nNEEDLE\n");

      const events = Array.from(
        yield* search
          .search(
            input(cwd, {
              query: "n[e]{2}dle",
              isRegex: true,
              matchCase: false,
              limit: 2,
            }),
          )
          .pipe(Stream.runCollect),
      );

      expect(collectMatches(events)).toHaveLength(2);
      expect(events.at(-1)).toEqual({
        type: "complete",
        matchCount: 2,
        fileCount: 1,
        truncated: true,
      });
    }),
  );

  it.effect("emits a successful completion when ripgrep finds no matches", () =>
    Effect.gen(function* () {
      const search = yield* WorkspaceContentSearch.WorkspaceContentSearch;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "file.txt", "haystack\n");

      const events = Array.from(yield* search.search(input(cwd)).pipe(Stream.runCollect));

      expect(events).toEqual([{ type: "complete", matchCount: 0, fileCount: 0, truncated: false }]);
    }),
  );

  it.effect("returns structured command failures for invalid regular expressions", () =>
    Effect.gen(function* () {
      const search = yield* WorkspaceContentSearch.WorkspaceContentSearch;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "file.txt", "needle\n");

      const error = yield* search
        .search(input(cwd, { query: "(", isRegex: true }))
        .pipe(Stream.runCollect, Effect.flip);

      expect(error).toBeInstanceOf(WorkspaceContentSearch.WorkspaceContentSearchCommandError);
      expect(error).toMatchObject({ cwd, exitCode: 2 });
    }),
  );
});
