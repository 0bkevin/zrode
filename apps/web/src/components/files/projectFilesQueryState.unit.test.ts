import type { ProjectFileEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectEntriesRefreshDecision,
  shouldRefreshProjectEntries,
} from "./projectFilesQueryState";

const event = (value: ProjectFileEvent) => value;

describe("shouldRefreshProjectEntries", () => {
  it("refreshes authoritatively on initial readiness and reconnect", () => {
    expect(
      shouldRefreshProjectEntries(
        event({ version: 2, sequence: 0, type: "ready", cwd: "/workspace" }),
      ),
    ).toBe(true);
  });

  it("does not relist the explorer for content-only saves", () => {
    expect(
      shouldRefreshProjectEntries(
        event({
          version: 2,
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
          version: 2,
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
          version: 2,
          sequence: 2,
          type: "resync",
          cwd: "/workspace",
          reason: "watcher-error",
        }),
      ),
    ).toBe(true);
  });
});

describe("projectEntriesRefreshDecision", () => {
  it("forces an authoritative refresh for legacy unsequenced events", () => {
    expect(
      projectEntriesRefreshDecision(42, {
        version: 1,
        type: "changed",
        cwd: "/workspace",
        contentPaths: ["src/a.ts"],
        structuralPaths: [],
      }),
    ).toEqual({ sequence: null, shouldRefresh: true });
  });
  const contentEvent = (sequence: number) =>
    event({
      version: 2,
      sequence,
      type: "changed",
      cwd: "/workspace",
      contentPaths: ["notes.md"],
      structuralPaths: [],
    });

  it("refreshes when the first observed event may have hidden readiness", () => {
    expect(projectEntriesRefreshDecision(null, contentEvent(4))).toEqual({
      sequence: 4,
      shouldRefresh: true,
    });
  });

  it("does not refresh for normal consecutive content-only events", () => {
    expect(projectEntriesRefreshDecision(4, contentEvent(5))).toEqual({
      sequence: 5,
      shouldRefresh: false,
    });
    expect(projectEntriesRefreshDecision(5, contentEvent(5))).toEqual({
      sequence: 5,
      shouldRefresh: false,
    });
  });

  it("refreshes when a sequence gap may contain a structural invalidation", () => {
    expect(projectEntriesRefreshDecision(4, contentEvent(6))).toEqual({
      sequence: 6,
      shouldRefresh: true,
    });
  });

  it("refreshes on a sequence reset even when the visible event is content-only", () => {
    expect(projectEntriesRefreshDecision(9, contentEvent(1))).toEqual({
      sequence: 1,
      shouldRefresh: true,
    });
  });
});
