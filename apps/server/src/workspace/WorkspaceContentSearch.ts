// @effect-diagnostics nodeBuiltinImport:off
/** Streamed, bounded workspace content search backed by ripgrep's JSON output. */
import { rgPath } from "@vscode/ripgrep-universal";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type {
  ProjectSearchTextEvent,
  ProjectSearchTextInput,
  ProjectSearchTextMatch,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { appendBoundedBytes, decodeBoundedBytes } from "../process/boundedOutput.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const SEARCH_BATCH_SIZE = 32;
const SEARCH_LINE_PREVIEW_CODE_UNITS = 4_096;
const SEARCH_MAX_COLUMNS = 20_000;
const SEARCH_MAX_JSON_LINE_BYTES = 256 * 1_024;
const SEARCH_MAX_SUBMATCHES_PER_RECORD = 256;
const SEARCH_RUNTIME_TIMEOUT = "30 seconds";
const SEARCH_GLOBAL_CONCURRENCY = 4;
const SEARCH_PER_WORKSPACE_CONCURRENCY = 2;
const MAX_STDERR_LENGTH = 8_192;
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

export class WorkspaceContentSearchProcessError extends Schema.TaggedErrorClass<WorkspaceContentSearchProcessError>()(
  "WorkspaceContentSearchProcessError",
  {
    cwd: Schema.String,
    operation: Schema.Literals(["spawn", "read-output", "wait-exit"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace text search process failed during '${this.operation}' in '${this.cwd}'.`;
  }
}

export class WorkspaceContentSearchOutputParseError extends Schema.TaggedErrorClass<WorkspaceContentSearchOutputParseError>()(
  "WorkspaceContentSearchOutputParseError",
  {
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace text search returned invalid JSON output in '${this.cwd}'.`;
  }
}

export class WorkspaceContentSearchCommandError extends Schema.TaggedErrorClass<WorkspaceContentSearchCommandError>()(
  "WorkspaceContentSearchCommandError",
  {
    cwd: Schema.String,
    exitCode: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace text search failed with exit code ${this.exitCode} in '${this.cwd}'.`;
  }
}

export class WorkspaceContentSearchOutputLimitError extends Schema.TaggedErrorClass<WorkspaceContentSearchOutputLimitError>()(
  "WorkspaceContentSearchOutputLimitError",
  {
    cwd: Schema.String,
    limit: Schema.Number,
    observed: Schema.Number,
  },
) {
  override get message(): string {
    return `Workspace text search output exceeded the ${this.limit}-byte JSON line limit in '${this.cwd}'.`;
  }
}

export class WorkspaceContentSearchTimeoutError extends Schema.TaggedErrorClass<WorkspaceContentSearchTimeoutError>()(
  "WorkspaceContentSearchTimeoutError",
  {
    cwd: Schema.String,
    timeoutMillis: Schema.Number,
  },
) {
  override get message(): string {
    return `Workspace text search exceeded ${this.timeoutMillis}ms in '${this.cwd}'.`;
  }
}

const isWorkspaceContentSearchOutputParseError = Schema.is(WorkspaceContentSearchOutputParseError);
const isWorkspaceContentSearchOutputLimitError = Schema.is(WorkspaceContentSearchOutputLimitError);

export type WorkspaceContentSearchError =
  | WorkspaceContentSearchProcessError
  | WorkspaceContentSearchOutputParseError
  | WorkspaceContentSearchOutputLimitError
  | WorkspaceContentSearchTimeoutError
  | WorkspaceContentSearchCommandError
  | WorkspacePaths.WorkspaceRootNotExistsError
  | WorkspacePaths.WorkspaceRootCreateFailedError
  | WorkspacePaths.WorkspaceRootStatFailedError
  | WorkspacePaths.WorkspaceRootNotDirectoryError;

export class WorkspaceContentSearch extends Context.Service<
  WorkspaceContentSearch,
  {
    readonly search: (
      input: ProjectSearchTextInput,
    ) => Stream.Stream<ProjectSearchTextEvent, WorkspaceContentSearchError>;
  }
>()("t3/workspace/WorkspaceContentSearch") {}

/** Resolve Electron's unpacked sibling for native binaries embedded under app.asar. */
export function resolveUnpackedAsarPath(binaryPath: string): string {
  const asarSegment = `${NodePath.sep}app.asar${NodePath.sep}`;
  if (!binaryPath.includes(asarSegment)) return binaryPath;
  const unpackedPath = binaryPath.replace(
    asarSegment,
    `${NodePath.sep}app.asar.unpacked${NodePath.sep}`,
  );
  return NodeFS.existsSync(unpackedPath) ? unpackedPath : binaryPath;
}

export interface WorkspaceContentSearchMakeOptions {
  readonly executablePath?: string;
  readonly argumentPrefix?: ReadonlyArray<string>;
  readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly runtimeTimeout?: Duration.Input | ((input: ProjectSearchTextInput) => Duration.Input);
  readonly maxJsonLineBytes?: number;
  readonly maxSubmatchesPerRecord?: number;
  readonly globalConcurrency?: number;
  readonly perWorkspaceConcurrency?: number;
  /** Test instrumentation, invoked only after the child was spawned. */
  readonly onProcessStart?: (cwd: string) => Effect.Effect<void>;
  /** Test instrumentation, invoked after the child was stopped or observed exited. */
  readonly onProcessFinalize?: (cwd: string) => Effect.Effect<void>;
}

export function buildRipgrepArguments(input: ProjectSearchTextInput): ReadonlyArray<string> {
  const args: Array<string> = [
    "--no-config",
    "--json",
    "--hidden",
    "--color",
    "never",
    "--max-columns",
    String(SEARCH_MAX_COLUMNS),
    "--max-columns-preview",
  ];
  if (!input.isRegex) args.push("--fixed-strings");
  if (!input.matchCase) args.push("--ignore-case");
  if (input.wholeWord) args.push("--word-regexp");
  for (const include of input.includes) args.push("--glob", include);
  for (const exclude of input.excludes) args.push("--glob", `!${exclude}`);
  args.push("--glob", "!**/.git/**", "--", input.query, ".");
  return args;
}

type RipgrepSubmatch = {
  readonly start: number;
  readonly end: number;
};

type RipgrepMatch = {
  readonly path: string;
  readonly lineText: string;
  readonly line: number;
  readonly submatches: ReadonlyArray<RipgrepSubmatch>;
  readonly submatchesTruncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTextField(value: unknown): string | null {
  return isRecord(value) && typeof value.text === "string" ? value.text : null;
}

function parseRipgrepMatch(value: unknown, maxSubmatches: number): RipgrepMatch | null {
  if (!isRecord(value) || value.type !== "match" || !isRecord(value.data)) return null;
  const path = readTextField(value.data.path);
  const lineText = readTextField(value.data.lines);
  const line = value.data.line_number;
  const rawSubmatches = value.data.submatches;
  if (
    path === null ||
    lineText === null ||
    typeof line !== "number" ||
    !Number.isSafeInteger(line) ||
    line < 1 ||
    !Array.isArray(rawSubmatches)
  ) {
    throw new Error("Malformed ripgrep match record.");
  }
  const submatchCount = Math.min(rawSubmatches.length, maxSubmatches);
  const submatches: Array<RipgrepSubmatch> = [];
  for (let index = 0; index < submatchCount; index += 1) {
    const submatch = rawSubmatches[index];
    if (
      !isRecord(submatch) ||
      typeof submatch.start !== "number" ||
      typeof submatch.end !== "number" ||
      !Number.isSafeInteger(submatch.start) ||
      !Number.isSafeInteger(submatch.end) ||
      submatch.start < 0 ||
      submatch.end < submatch.start
    ) {
      throw new Error("Malformed ripgrep submatch record.");
    }
    submatches.push({ start: submatch.start, end: submatch.end });
  }
  return {
    path,
    lineText,
    line,
    submatches,
    submatchesTruncated: rawSubmatches.length > submatchCount,
  };
}

function normalizeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

/** Convert ripgrep's UTF-8 byte offsets to JS/browser UTF-16 slice offsets. */
function matchesFromRipgrepRecord(record: RipgrepMatch): ReadonlyArray<ProjectSearchTextMatch> {
  const lineBytes = Buffer.from(record.lineText, "utf8");
  const lineText = record.lineText.replace(/\r?\n$/, "");
  const byteOffsets = new Set<number>([0]);
  for (const { start, end } of record.submatches) {
    if (end > lineBytes.byteLength) throw new Error("Ripgrep submatch exceeds line bytes.");
    byteOffsets.add(start);
    byteOffsets.add(end);
  }
  const utf16Offsets = new Map<number, number>();
  let previousByteOffset = 0;
  let previousUtf16Offset = 0;
  for (const byteOffset of [...byteOffsets].toSorted((left, right) => left - right)) {
    previousUtf16Offset += lineBytes
      .subarray(previousByteOffset, byteOffset)
      .toString("utf8").length;
    utf16Offsets.set(byteOffset, previousUtf16Offset);
    previousByteOffset = byteOffset;
  }
  return record.submatches.map(({ start, end }) => {
    const matchStart = utf16Offsets.get(start);
    const matchEnd = utf16Offsets.get(end);
    if (matchStart === undefined || matchEnd === undefined) {
      throw new Error("Ripgrep submatch offsets were not indexed.");
    }
    const matchLength = matchEnd - matchStart;
    const contextLength = Math.max(
      0,
      Math.floor((SEARCH_LINE_PREVIEW_CODE_UNITS - matchLength) / 2),
    );
    const previewStart = Math.min(
      Math.max(0, matchStart - contextLength),
      Math.max(0, lineText.length - SEARCH_LINE_PREVIEW_CODE_UNITS),
    );
    const previewEnd = Math.min(lineText.length, previewStart + SEARCH_LINE_PREVIEW_CODE_UNITS);
    return {
      relativePath: normalizeRelativePath(record.path),
      line: record.line,
      column: matchStart + 1,
      endColumn: matchEnd + 1,
      lineTextStartColumn: previewStart + 1,
      lineText: lineText.slice(previewStart, previewEnd),
      matchText: lineText.slice(
        matchStart,
        Math.min(matchEnd, matchStart + SEARCH_LINE_PREVIEW_CODE_UNITS),
      ),
    };
  });
}

function joinBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left;
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

function decodeJsonLine(bytes: Uint8Array): string {
  const length = bytes.at(-1) === 13 ? bytes.byteLength - 1 : bytes.byteLength;
  return Buffer.from(bytes.buffer, bytes.byteOffset, length).toString("utf8");
}

function frameNdjson<E, R>(
  cwd: string,
  source: Stream.Stream<Uint8Array, E, R>,
  maxLineBytes: number,
): Stream.Stream<string, E | WorkspaceContentSearchOutputLimitError, R> {
  const framedInput = Stream.concat(
    source.pipe(Stream.map((bytes) => ({ _tag: "chunk" as const, bytes }))),
    Stream.make({ _tag: "end" as const }),
  );
  return framedInput.pipe(
    Stream.mapAccumEffect(
      (): Uint8Array<ArrayBufferLike> => new Uint8Array(0),
      (
        pending: Uint8Array<ArrayBufferLike>,
        item,
      ): Effect.Effect<
        readonly [Uint8Array<ArrayBufferLike>, ReadonlyArray<string>],
        WorkspaceContentSearchOutputLimitError
      > =>
        Effect.gen(function* () {
          if (item._tag === "end") {
            return [
              new Uint8Array(0),
              pending.byteLength > 0 ? [decodeJsonLine(pending)] : [],
            ] as const;
          }

          const lines: Array<string> = [];
          let segmentStart = 0;
          let nextPending = pending;
          for (let index = 0; index < item.bytes.byteLength; index += 1) {
            if (item.bytes[index] !== 10) continue;
            const segment = item.bytes.subarray(segmentStart, index);
            const observed = nextPending.byteLength + segment.byteLength;
            if (observed > maxLineBytes) {
              return yield* new WorkspaceContentSearchOutputLimitError({
                cwd,
                limit: maxLineBytes,
                observed,
              });
            }
            lines.push(decodeJsonLine(joinBytes(nextPending, segment)));
            nextPending = new Uint8Array(0);
            segmentStart = index + 1;
          }

          const tail = item.bytes.subarray(segmentStart);
          const observed = nextPending.byteLength + tail.byteLength;
          if (observed > maxLineBytes) {
            return yield* new WorkspaceContentSearchOutputLimitError({
              cwd,
              limit: maxLineBytes,
              observed,
            });
          }
          return [joinBytes(nextPending, tail), lines] as const;
        }),
    ),
  );
}

type WorkspaceSearchGate = {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const makeWithOptions = (options: WorkspaceContentSearchMakeOptions = {}) =>
  Effect.gen(function* () {
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const globalConcurrency = positiveInteger(options.globalConcurrency, SEARCH_GLOBAL_CONCURRENCY);
    const perWorkspaceConcurrency = positiveInteger(
      options.perWorkspaceConcurrency,
      SEARCH_PER_WORKSPACE_CONCURRENCY,
    );
    const maxJsonLineBytes = positiveInteger(options.maxJsonLineBytes, SEARCH_MAX_JSON_LINE_BYTES);
    const maxSubmatchesPerRecord = positiveInteger(
      options.maxSubmatchesPerRecord,
      SEARCH_MAX_SUBMATCHES_PER_RECORD,
    );
    const globalSemaphore = yield* Semaphore.make(globalConcurrency);
    const workspaceGatesRef = yield* Ref.make<ReadonlyMap<string, WorkspaceSearchGate>>(new Map());

    const acquireWorkspaceGate = (cwd: string) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const candidate = yield* Semaphore.make(perWorkspaceConcurrency);
          return yield* Ref.modify(workspaceGatesRef, (gates) => {
            const existing = gates.get(cwd);
            const semaphore = existing?.semaphore ?? candidate;
            const next = new Map(gates);
            next.set(cwd, { semaphore, users: (existing?.users ?? 0) + 1 });
            return [semaphore, next] as const;
          });
        }),
        () =>
          Ref.update(workspaceGatesRef, (gates) => {
            const existing = gates.get(cwd);
            if (!existing) return gates;
            const next = new Map(gates);
            if (existing.users === 1) next.delete(cwd);
            else next.set(cwd, { ...existing, users: existing.users - 1 });
            return next;
          }),
      );

    const search: WorkspaceContentSearch["Service"]["search"] = (input) => {
      const runtimeTimeout =
        typeof options.runtimeTimeout === "function"
          ? options.runtimeTimeout(input)
          : (options.runtimeTimeout ?? SEARCH_RUNTIME_TIMEOUT);
      const timeoutMillis = Duration.toMillis(Duration.fromInputUnsafe(runtimeTimeout));
      return Stream.unwrap(
        Effect.gen(function* () {
          const cwd = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
          const workspaceSemaphore = yield* acquireWorkspaceGate(cwd);
          yield* Effect.acquireRelease(workspaceSemaphore.take(1), () =>
            workspaceSemaphore.release(1),
          );
          yield* Effect.acquireRelease(globalSemaphore.take(1), () => globalSemaphore.release(1));

          const command = options.executablePath ?? resolveUnpackedAsarPath(rgPath);
          const args = [...(options.argumentPrefix ?? []), ...buildRipgrepArguments(input)];
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(command, args, {
                cwd,
                ...(options.processEnvironment
                  ? { env: { ...options.processEnvironment }, extendEnv: true }
                  : {}),
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceContentSearchProcessError({ cwd, operation: "spawn", cause }),
              ),
            );
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* handle.isRunning.pipe(
                Effect.flatMap((running) => (running ? handle.kill() : Effect.void)),
                Effect.ignore,
              );
              yield* options.onProcessFinalize?.(cwd) ?? Effect.void;
            }),
          );
          yield* options.onProcessStart?.(cwd) ?? Effect.void;

          const stderrRef = yield* Ref.make<Uint8Array>(new Uint8Array(0));
          const stderrFiber = yield* handle.stderr.pipe(
            Stream.runForEach((chunk) =>
              Ref.update(stderrRef, (current) =>
                appendBoundedBytes(current, chunk, MAX_STDERR_LENGTH),
              ),
            ),
            Effect.mapError(
              (cause) =>
                new WorkspaceContentSearchProcessError({
                  cwd,
                  operation: "read-output",
                  cause,
                }),
            ),
            Effect.forkScoped,
          );
          const truncatedRef = yield* Ref.make(false);
          const matchCountRef = yield* Ref.make(0);
          const matchedFilesRef = yield* Ref.make<ReadonlySet<string>>(new Set());

          const parsedMatches = frameNdjson(cwd, handle.stdout, maxJsonLineBytes).pipe(
            Stream.mapEffect((line) =>
              Effect.try({
                try: () => parseRipgrepMatch(decodeUnknownJson(line), maxSubmatchesPerRecord),
                catch: (cause) =>
                  new WorkspaceContentSearchOutputParseError({
                    cwd,
                    detail: "A ripgrep JSON line could not be decoded.",
                    cause,
                  }),
              }).pipe(
                Effect.tap((record) =>
                  record?.submatchesTruncated ? Ref.set(truncatedRef, true) : Effect.void,
                ),
                Effect.map((record) => (record === null ? [] : matchesFromRipgrepRecord(record))),
              ),
            ),
            Stream.flatMap(Stream.fromIterable),
            Stream.mapError((cause) =>
              isWorkspaceContentSearchOutputParseError(cause) ||
              isWorkspaceContentSearchOutputLimitError(cause)
                ? cause
                : new WorkspaceContentSearchProcessError({
                    cwd,
                    operation: "read-output",
                    cause,
                  }),
            ),
          );

          const validateExit = Effect.gen(function* () {
            const exitCode = yield* handle.exitCode.pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceContentSearchProcessError({
                    cwd,
                    operation: "wait-exit",
                    cause,
                  }),
              ),
            );
            yield* Fiber.join(stderrFiber).pipe(Effect.ignore);
            if (
              exitCode !== ChildProcessSpawner.ExitCode(0) &&
              exitCode !== ChildProcessSpawner.ExitCode(1)
            ) {
              const stderr = decodeBoundedBytes(yield* Ref.get(stderrRef)).trim();
              return yield* new WorkspaceContentSearchCommandError({
                cwd,
                exitCode,
                detail: stderr || "ripgrep exited without an error message.",
              });
            }
          });

          const boundedMatches = Stream.concat(
            parsedMatches,
            Stream.fromEffect(validateExit).pipe(Stream.drain),
          ).pipe(
            Stream.mapEffect((match) =>
              Ref.get(matchCountRef).pipe(
                Effect.flatMap((count) => {
                  if (count >= input.limit) {
                    return Ref.set(truncatedRef, true).pipe(Effect.as(null));
                  }
                  return Effect.all([
                    Ref.set(matchCountRef, count + 1),
                    Ref.update(matchedFilesRef, (files) => new Set(files).add(match.relativePath)),
                  ]).pipe(Effect.as(match));
                }),
              ),
            ),
            Stream.takeUntil((match) => match === null),
            Stream.filter((match): match is ProjectSearchTextMatch => match !== null),
          );

          const matchEvents = boundedMatches.pipe(
            Stream.grouped(SEARCH_BATCH_SIZE),
            Stream.map(
              (matches): ProjectSearchTextEvent => ({
                type: "matches",
                matches: Array.from(matches),
              }),
            ),
          );
          const completeEvent = Stream.fromEffect(
            Effect.all([
              Ref.get(matchCountRef),
              Ref.get(matchedFilesRef),
              Ref.get(truncatedRef),
            ]).pipe(
              Effect.map(
                ([matchCount, matchedFiles, truncated]): ProjectSearchTextEvent => ({
                  type: "complete",
                  matchCount,
                  fileCount: matchedFiles.size,
                  truncated,
                }),
              ),
            ),
          );
          return Stream.concat(matchEvents, completeEvent);
        }),
      ).pipe(
        Stream.interruptWhen(
          Effect.sleep(runtimeTimeout).pipe(
            Effect.andThen(
              Effect.fail(
                new WorkspaceContentSearchTimeoutError({ cwd: input.cwd, timeoutMillis }),
              ),
            ),
          ),
        ),
      );
    };

    return WorkspaceContentSearch.of({ search });
  });

export const make = makeWithOptions();

export const layer = Layer.effect(WorkspaceContentSearch, make);
