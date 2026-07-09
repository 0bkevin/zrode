import type { ProviderUsageSnapshot, ProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compactProviderUsagePercent } from "./ProviderUsageStatus";

function usageWindow(usedPercent: number): ProviderUsageWindow {
  return {
    usedPercent,
    windowMinutes: null,
    resetsAt: null,
  };
}

function usageSnapshot(overrides: Partial<ProviderUsageSnapshot> = {}): ProviderUsageSnapshot {
  return {
    provider: "claude",
    status: "ok",
    session: null,
    weekly: null,
    extraLimits: [],
    planLabel: null,
    extraUsage: null,
    credits: null,
    resetCredits: null,
    message: null,
    updatedAt: 0,
    ...overrides,
  };
}

describe("compactProviderUsagePercent", () => {
  it("uses provider-wide usage instead of exhausted model-specific limits", () => {
    const snapshot = usageSnapshot({
      session: usageWindow(0),
      weekly: usageWindow(79),
      extraLimits: [
        {
          label: "Fable",
          session: null,
          weekly: usageWindow(100),
        },
      ],
    });

    expect(compactProviderUsagePercent(snapshot)).toBe(79);
  });

  it("still reports the most constrained provider-wide window", () => {
    const snapshot = usageSnapshot({
      session: usageWindow(91),
      weekly: usageWindow(42),
      extraLimits: [
        {
          label: "Fable",
          session: null,
          weekly: usageWindow(100),
        },
      ],
    });

    expect(compactProviderUsagePercent(snapshot)).toBe(91);
  });

  it("returns null when provider-wide windows are unavailable", () => {
    const snapshot = usageSnapshot({
      extraLimits: [
        {
          label: "Fable",
          session: null,
          weekly: usageWindow(100),
        },
      ],
    });

    expect(compactProviderUsagePercent(snapshot)).toBeNull();
  });
});
