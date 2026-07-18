import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

// ── Provider subscription usage (rate-limit windows) ────────────────
//
// Snapshot of how much of a subscription's rate-limit windows remain for a
// provider account (Claude Code / Codex / Grok / Kilo Code). Fetched server-side from the
// provider's own usage APIs using the locally-authenticated CLI credentials;
// surfaced in the client status UI as "session" (~5h) and "weekly" (~7d)
// meters.

export const ProviderUsageProviderKind = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "kilocode",
  "githubCopilot",
]);
export type ProviderUsageProviderKind = typeof ProviderUsageProviderKind.Type;

export const ProviderUsageStatus = Schema.Literals([
  "ok",
  "unauthenticated",
  "unavailable",
  "error",
]);
export type ProviderUsageStatus = typeof ProviderUsageStatus.Type;

export const ProviderUsageWindow = Schema.Struct({
  /** Provider-specific display label when the window is not a session/weekly bucket. */
  label: Schema.optional(Schema.String),
  /** 0–100. Percentage of the window's quota already consumed. */
  usedPercent: Schema.Number,
  /** Window length in minutes when the provider reports it (300 = 5h, 10080 = 7d). */
  windowMinutes: Schema.NullOr(Schema.Number),
  /** Epoch milliseconds when the window resets, when known. */
  resetsAt: Schema.NullOr(Schema.Number),
});
export type ProviderUsageWindow = typeof ProviderUsageWindow.Type;

/**
 * A named auxiliary limit beyond the default session/weekly pair: Claude's
 * model-scoped weekly limits (e.g. "Fable", "Opus") and Codex's per-model
 * rate-limit buckets (e.g. "GPT-5.3-Codex-Spark").
 */
export const ProviderUsageExtraLimit = Schema.Struct({
  label: Schema.String,
  session: Schema.NullOr(ProviderUsageWindow),
  weekly: Schema.NullOr(ProviderUsageWindow),
});
export type ProviderUsageExtraLimit = typeof ProviderUsageExtraLimit.Type;

/** Claude "extra usage" pay-per-use overflow credits shown by `/usage`. */
export const ProviderUsageExtraUsage = Schema.Struct({
  enabled: Schema.Boolean,
  /** 0–100 utilization of the extra-usage budget, when reported. */
  utilization: Schema.NullOr(Schema.Number),
});
export type ProviderUsageExtraUsage = typeof ProviderUsageExtraUsage.Type;

/** Codex API credits balance attached to the account. */
export const ProviderUsageCredits = Schema.Struct({
  balance: Schema.NullOr(Schema.String),
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
});
export type ProviderUsageCredits = typeof ProviderUsageCredits.Type;

/** Codex rate-limit reset credits ("Full reset (Weekly + 5 hr)" grants). */
export const ProviderUsageResetCredits = Schema.Struct({
  availableCount: Schema.Number,
  totalEarnedCount: Schema.NullOr(Schema.Number),
  /** Epoch milliseconds when the soonest available credit expires. */
  nextExpiresAt: Schema.NullOr(Schema.Number),
});
export type ProviderUsageResetCredits = typeof ProviderUsageResetCredits.Type;

export const ProviderUsageSnapshot = Schema.Struct({
  provider: ProviderUsageProviderKind,
  status: ProviderUsageStatus,
  /** The short (~5h) rolling window. */
  session: Schema.NullOr(ProviderUsageWindow),
  /** The long (~7d) rolling window covering all models. */
  weekly: Schema.NullOr(ProviderUsageWindow),
  /** Model/surface-scoped limits beyond the default pair. */
  extraLimits: Schema.Array(ProviderUsageExtraLimit),
  /** Human-readable plan/subscription label when the provider reports one. */
  planLabel: Schema.NullOr(Schema.String),
  /** Claude extra-usage overflow credits state (null for Codex). */
  extraUsage: Schema.NullOr(ProviderUsageExtraUsage),
  /** Codex API credits balance (null for Claude). */
  credits: Schema.NullOr(ProviderUsageCredits),
  /** Codex rate-limit reset credits (null for Claude). */
  resetCredits: Schema.NullOr(ProviderUsageResetCredits),
  /** Failure detail for non-"ok" statuses. */
  message: Schema.NullOr(Schema.String),
  /** Account-scoped provider dashboard URL, when it differs by account or organization. */
  detailsUrl: Schema.optional(Schema.String),
  /** Epoch milliseconds when this snapshot was fetched. */
  updatedAt: Schema.Number,
});
export type ProviderUsageSnapshot = typeof ProviderUsageSnapshot.Type;

export const GitHubCopilotBillingHistory = Schema.Struct({
  status: ProviderUsageStatus,
  message: Schema.NullOr(Schema.String),
  days: Schema.Array(
    Schema.Struct({
      /** Calendar day reported by GitHub's detailed billing ledger, formatted YYYY-MM-DD. */
      day: Schema.String,
      unit: Schema.Literals(["requests", "aiCredits"]),
      quantity: Schema.Number,
      grossAmountUsd: Schema.Number,
      discountAmountUsd: Schema.Number,
      netAmountUsd: Schema.Number,
      sku: Schema.String,
    }),
  ),
  models: Schema.Array(
    Schema.Struct({
      year: Schema.Number,
      unit: Schema.Literals(["requests", "aiCredits"]),
      model: Schema.String,
      quantity: Schema.Number,
      grossAmountUsd: Schema.Number,
      discountAmountUsd: Schema.Number,
      netAmountUsd: Schema.Number,
    }),
  ),
  updatedAt: Schema.Number,
});
export type GitHubCopilotBillingHistory = typeof GitHubCopilotBillingHistory.Type;

export const ServerProviderUsageResult = Schema.Struct({
  usage: Schema.Array(ProviderUsageSnapshot),
  githubCopilotBilling: Schema.NullOr(GitHubCopilotBillingHistory).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ServerProviderUsageResult = typeof ServerProviderUsageResult.Type;

export const ServerConsumeCodexResetCreditResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type ServerConsumeCodexResetCreditResult = typeof ServerConsumeCodexResetCreditResult.Type;

// ── Provider usage history (persisted samples, day aggregates) ───────
//
// The server records a row per "ok" usage snapshot as they are fetched and
// serves them back aggregated per provider per local calendar day, powering
// the usage-heatmap settings page. Days without samples are simply absent.

export const ProviderUsageHistoryDay = Schema.Struct({
  /** Local calendar day the samples fall on, formatted YYYY-MM-DD. */
  day: Schema.String,
  provider: ProviderUsageProviderKind,
  /** Highest session-window (~5h) utilization observed that day, 0–100. */
  peakSessionPercent: Schema.NullOr(Schema.Number),
  /** Mean session-window utilization across the day's samples, 0–100. */
  avgSessionPercent: Schema.NullOr(Schema.Number),
  /** Highest weekly-window (~7d) utilization observed that day, 0–100. */
  peakWeeklyPercent: Schema.NullOr(Schema.Number),
  sampleCount: Schema.Number,
});
export type ProviderUsageHistoryDay = typeof ProviderUsageHistoryDay.Type;

/**
 * Providers that can appear in the usage-history UI. Claude Code, Codex, and
 * OpenCode and Grok have backfillable token activity. Kilo contributes live
 * allowance samples because its current local integration does not provide a
 * reliable per-message token source.
 */
export const ProviderTokenActivityKind = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "kilocode",
  "opencode",
  "githubCopilot",
]);
export type ProviderTokenActivityKind = typeof ProviderTokenActivityKind.Type;

/**
 * Total tokens a subscription processed on one local calendar day, backfilled
 * from the provider's own local session logs, so history reaches back before
 * zrode started sampling.
 */
export const ProviderTokenActivityDay = Schema.Struct({
  /** Local calendar day, formatted YYYY-MM-DD. */
  day: Schema.String,
  provider: ProviderTokenActivityKind,
  /** Total tokens processed that day (input + cache + output). */
  tokens: Schema.Number,
});
export type ProviderTokenActivityDay = typeof ProviderTokenActivityDay.Type;

/**
 * Model-scoped token activity read from provider logs. The token categories
 * intentionally mirror API billing meters so clients can calculate a
 * transparent API-equivalent estimate without pretending subscription usage
 * was actually invoiced at API rates.
 */
export const ProviderModelTokenActivityDay = Schema.Struct({
  /** Local calendar day, formatted YYYY-MM-DD. */
  day: Schema.String,
  provider: ProviderTokenActivityKind,
  /** Provider-qualified when the log exposes both values (for example OpenCode). */
  model: Schema.String,
  /** Non-cached input tokens billed at the model's base input rate. */
  inputTokens: Schema.Number,
  /** Input tokens served from a prompt cache. */
  cachedInputTokens: Schema.Number,
  /** Input tokens written to a prompt cache. */
  cacheWriteTokens: Schema.Number,
  /** Input tokens written to a one-hour prompt cache, priced separately by Anthropic. */
  cacheWrite1hTokens: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Generated output, including reasoning tokens when the provider reports them separately. */
  outputTokens: Schema.Number,
  /** All processed tokens, used for model ranking. */
  totalTokens: Schema.Number,
  /** Provider-recorded request cost when available (Claude, xAI, and hosted OpenCode requests). */
  recordedCostUsd: Schema.NullOr(Schema.Number),
  /** The provider log says these requests used a fast/priority service tier. */
  isFast: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** At least one request in this row crossed the provider's long-context pricing threshold. */
  usesLongContext: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ProviderModelTokenActivityDay = typeof ProviderModelTokenActivityDay.Type;

export const ServerProviderUsageHistoryInput = Schema.Struct({
  /** How many days back from today to include (1–400, clamped server-side). */
  days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 })),
  /** Skip the scan throttle and re-scan the local session logs now. */
  rescan: Schema.optional(Schema.Boolean),
});
export type ServerProviderUsageHistoryInput = typeof ServerProviderUsageHistoryInput.Type;

export const ServerProviderUsageHistoryResult = Schema.Struct({
  days: Schema.Array(ProviderUsageHistoryDay),
  /** Daily token totals derived from local provider session logs. */
  tokenActivity: Schema.Array(ProviderTokenActivityDay),
  /** Daily model/category totals used for model rankings and API-equivalent cost estimates. */
  modelActivity: Schema.Array(ProviderModelTokenActivityDay).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** GitHub's account-level monthly request/AI-credit ledger (not token activity). */
  githubCopilotBilling: Schema.NullOr(GitHubCopilotBillingHistory).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** True while a background scan of the local session logs is running. */
  isBackfilling: Schema.Boolean,
  /**
   * The server's current local calendar day (YYYY-MM-DD). Day buckets are
   * computed in the server's timezone, so clients anchor their calendars to
   * this instead of the browser's clock — the two can disagree for remote
   * environments.
   */
  today: Schema.String,
  /** Epoch ms when the last log scan completed (null before the first). */
  lastScanAt: Schema.NullOr(Schema.Number),
  /** How long samples are retained before being pruned, in days. */
  retentionDays: Schema.Number,
});
export type ServerProviderUsageHistoryResult = typeof ServerProviderUsageHistoryResult.Type;
