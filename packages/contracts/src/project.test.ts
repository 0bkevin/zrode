import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectFileDiskRevision,
  ProjectReadFileError,
  ProjectFileEvent,
  ProjectSearchEntriesError,
  ProjectSearchTextEvent,
  ProjectSearchTextInput,
  ProjectWriteFileError,
  ProjectWriteFileInput,
} from "./project.ts";

const decodeProjectFileDiskRevision = Schema.decodeUnknownSync(ProjectFileDiskRevision);
const decodeProjectCreateDirectoryInput = Schema.decodeUnknownSync(ProjectCreateDirectoryInput);
const decodeProjectCreateDirectoryResult = Schema.decodeUnknownSync(ProjectCreateDirectoryResult);

describe("project RPC errors", () => {
  it("derives stable messages from structured request context while retaining causes", () => {
    const cause = new Error("sensitive platform detail");
    const searchError = new ProjectSearchEntriesError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 20,
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      detail: "index unavailable",
      cause,
    });
    const readError = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "src/index.ts",
      failure: "operation_failed",
      operation: "read",
      operationPath: "/workspace/src/index.ts",
      resolvedPath: "/workspace/src/index.ts",
      cause,
    });

    expect(searchError.message).toBe("Failed to search workspace entries in '/workspace'.");
    expect(searchError.message).not.toContain(cause.message);
    expect(searchError.normalizedCwd).toBe("/workspace");
    expect(searchError.queryLength).toBe("authorization: Bearer secret-token".length);
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.message).not.toMatch(/Bearer|secret-token/);
    expect(searchError.cause).toBe(cause);
    expect(readError.message).toBe("Failed to read workspace file 'src/index.ts' in '/workspace'.");
    expect(readError.message).not.toContain(cause.message);
    expect(readError.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeSearchError = Schema.decodeUnknownSync(ProjectSearchEntriesError);
    const decodeWriteError = Schema.decodeUnknownSync(ProjectWriteFileError);

    const searchError = decodeSearchError({
      _tag: "ProjectSearchEntriesError",
      message: "Legacy project search failure.",
      query: "legacy sensitive query",
    });
    const writeError = decodeWriteError({
      _tag: "ProjectWriteFileError",
      message: "Legacy project write failure.",
    });

    expect(searchError.message).toBe("Legacy project search failure.");
    expect(searchError.cwd).toBeUndefined();
    expect(searchError.queryLength).toBeUndefined();
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.failure).toBeUndefined();
    expect(writeError.message).toBe("Legacy project write failure.");
    expect(writeError.relativePath).toBeUndefined();
    expect(writeError.failure).toBeUndefined();
  });
});

describe("project file revisions", () => {
  const revision = `sha256:${"a".repeat(64)}:42`;

  it("accepts bounded, content-addressed disk revision tokens", () => {
    expect(decodeProjectFileDiskRevision(revision)).toBe(revision);
    expect(() => decodeProjectFileDiskRevision("mtime:42")).toThrow();
  });

  it("requires an explicit write precondition", () => {
    const decode = Schema.decodeUnknownSync(ProjectWriteFileInput);

    expect(
      decode({
        cwd: "/workspace",
        relativePath: "src/index.ts",
        contents: "export {};\n",
        precondition: { _tag: "match", diskRevision: revision },
      }).precondition,
    ).toEqual({ _tag: "match", diskRevision: revision });
    expect(() =>
      decode({
        cwd: "/workspace",
        relativePath: "src/index.ts",
        contents: "export {};\n",
      }),
    ).toThrow();
  });
});

describe("project file events", () => {
  const decode = Schema.decodeUnknownSync(ProjectFileEvent);

  it("keeps path changes explicitly lossy and bounded", () => {
    expect(
      decode({
        version: 1,
        sequence: 2,
        type: "changed",
        cwd: "/workspace",
        contentPaths: ["src/index.ts", " leading and trailing .ts "],
        structuralPaths: ["src/renamed.ts"],
      }),
    ).toMatchObject({ type: "changed", sequence: 2 });
    expect(() =>
      decode({
        version: 1,
        sequence: 3,
        type: "changed",
        cwd: "/workspace",
        contentPaths: Array.from({ length: 257 }, (_, index) => `file-${index}.ts`),
        structuralPaths: [],
      }),
    ).toThrow();
  });
});

describe("project workspace editing contracts", () => {
  it("decodes directory creation inputs and results", () => {
    expect(
      decodeProjectCreateDirectoryInput({
        cwd: "/workspace",
        relativePath: "src/features",
      }),
    ).toEqual({ cwd: "/workspace", relativePath: "src/features" });
    expect(
      decodeProjectCreateDirectoryResult({
        relativePath: "src/features",
      }),
    ).toEqual({ relativePath: "src/features" });
  });

  it("bounds text searches and exposes streamed matches with UTF-16 columns", () => {
    const decodeInput = Schema.decodeUnknownSync(ProjectSearchTextInput);
    const decodeEvent = Schema.decodeUnknownSync(ProjectSearchTextEvent);
    expect(
      decodeInput({
        cwd: "/workspace",
        query: "needle",
        isRegex: false,
        matchCase: false,
        wholeWord: true,
        includes: ["src/**"],
        excludes: ["**/*.test.ts"],
        limit: 200,
      }).wholeWord,
    ).toBe(true);
    expect(
      decodeEvent({
        type: "matches",
        matches: [
          {
            relativePath: "src/index.ts",
            line: 1,
            column: 5,
            endColumn: 11,
            lineTextStartColumn: 1,
            lineText: "😀é needle",
            matchText: "needle",
          },
        ],
      }),
    ).toMatchObject({ type: "matches" });
    expect(() =>
      decodeInput({
        cwd: "/workspace",
        query: "needle",
        isRegex: false,
        matchCase: false,
        wholeWord: false,
        includes: [],
        excludes: [],
        limit: 2_001,
      }),
    ).toThrow();
  });
});
