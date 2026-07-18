import { describe, expect, it } from "vite-plus/test";
import type { ProviderModelTokenActivityDay } from "@t3tools/contracts";

import { estimateApiEquivalentCost, lookupModelPricing } from "./usagePricing";

function row(
  overrides: Partial<ProviderModelTokenActivityDay> = {},
): ProviderModelTokenActivityDay {
  return {
    day: "2026-07-17",
    provider: "codex",
    model: "gpt-5.4",
    inputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 1_000_000,
    totalTokens: 3_000_000,
    recordedCostUsd: null,
    isFast: false,
    usesLongContext: false,
    ...overrides,
  };
}

describe("usage API pricing", () => {
  it("matches only documented model families", () => {
    expect(lookupModelPricing("gpt-5.4")?.label).toBe("GPT-5.4");
    expect(lookupModelPricing("anthropic/claude-opus-4-8")).not.toBeNull();
    expect(lookupModelPricing("gpt-5.3-codex-spark")).toBeNull();
    expect(lookupModelPricing("grok-code-fast-1")?.label).toBe("Grok Build");
    expect(lookupModelPricing("local/custom-model")).toBeNull();
  });

  it("prices one-hour cache writes and fast turns from their recorded metadata", () => {
    const estimate = estimateApiEquivalentCost([
      row({
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
        isFast: true,
      }),
    ]);
    // GPT-5.4: a 1h write uses 2x input ($5), then priority uses 2x ($10).
    expect(estimate.totalUsd).toBeCloseTo(10);
  });

  it("applies request-wide long-context rates when the scanner marked the event", () => {
    const estimate = estimateApiEquivalentCost([
      row({
        cachedInputTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 2_000_000,
        usesLongContext: true,
      }),
    ]);
    expect(estimate.totalUsd).toBeCloseTo(27.5);
  });

  it("prices input, cache, and output independently", () => {
    const estimate = estimateApiEquivalentCost([row()]);
    expect(estimate.totalUsd).toBeCloseTo(17.75);
    expect(estimate.pricedTokens).toBe(3_000_000);
    expect(estimate.providerCosts.get("codex")).toBeCloseTo(17.75);
  });

  it("prefers OpenCode's recorded request cost and reports partial coverage", () => {
    const estimate = estimateApiEquivalentCost([
      row({
        provider: "opencode",
        model: "local/free-model",
        totalTokens: 500,
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
        recordedCostUsd: 0,
      }),
      row({ model: "unknown", totalTokens: 250 }),
    ]);
    expect(estimate.totalUsd).toBe(0);
    expect(estimate.totalTokens).toBe(750);
    expect(estimate.pricedTokens).toBe(500);
    expect(estimate.models[0]?.costUsd).toBe(0);
  });
});
