import type { ProjectFileEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldRefreshProjectEntries } from "./projectFilesQueryState";

const event = (value: ProjectFileEvent) => value;

describe("shouldRefreshProjectEntries", () => {
  it("refreshes authoritatively on initial readiness and reconnect", () => {
    expect(
      shouldRefreshProjectEntries(
        event({ version: 1, sequence: 0, type: "ready", cwd: "/workspace" }),
      ),
    ).toBe(true);
  });

  it("does not relist the explorer for content-only saves", () => {
    expect(
      shouldRefreshProjectEntries(
        event({
          version: 1,
          sequence: 1,
          type: "changed",
          cwd: "/workspace",
          contentPaths: ["notes.md"],
          structuralPaths: [],
        }),
      ),
    ).toBe(false);
  });

  it("refreshes for structural changes and resync markers", () => {
    expect(
      shouldRefreshProjectEntries(
        event({
          version: 1,
          sequence: 1,
          type: "changed",
          cwd: "/workspace",
          contentPaths: [],
          structuralPaths: ["notes.md"],
        }),
      ),
    ).toBe(true);
    expect(
      shouldRefreshProjectEntries(
        event({
          version: 1,
          sequence: 2,
          type: "resync",
          cwd: "/workspace",
          reason: "watcher-error",
        }),
      ),
    ).toBe(true);
  });
});
