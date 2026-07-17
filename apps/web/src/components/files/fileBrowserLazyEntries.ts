import type { ProjectEntry } from "@t3tools/contracts";

export function mergeWorkspaceEntries(
  indexedEntries: ReadonlyArray<ProjectEntry>,
  lazyEntryGroups: Iterable<ReadonlyArray<ProjectEntry>>,
): ProjectEntry[] {
  const entryByPath = new Map(indexedEntries.map((entry) => [entry.path, entry]));
  for (const entries of lazyEntryGroups) {
    for (const entry of entries) entryByPath.set(entry.path, entry);
  }
  return [...entryByPath.values()];
}

export function directoriesNeedingLazyLoad(input: {
  readonly expandedDirectories: ReadonlyArray<string>;
  readonly loadedDirectories: ReadonlySet<string>;
  readonly requestedDirectories: ReadonlySet<string>;
}): string[] {
  return input.expandedDirectories.filter(
    (path) => !input.loadedDirectories.has(path) && !input.requestedDirectories.has(path),
  );
}
