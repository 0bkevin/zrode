import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { directoriesNeedingLazyLoad, mergeWorkspaceEntries } from "./fileBrowserLazyEntries";

describe("lazy file browser entries", () => {
  it("merges ignored directory listings without duplicating indexed entries", () => {
    const indexed: ProjectEntry[] = [
      { path: "src", kind: "directory" },
      { path: "src/index.ts", kind: "file" },
    ];
    expect(
      mergeWorkspaceEntries(indexed, [
        [
          { path: "src", kind: "directory" },
          { path: "node_modules", kind: "directory" },
        ],
      ]),
    ).toEqual([
      { path: "src", kind: "directory" },
      { path: "src/index.ts", kind: "file" },
      { path: "node_modules", kind: "directory" },
    ]);
  });

  it("requests an expanded directory once until it is loaded", () => {
    expect(
      directoriesNeedingLazyLoad({
        expandedDirectories: ["src", "node_modules"],
        loadedDirectories: new Set(["src"]),
        requestedDirectories: new Set<string>(),
      }),
    ).toEqual(["node_modules"]);
    expect(
      directoriesNeedingLazyLoad({
        expandedDirectories: ["node_modules"],
        loadedDirectories: new Set<string>(),
        requestedDirectories: new Set(["node_modules"]),
      }),
    ).toEqual([]);
  });
});
