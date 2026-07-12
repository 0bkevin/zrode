import {
  PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH,
  PROJECT_SEARCH_TEXT_MAX_PATTERNS_PER_LIST,
  PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH,
} from "@t3tools/contracts";

export const WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH =
  PROJECT_SEARCH_TEXT_MAX_PATTERNS_PER_LIST * (PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH + 1);

function sliceCodeUnitsWithoutDanglingHighSurrogate(value: string, maxLength: number): string {
  const bounded = value.length <= maxLength ? value : value.slice(0, maxLength);
  const finalCodeUnit = bounded.charCodeAt(bounded.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

export function normalizeWorkspaceSearchQuery(value: string): string {
  return sliceCodeUnitsWithoutDanglingHighSurrogate(value, PROJECT_SEARCH_TEXT_QUERY_MAX_LENGTH);
}

export function normalizeWorkspaceSearchGlobInput(value: string): string {
  return sliceCodeUnitsWithoutDanglingHighSurrogate(value, WORKSPACE_SEARCH_GLOB_INPUT_MAX_LENGTH);
}

export function parseWorkspaceSearchGlobs(value: string): string[] {
  const normalizedValue = normalizeWorkspaceSearchGlobInput(value);
  const patterns: string[] = [];
  let start = 0;

  while (
    start <= normalizedValue.length &&
    patterns.length < PROJECT_SEARCH_TEXT_MAX_PATTERNS_PER_LIST
  ) {
    const separator = normalizedValue.indexOf(",", start);
    const end = separator < 0 ? normalizedValue.length : separator;
    const pattern = normalizedValue.slice(start, end).trim();
    if (pattern.length > 0) {
      patterns.push(
        sliceCodeUnitsWithoutDanglingHighSurrogate(pattern, PROJECT_SEARCH_TEXT_GLOB_MAX_LENGTH),
      );
    }
    if (separator < 0) break;
    start = separator + 1;
  }

  return patterns;
}
