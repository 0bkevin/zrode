import { describe, expect, it } from "vite-plus/test";

import {
  artifactSizeRegressionPercent,
  evaluateDesktopSmokeFailures,
  summarizeDesktopPerformanceSamples,
} from "./desktop-performance.ts";

describe("desktop performance measurements", () => {
  it("summarizes long-running renderer heap and DOM growth", () => {
    expect(
      summarizeDesktopPerformanceSamples([
        {
          elapsedMs: 1_000,
          usedHeapBytes: 100,
          totalHeapBytes: 200,
          documentCount: 1,
          nodeCount: 20,
          listenerCount: 5,
        },
        {
          elapsedMs: 6_000,
          usedHeapBytes: 125,
          totalHeapBytes: 250,
          documentCount: 1,
          nodeCount: 25,
          listenerCount: 7,
        },
      ]),
    ).toMatchObject({
      sampleCount: 2,
      durationMs: 5_000,
      usedHeapGrowthBytes: 25,
      usedHeapGrowthPercent: 25,
      maxNodeCount: 25,
      maxListenerCount: 7,
    });
  });

  it("reports artifact growth relative to a platform baseline", () => {
    expect(artifactSizeRegressionPercent(115, 100)).toBe(15);
    expect(artifactSizeRegressionPercent(100, 0)).toBe(0);
  });

  it("never treats a timed-out desktop launch as a successful smoke test", () => {
    expect(
      evaluateDesktopSmokeFailures({
        output: "",
        timedOut: true,
        requireMilestones: false,
        appReadyMs: null,
        rendererLoadedMs: null,
      }),
    ).toContain("desktop smoke test timed out");
  });

  it("requires both startup milestones when producing a startup report", () => {
    expect(
      evaluateDesktopSmokeFailures({
        output: "app ready",
        timedOut: false,
        requireMilestones: true,
        appReadyMs: 100,
        rendererLoadedMs: null,
      }),
    ).toContain("startup milestones were not observed");
  });
});
