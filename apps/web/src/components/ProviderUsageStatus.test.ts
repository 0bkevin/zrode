import type { ProviderUsageSnapshot, ProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  compactProviderUsageCreditBalance,
  compactProviderUsagePercent,
} from "./ProviderUsageStatus";

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

describe("compactProviderUsageCreditBalance", () => {
  it("shows the exact signed-in Kilo balance when there is no allowance window", () => {
    expect(
      compactProviderUsageCreditBalance(
        usageSnapshot({
          provider: "kilocode",
          credits: { balance: "$12.34", hasCredits: true, unlimited: false },
        }),
      ),
    ).toBe("$12.34");
  });

  it("keeps a zero Kilo balance visible", () => {
    expect(
      compactProviderUsageCreditBalance(
        usageSnapshot({
          provider: "kilocode",
          credits: { balance: "$0.00", hasCredits: false, unlimited: false },
        }),
      ),
    ).toBe("$0.00");
  });
});
