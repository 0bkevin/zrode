import type { ProviderModelTokenActivityDay, ProviderTokenActivityKind } from "@t3tools/contracts";

/**
 * Prices were verified against first-party provider docs on this date:
 * - https://platform.claude.com/docs/en/about-claude/pricing
 * - https://developers.openai.com/api/docs/models/gpt-5.4
 * - https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * - https://developers.openai.com/api/docs/models/compare
 * - https://developers.openai.com/api/docs/models/gpt-5.3-codex
 * - https://openai.com/api-priority-processing/
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
  /** The model slug itself carries a complete, non-multiplier fast tariff. */
  readonly embeddedFastRates?: boolean;
}

const MODEL_SUFFIX =
  /-(?:none|low|medium|high|xhigh|extra-high|max|ultra|thinking|non-reasoning|reasoning)$/;

function normalizedModelSlug(model: string): { slug: string; isFastAlias: boolean } {
  const raw = model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
  let isFastAlias = false;
  let slug = raw;
  // Provider UIs append effort/thinking suffixes in different orders. They do
  // not change token prices, so peel every trailing pricing-neutral suffix.
  for (;;) {
    const previous = slug;
    if (slug.endsWith("-fast") && slug !== "grok-code-fast") {
      isFastAlias = true;
      slug = slug.slice(0, -"-fast".length);
    } else if (slug.endsWith("-latest")) {
      slug = slug.slice(0, -"-latest".length);
    } else if (/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/.test(slug)) {
      slug = slug.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
    } else if (slug !== "gpt-5.1-codex-max" && MODEL_SUFFIX.test(slug)) {
      slug = slug.replace(MODEL_SUFFIX, "");
    }
    if (slug === previous) break;
  }
  slug = slug
    .replace(/^claude-4[.-](\d+)-opus$/, "claude-opus-4-$1")
    .replace(/^claude-4[.-](\d+)-sonnet$/, "claude-sonnet-4-$1")
    .replace(/^claude-4[.-](\d+)-haiku$/, "claude-haiku-4-$1");
  return { slug, isFastAlias };
}

/**
 * Match only model families with an unambiguous first-party list price.
 * OpenCode can route arbitrary providers and models, so its own recorded
 * per-message cost is preferred by `estimateApiEquivalentCost` below.
 */
export function lookupModelPricing(
  model: string,
  effectiveDay: string = API_PRICING_AS_OF,
): PricedModel | null {
  const rawSlug = model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
  const normalized = normalizedModelSlug(model);
  // xAI moved this floating Grok Build alias to Grok 4.5 on its launch day.
  // Keep older rows on the Build 0.1 tariff instead of repricing history.
  const slug =
    rawSlug === "grok-build-latest" && effectiveDay >= "2026-07-08" ? "grok-4.5" : normalized.slug;
  const { isFastAlias } = normalized;

  if (slug === "claude-fable-5" || slug === "claude-mythos-5") {
    return {
      label: slug === "claude-fable-5" ? "Claude Fable 5" : "Claude Mythos 5",
      rates: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
    };
  }
  if (slug === "claude-opus-4-8") {
    return {
      label: "Claude Opus 4.8",
      rates: {
        input: 5,
        cachedInput: 0.5,
        cacheWrite: 6.25,
        output: 25,
        fastMultiplier: 2,
      },
    };
  }
  if (slug === "claude-opus-4-7" || slug === "claude-opus-4-6") {
    return {
      label: slug === "claude-opus-4-7" ? "Claude Opus 4.7" : "Claude Opus 4.6",
      // Opus 4.6/4.7 fast requests were billed at 6x. Opus 4.6 no
      // longer emits speed=fast, but old log entries still need that rate.
      rates: {
        input: 5,
        cachedInput: 0.5,
        cacheWrite: 6.25,
        output: 25,
        fastMultiplier: 6,
      },
    };
  }
  if (slug === "claude-opus-4-5") {
    return {
      label: "Claude Opus 4.5",
      rates: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
    };
  }
  if (slug === "claude-opus-4-1" || slug === "claude-opus-4") {
    return {
      label: "Claude Opus 4/4.1",
      rates: { input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 },
    };
  }
  if (slug === "claude-sonnet-5") {
    const introductory = effectiveDay <= "2026-08-31";
    return {
      label: "Claude Sonnet 5",
      // Anthropic published the transition in advance, so preserve the price
      // applicable on each usage day instead of retrospectively repricing it.
      rates: introductory
        ? { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }
        : { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
    };
  }
  if (slug === "claude-sonnet-4-6") {
    return {
      label: "Claude Sonnet 4.6",
      rates: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
    };
  }
  if (slug === "claude-sonnet-4-5" || slug === "claude-sonnet-4") {
    return {
      label: "Claude Sonnet 4/4.5",
      rates: {
        input: 3,
        cachedInput: 0.3,
        cacheWrite: 3.75,
        output: 15,
        longContext: { input: 6, cachedInput: 0.6, cacheWrite: 7.5, output: 22.5 },
      },
    };
  }
  if (slug === "claude-haiku-4-5") {
    return {
      label: "Claude Haiku 4.5",
      rates: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
    };
  }
  if (slug === "gpt-5.5-pro" || slug === "gpt-5.4-pro") {
    return {
      label: slug === "gpt-5.5-pro" ? "GPT-5.5 Pro" : "GPT-5.4 Pro",
      rates: {
        input: 30,
        // Pro has no cached-input discount.
        cachedInput: 30,
        cacheWrite: 30,
        output: 180,
        longContext: { input: 60, cachedInput: 60, cacheWrite: 60, output: 270 },
      },
    };
  }
  if (slug === "gpt-5.6" || slug === "gpt-5.6-sol") {
    return {
      label: "GPT-5.6 Sol",
      rates: {
        input: 5,
        cachedInput: 0.5,
        cacheWrite: 6.25,
        output: 30,
        fastMultiplier: 2,
        longContext: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 },
      },
    };
  }
  if (slug === "gpt-5.6-terra") {
    return {
      label: "GPT-5.6 Terra",
      rates: {
        input: 2.5,
        cachedInput: 0.25,
        cacheWrite: 3.125,
        output: 15,
        fastMultiplier: 2,
        longContext: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 22.5 },
      },
    };
  }
  if (slug === "gpt-5.6-luna") {
    return {
      label: "GPT-5.6 Luna",
      rates: {
        input: 1,
        cachedInput: 0.1,
        cacheWrite: 1.25,
        output: 6,
        fastMultiplier: 2,
        longContext: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 9 },
      },
    };
  }
  if (slug === "gpt-5.4") {
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
  if (slug === "gpt-5.4-mini") {
    return {
      label: "GPT-5.4 mini",
      rates: {
        input: 0.75,
        cachedInput: 0.075,
        cacheWrite: 0.75,
        output: 4.5,
        fastMultiplier: 2,
      },
    };
  }
  if (slug === "gpt-5.4-nano") {
    return {
      label: "GPT-5.4 nano",
      rates: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.2, output: 1.25 },
    };
  }
  if (slug === "gpt-5.5" || slug === "gpt-5.5-codex") {
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
  if (slug === "gpt-5.3-codex" || slug === "gpt-5.2-codex") {
    return {
      label: slug === "gpt-5.3-codex" ? "GPT-5.3-Codex" : "GPT-5.2-Codex",
      rates: {
        input: 1.75,
        cachedInput: 0.175,
        cacheWrite: 1.75,
        output: 14,
        fastMultiplier: 2,
      },
    };
  }
  if (slug === "gpt-5.2") {
    return {
      label: "GPT-5.2",
      rates: {
        input: 1.75,
        cachedInput: 0.175,
        cacheWrite: 1.75,
        output: 14,
        fastMultiplier: 2,
      },
    };
  }
  if (slug === "gpt-5.1-codex-mini") {
    return {
      label: "GPT-5.1-Codex mini",
      rates: { input: 0.25, cachedInput: 0.025, cacheWrite: 0.25, output: 2 },
    };
  }
  if (slug === "gpt-5.1-codex" || slug === "gpt-5.1-codex-max") {
    return {
      label: slug.endsWith("-max") ? "GPT-5.1-Codex Max" : "GPT-5.1-Codex",
      rates: {
        input: 1.25,
        cachedInput: 0.125,
        cacheWrite: 1.25,
        output: 10,
        fastMultiplier: 2,
      },
    };
  }
  if (slug === "gpt-5.1") {
    return {
      label: "GPT-5.1",
      rates: {
        input: 1.25,
        cachedInput: 0.125,
        cacheWrite: 1.25,
        output: 10,
        fastMultiplier: 2,
      },
    };
  }
  if (slug === "gpt-5-mini") {
    return {
      label: "GPT-5 mini",
      rates: {
        input: 0.25,
        cachedInput: 0.025,
        cacheWrite: 0.25,
        output: 2,
        fastMultiplier: 1.8,
      },
    };
  }
  if (slug === "gpt-5-nano") {
    return {
      label: "GPT-5 nano",
      rates: { input: 0.05, cachedInput: 0.005, cacheWrite: 0.05, output: 0.4 },
    };
  }
  if (slug === "gpt-5" || slug === "gpt-5-codex") {
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
  if (/^grok-code-fast(?:-1|-1-0825)?$/.test(slug) && effectiveDay <= "2026-05-15") {
    return {
      label: "Grok Code Fast 1",
      // Original model metadata: $0.20 input, $0.02 cached input,
      // and $1.50 output. The alias redirected to Grok Build after May 15.
      rates: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.2, output: 1.5 },
    };
  }
  if (/^(?:grok-build(?:-0\.1)?|grok-code-fast(?:-1|-1-0825)?)$/.test(slug)) {
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
  if (/^grok-4[.-]3$/.test(slug)) {
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
  if (/^grok-4(?:[.-]20|\.20)(?:(?:-multi-agent)?-0309)?$/.test(slug)) {
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
  if (/^grok-4[.-]5$/.test(slug)) {
    return {
      label: isFastAlias ? "Grok 4.5 Fast" : "Grok 4.5",
      embeddedFastRates: isFastAlias,
      rates: isFastAlias
        ? { input: 4, cachedInput: 1, cacheWrite: 4, output: 18 }
        : {
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
  readonly pricedTokens: number;
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
  // OpenAI Priority does not serve >272K long-context requests. Codex logs
  // record the requested preference, not a response-confirmed served tier.
  const applyFast = row.isFast && !(row.provider === "codex" && row.usesLongContext);
  return base * (applyFast ? (rates.fastMultiplier ?? 1) : 1);
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
    const pricing = lookupModelPricing(row.model, row.day);
    const ambiguousFastAlias =
      normalizedModelSlug(row.model).isFastAlias &&
      !row.isFast &&
      pricing?.embeddedFastRates !== true;
    const categorizedTokens =
      row.inputTokens +
      row.cachedInputTokens +
      row.cacheWriteTokens +
      row.cacheWrite1hTokens +
      row.outputTokens;
    const cost =
      row.recordedCostUsd !== null
        ? row.recordedCostUsd
        : pricing !== null && !ambiguousFastAlias && categorizedTokens > 0
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
      pricedTokens: entry.priced,
      costUsd: entry.priced > 0 ? entry.cost : null,
    }))
    .toSorted((left, right) => right.totalTokens - left.totalTokens);

  return { totalUsd, pricedTokens, totalTokens, models, providerCosts };
}
