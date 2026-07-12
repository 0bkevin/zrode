import { describe, expect, it } from "@effect/vitest";

import {
  applyProjectSearchTextEvent,
  EMPTY_PROJECT_SEARCH_TEXT_SNAPSHOT,
} from "./projectCommands.ts";

describe("project text search accumulation", () => {
  it("appends streamed batches and adopts the authoritative completion counts", () => {
    const withMatches = applyProjectSearchTextEvent(EMPTY_PROJECT_SEARCH_TEXT_SNAPSHOT, {
      type: "matches",
      matches: [
        {
          relativePath: "src/index.ts",
          line: 3,
          column: 2,
          endColumn: 6,
          lineTextStartColumn: 1,
          lineText: " value",
          matchText: "valu",
        },
      ],
    });
    const complete = applyProjectSearchTextEvent(withMatches, {
      type: "complete",
      matchCount: 1,
      fileCount: 1,
      truncated: false,
    });

    expect(complete).toEqual({
      matches: [expect.objectContaining({ relativePath: "src/index.ts", line: 3 })],
      matchCount: 1,
      fileCount: 1,
      truncated: false,
      complete: true,
    });
  });
});
