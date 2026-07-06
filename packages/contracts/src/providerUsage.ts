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
 * Providers whose per-message token usage zrode can backfill from local
 * session logs on disk. A superset of the metered (live-usage) providers:
 * Claude Code transcripts, Codex rollouts, and OpenCode's message store all
 * record per-message token counts, so their history reaches back before zrode
 * started sampling. (Cursor and Grok keep no local token usage — only code
 * stats / a system-prompt size — so they are absent here by design.)
 */
export const ProviderTokenActivityKind = Schema.Literals(["claude", "codex", "opencode"]);
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
