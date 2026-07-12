import {
  PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH,
  PROJECT_SEARCH_TEXT_MAX_PATTERNS_PER_LIST,
  PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeWorkspaceSearchGlobInput,
  normalizeWorkspaceSearchQuery,
  parseWorkspaceSearchGlobs,
  WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH,
} from "./workspaceSearchInput";

describe("workspace search input normalization", () => {
  it("bounds pasted queries by UTF-16 code units", () => {
    const query = `${"q".repeat(PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH - 1)}😀tail`;

    expect(
      normalizeWorkspaceSearchQuery("q".repeat(PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH + 10)),
    ).toHaveLength(PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH);
    const normalized = normalizeWorkspaceSearchQuery(query);
    expect(normalized).toHaveLength(PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH - 1);
    expect(normalized.charCodeAt(normalized.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
    expect(
      normalizeWorkspaceSearchQuery(
        `${"q".repeat(PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH - 1)}\ud83d`,
      ),
    ).toHaveLength(PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH - 1);
  });

  it("bounds every glob and the number of non-empty patterns", () => {
    const values = Array.from(
      { length: PROJECT_SEARCH_TEXT_MAX_PATTERNS_PER_LIST + 8 },
      (_, index) => `  pattern-${index}-${"x".repeat(PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH - 20)}  `,
    );

    const patterns = parseWorkspaceSearchGlobs(`, ,${values.join(",")}`);

    expect(patterns).toHaveLength(PROJECT_SEARCH_TEXT_MAX_PATTERNS_PER_LIST);
    expect(patterns.every((pattern) => pattern.length <= PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH)).toBe(
      true,
    );
    expect(patterns[0]?.startsWith("pattern-0-")).toBe(true);
    expect(
      parseWorkspaceSearchGlobs("y".repeat(PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH + 20))[0],
    ).toHaveLength(PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH);
    expect(
      parseWorkspaceSearchGlobs(`${"y".repeat(PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH - 1)}😀tail`)[0],
    ).toHaveLength(PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH - 1);
    expect(
      parseWorkspaceSearchGlobs(`${"y".repeat(PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH - 1)}\ud83d`)[0],
    ).toHaveLength(PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH - 1);
  });

  it("bounds huge raw glob input before parsing it", () => {
    const rawInput = "x".repeat(WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH + 100_000);

    expect(normalizeWorkspaceSearchGlobInput(rawInput)).toHaveLength(
      WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH,
    );
    expect(parseWorkspaceSearchGlobs(rawInput)).toEqual([
      "x".repeat(PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH),
    ]);
    expect(
      normalizeWorkspaceSearchGlobInput(
        `${"x".repeat(WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH - 1)}😀tail`,
      ),
    ).toHaveLength(WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH - 1);
  });
});
