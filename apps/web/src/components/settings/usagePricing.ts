import type { ProviderModelTokenActivityDay, ProviderTokenActivityKind } from "@t3tools/contracts";

/**
 * Prices were verified against first-party provider docs on this date:
 * - https://platform.claude.com/docs/en/about-claude/pricing
 * - https://developers.openai.com/api/docs/models/gpt-5.4
 * - https://developers.openai.com/api/docs/models/compare
 * - https://developers.openai.com/api/docs/models/gpt-5.3-codex
 * - https://docs.x.ai/developers/pricing
 * OpenCode's own `cost` ledger is preferred for its multi-provider requests.
 */
export const API_PRICING_AS_OF = "2026-07-18";

interface TokenRates {
  /** USD per million tokens. */
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly fastMultiplier?: number;
  readonly longContext?: Omit<TokenRates, "fastMultiplier" | "longContext">;
}

interface PricedModel {
  readonly label: string;
  readonly rates: TokenRates;
}

/**
 * Match only model families with an unambiguous first-party list price.
 * OpenCode can route arbitrary providers and models, so its own recorded
 * per-message cost is preferred by `estimateApiEquivalentCost` below.
 */
export function lookupModelPricing(model: string): PricedModel | null {
  const rawSlug = model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
  const isFastAlias = rawSlug.endsWith("-fast");
  const slug = isFastAlias ? rawSlug.slice(0, -"-fast".length) : rawSlug;

  if (/^claude-opus-4-(5|6|7|8)(?:-|$)/.test(slug)) {
    return {
      label: "Claude Opus 4.5–4.8",
      rates: {
        input: 5,
        cachedInput: 0.5,
        cacheWrite: 6.25,
        output: 25,
        fastMultiplier: 2,
      },
    };
  }
  if (/^claude-sonnet-5(?:-|$)/.test(slug)) {
    return {
      label: "Claude Sonnet 5",
      // Introductory first-party pricing through August 31, 2026.
      rates: {
        input: 2,
        cachedInput: 0.2,
        cacheWrite: 2.5,
        output: 10,
        fastMultiplier: 2,
      },
    };
  }
  if (/^claude-sonnet-4-(5|6)(?:-|$)/.test(slug)) {
    return {
      label: "Claude Sonnet 4.5–4.6",
      rates: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
    };
  }
  if (/^claude-haiku-4-5(?:-|$)/.test(slug)) {
    return {
      label: "Claude Haiku 4.5",
      rates: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
    };
  }
  if (/^gpt-5\.4(?:-(?:low|medium|high|xhigh))?(?:-\d{4}-\d{2}-\d{2})?$/.test(slug)) {
    return {
      label: "GPT-5.4",
      rates: {
        input: 2.5,
        cachedInput: 0.25,
        cacheWrite: 2.5,
        output: 15,
        fastMultiplier: 2,
        longContext: { input: 5, cachedInput: 0.5, cacheWrite: 5, output: 22.5 },
      },
    };
  }
  if (/^gpt-5\.5(?:-codex)?(?:-(?:low|medium|high|xhigh))?(?:-\d{4}-\d{2}-\d{2})?$/.test(slug)) {
    return {
      label: "GPT-5.5",
      rates: {
        input: 5,
        cachedInput: 0.5,
        cacheWrite: 5,
        output: 30,
        fastMultiplier: 2.5,
        longContext: { input: 10, cachedInput: 1, cacheWrite: 10, output: 45 },
      },
    };
  }
  if (/^gpt-5\.3-codex(?:-\d{4}-\d{2}-\d{2})?$/.test(slug)) {
    return {
      label: "GPT-5.3-Codex",
      rates: {
        input: 1.75,
        cachedInput: 0.175,
        cacheWrite: 1.75,
        output: 14,
        fastMultiplier: 2,
      },
    };
  }
  if (/^gpt-5(?:-codex)?(?:-\d{4}-\d{2}-\d{2})?$/.test(slug)) {
    return {
      label: "GPT-5",
      rates: {
        input: 1.25,
        cachedInput: 0.125,
        cacheWrite: 1.25,
        output: 10,
        fastMultiplier: 2,
      },
    };
  }
  if (/^(?:grok-build(?:-0\.1)?|grok-code-fast-1)$/.test(slug)) {
    return {
      label: "Grok Build",
      rates: {
        input: 1,
        cachedInput: 0.2,
        cacheWrite: 1,
        output: 2,
        longContext: { input: 2, cachedInput: 0.4, cacheWrite: 2, output: 4 },
      },
    };
  }
  if (/^grok-4[.-]3(?:-|$)/.test(slug)) {
    return {
      label: "Grok 4.3",
      rates: {
        input: 1.25,
        cachedInput: 0.2,
        cacheWrite: 1.25,
        output: 2.5,
        longContext: { input: 2.5, cachedInput: 0.4, cacheWrite: 2.5, output: 5 },
      },
    };
  }
  if (/^grok-4(?:[.-]20|\.20)(?:-|$)/.test(slug)) {
    return {
      label: "Grok 4.20",
      rates: {
        input: 1.25,
        cachedInput: 0.2,
        cacheWrite: 1.25,
        output: 2.5,
        longContext: { input: 2.5, cachedInput: 0.4, cacheWrite: 2.5, output: 5 },
      },
    };
  }
  if (/^grok-4[.-]5(?:-|$)/.test(slug)) {
    return {
      label: "Grok 4.5",
      rates: {
        input: 2,
        cachedInput: 0.5,
        cacheWrite: 2,
        output: 6,
        longContext: { input: 4, cachedInput: 1, cacheWrite: 4, output: 12 },
      },
    };
  }
  return null;
}

export interface ModelUsageSummary {
  readonly provider: ProviderTokenActivityKind;
  readonly model: string;
  readonly totalTokens: number;
  readonly costUsd: number | null;
}

export interface ApiCostEstimate {
  readonly totalUsd: number;
  readonly pricedTokens: number;
  readonly totalTokens: number;
  readonly models: ReadonlyArray<ModelUsageSummary>;
  readonly providerCosts: ReadonlyMap<ProviderTokenActivityKind, number>;
}

function rateCost(row: ProviderModelTokenActivityDay, rates: TokenRates): number {
  const effective = row.usesLongContext && rates.longContext ? rates.longContext : rates;
  const base =
    (row.inputTokens * effective.input +
      row.cachedInputTokens * effective.cachedInput +
      row.cacheWriteTokens * effective.cacheWrite +
      row.cacheWrite1hTokens * effective.input * 2 +
      row.outputTokens * effective.output) /
    1_000_000;
  const modelFastAlias = row.model.split("/").at(-1)?.toLowerCase().endsWith("-fast") === true;
  return base * (row.isFast || modelFastAlias ? (rates.fastMultiplier ?? 2) : 1);
}

export function estimateApiEquivalentCost(
  rows: ReadonlyArray<ProviderModelTokenActivityDay>,
): ApiCostEstimate {
  const grouped = new Map<
    string,
    {
      provider: ProviderTokenActivityKind;
      model: string;
      totalTokens: number;
      cost: number;
      priced: number;
    }
  >();
  const providerCosts = new Map<ProviderTokenActivityKind, number>();
  let totalUsd = 0;
  let pricedTokens = 0;
  let totalTokens = 0;

  for (const row of rows) {
    totalTokens += row.totalTokens;
    const pricing = lookupModelPricing(row.model);
    const categorizedTokens =
      row.inputTokens +
      row.cachedInputTokens +
      row.cacheWriteTokens +
      row.cacheWrite1hTokens +
      row.outputTokens;
    const cost =
      row.recordedCostUsd !== null
        ? row.recordedCostUsd
        : pricing !== null && categorizedTokens > 0
          ? rateCost(row, pricing.rates)
          : null;
    const key = `${row.provider}\u0000${row.model}`;
    const current = grouped.get(key) ?? {
      provider: row.provider,
      model: row.model,
      totalTokens: 0,
      cost: 0,
      priced: 0,
    };
    current.totalTokens += row.totalTokens;
    if (cost !== null) {
      current.cost += cost;
      current.priced += row.totalTokens;
      totalUsd += cost;
      pricedTokens += row.totalTokens;
      providerCosts.set(row.provider, (providerCosts.get(row.provider) ?? 0) + cost);
    }
    grouped.set(key, current);
  }

  const models = [...grouped.values()]
    .map<ModelUsageSummary>((entry) => ({
      provider: entry.provider,
      model: entry.model,
      totalTokens: entry.totalTokens,
      costUsd: entry.priced > 0 ? entry.cost : null,
    }))
    .toSorted((left, right) => right.totalTokens - left.totalTokens);

  return { totalUsd, pricedTokens, totalTokens, models, providerCosts };
}
