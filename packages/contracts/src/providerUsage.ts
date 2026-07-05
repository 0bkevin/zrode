import * as Schema from "effect/Schema";

// ── Provider subscription usage (rate-limit windows) ────────────────
//
// Snapshot of how much of a subscription's rate-limit windows remain for a
// provider account (Claude Code / Codex). Fetched server-side from the
// provider's own usage APIs using the locally-authenticated CLI credentials;
// surfaced in the client status UI as "session" (~5h) and "weekly" (~7d)
// meters.

export const ProviderUsageProviderKind = Schema.Literals(["claude", "codex"]);
export type ProviderUsageProviderKind = typeof ProviderUsageProviderKind.Type;

export const ProviderUsageStatus = Schema.Literals([
  "ok",
  "unauthenticated",
  "unavailable",
  "error",
]);
export type ProviderUsageStatus = typeof ProviderUsageStatus.Type;

export const ProviderUsageWindow = Schema.Struct({
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
  /** Epoch milliseconds when this snapshot was fetched. */
  updatedAt: Schema.Number,
});
export type ProviderUsageSnapshot = typeof ProviderUsageSnapshot.Type;

export const ServerProviderUsageResult = Schema.Struct({
  usage: Schema.Array(ProviderUsageSnapshot),
});
export type ServerProviderUsageResult = typeof ServerProviderUsageResult.Type;

export const ServerConsumeCodexResetCreditResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type ServerConsumeCodexResetCreditResult = typeof ServerConsumeCodexResetCreditResult.Type;
