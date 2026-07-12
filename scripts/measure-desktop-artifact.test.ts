import { describe, expect, it } from "vite-plus/test";

import {
  compareDesktopArtifactMeasurement,
  parseDesktopArtifactMeasurementArguments,
} from "./measure-desktop-artifact.ts";

describe("desktop artifact measurement", () => {
  it("parses target metadata and a configurable growth budget", () => {
    const parsed = parseDesktopArtifactMeasurementArguments([
      "--artifact",
      "dist/Zrode.dmg",
      "--platform",
      "darwin",
      "--arch",
      "arm64",
      "--max-growth-percent",
      "3",
    ]);
    expect(parsed).toMatchObject({ platform: "darwin", arch: "arm64", maxGrowthPercent: 3 });
    expect(parsed.artifactPath).toMatch(/dist[/\\]Zrode\.dmg$/);
  });

  it("fails only when a like-for-like artifact exceeds the budget", () => {
    const baseline = {
      platform: "linux",
      arch: "x64",
      artifactPath: "old.AppImage",
      artifactBytes: 100,
      measuredAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      compareDesktopArtifactMeasurement(
        { ...baseline, artifactPath: "new.AppImage", artifactBytes: 104 },
        baseline,
        5,
      ),
    ).toMatchObject({ growthBytes: 4, growthPercent: 4, exceedsBudget: false });
    expect(
      compareDesktopArtifactMeasurement(
        { ...baseline, artifactPath: "new.AppImage", artifactBytes: 106 },
        baseline,
        5,
      ).exceedsBudget,
    ).toBe(true);
  });
});
