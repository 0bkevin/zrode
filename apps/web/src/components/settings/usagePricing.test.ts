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
    expect(lookupModelPricing("claude-4.7-opus-high-thinking-fast")?.label).toBe("Claude Opus 4.7");
    expect(lookupModelPricing("gpt-5.6-terra-xhigh-fast")?.label).toBe("GPT-5.6 Terra");
    expect(lookupModelPricing("grok-4.5-fast-high")?.label).toBe("Grok 4.5 Fast");
    expect(lookupModelPricing("gpt-5.2-codex")?.label).toBe("GPT-5.2-Codex");
    expect(lookupModelPricing("gpt-5.1-codex-max")?.label).toBe("GPT-5.1-Codex Max");
    expect(lookupModelPricing("claude-fable-5")?.label).toBe("Claude Fable 5");
    expect(lookupModelPricing("gpt-5-mini")?.label).toBe("GPT-5 mini");
    expect(lookupModelPricing("gpt-5-nano")?.label).toBe("GPT-5 nano");
    expect(lookupModelPricing("gpt-5.3-codex-spark")).toBeNull();
    expect(lookupModelPricing("grok-code-fast-1")?.label).toBe("Grok Build");
    expect(lookupModelPricing("grok-build-latest")?.label).toBe("Grok 4.5");
    expect(lookupModelPricing("grok-build-latest", "2026-07-07")?.label).toBe("Grok Build");
    expect(lookupModelPricing("grok-4.20-0309-non-reasoning")?.label).toBe("Grok 4.20");
    expect(lookupModelPricing("grok-4.5-latest")?.label).toBe("Grok 4.5");
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

  it("uses the model-specific Claude fast price", () => {
    const opus47 = estimateApiEquivalentCost([
      row({
        provider: "claude",
        model: "claude-opus-4-7",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 5_000_000,
        isFast: true,
      }),
    ]);
    // $46.75 at standard speed, all at the documented 6x fast tier.
    expect(opus47.totalUsd).toBeCloseTo(280.5);

    const opus48 = estimateApiEquivalentCost([
      row({
        provider: "claude",
        model: "claude-opus-4-8",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 5_000_000,
        isFast: true,
      }),
    ]);
    expect(opus48.totalUsd).toBeCloseTo(93.5);
  });

  it("applies Sonnet 4.5 long-context pricing but not Sonnet 4.6", () => {
    const sonnet45 = estimateApiEquivalentCost([
      row({
        provider: "claude",
        model: "claude-sonnet-4-5",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        usesLongContext: true,
      }),
    ]);
    const sonnet46 = estimateApiEquivalentCost([
      row({
        provider: "claude",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        usesLongContext: true,
      }),
    ]);
    expect(sonnet45.totalUsd).toBeCloseTo(28.5);
    expect(sonnet46.totalUsd).toBeCloseTo(18);
  });

  it("does not apply unavailable Codex priority pricing to long-context requests", () => {
    const estimate = estimateApiEquivalentCost([
      row({
        model: "gpt-5.6-sol",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 3_000_000,
        isFast: true,
        usesLongContext: true,
      }),
    ]);
    expect(estimate.totalUsd).toBeCloseTo(56);
  });

  it("uses effective-dated Sonnet 5 prices without repricing history", () => {
    const august = estimateApiEquivalentCost([
      row({
        day: "2026-08-31",
        provider: "claude",
        model: "claude-sonnet-5",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      }),
    ]);
    const september = estimateApiEquivalentCost([
      row({
        day: "2026-09-01",
        provider: "claude",
        model: "claude-sonnet-5",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      }),
    ]);
    expect(august.totalUsd).toBeCloseTo(12);
    expect(september.totalUsd).toBeCloseTo(18);
  });

  it("preserves historical Grok Code Fast pricing across its alias transition", () => {
    const original = estimateApiEquivalentCost([
      row({
        day: "2026-05-15",
        provider: "grok",
        model: "grok-code-fast-1",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 3_000_000,
      }),
    ]);
    const redirected = estimateApiEquivalentCost([
      row({
        day: "2026-05-16",
        provider: "grok",
        model: "grok-code-fast-1",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 3_000_000,
      }),
    ]);

    expect(original.totalUsd).toBeCloseTo(1.72);
    expect(redirected.totalUsd).toBeCloseTo(3.2);
  });

  it("tracks the effective-dated target of Grok Build's floating alias", () => {
    const build = estimateApiEquivalentCost([
      row({
        day: "2026-07-07",
        provider: "grok",
        model: "grok-build-latest",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        usesLongContext: true,
      }),
    ]);
    const grok45 = estimateApiEquivalentCost([
      row({
        day: "2026-07-08",
        provider: "grok",
        model: "grok-build-latest",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        usesLongContext: true,
      }),
    ]);

    expect(build.totalUsd).toBeCloseTo(6);
    expect(grok45.totalUsd).toBeCloseTo(16);
  });

  it("does not invent a fast surcharge for models without a documented tier", () => {
    const estimate = estimateApiEquivalentCost([
      row({
        provider: "claude",
        model: "claude-sonnet-5",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 3_000_000,
        isFast: true,
      }),
    ]);
    expect(estimate.totalUsd).toBeCloseTo(12.2);
  });

  it("does not discount cached input for GPT Pro models", () => {
    const estimate = estimateApiEquivalentCost([
      row({
        model: "gpt-5.5-pro",
        inputTokens: 0,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
        isFast: true,
      }),
    ]);
    expect(estimate.totalUsd).toBeCloseTo(30);
  });

  it("uses Grok 4.5 Fast's non-uniform published rates", () => {
    const estimate = estimateApiEquivalentCost([
      row({
        provider: "grok",
        model: "grok-4.5-fast-high",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 1_000_000,
      }),
    ]);
    expect(estimate.totalUsd).toBeCloseTo(18);
  });

  it("leaves unconfirmed model-name fast aliases unpriced", () => {
    const estimate = estimateApiEquivalentCost([
      row({
        provider: "opencode",
        model: "openai/gpt-5.6-terra-fast",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 1_000_000,
        isFast: false,
      }),
    ]);
    expect(estimate.totalUsd).toBe(0);
    expect(estimate.pricedTokens).toBe(0);
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
    expect(estimate.models[0]?.pricedTokens).toBe(500);
  });

  it("combines exact provider costs with estimated requests for the same model", () => {
    const estimate = estimateApiEquivalentCost([
      row({
        provider: "claude",
        model: "claude-opus-4-8",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 1_000_000,
        recordedCostUsd: 7,
      }),
      row({
        provider: "claude",
        model: "claude-opus-4-8",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 1_000_000,
      }),
    ]);
    expect(estimate.totalUsd).toBeCloseTo(12);
    expect(estimate.models[0]?.costUsd).toBeCloseTo(12);
    expect(estimate.models[0]?.pricedTokens).toBe(2_000_000);
  });
});
