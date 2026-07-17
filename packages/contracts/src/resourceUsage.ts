import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderSession } from "./provider.ts";
import { TerminalSummary } from "./terminal.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ProcessId = Schema.Int.check(Schema.isGreaterThan(0));

/** Resource totals for the complete process tree rooted at one terminal PTY. */
export const TerminalRuntimeResourceUsage = Schema.Struct({
  terminal: TerminalSummary,
  /** Percent of one logical CPU core; the value may exceed 100. */
  cpuPercent: Schema.Number,
  /** Resident memory for the PTY and all of its descendants, in bytes. */
  rssBytes: NonNegativeInt,
  processCount: NonNegativeInt,
});
export type TerminalRuntimeResourceUsage = typeof TerminalRuntimeResourceUsage.Type;

/** Resource totals for the locally-owned process trees behind one provider session. */
export const ProviderRuntimeResourceUsage = Schema.Struct({
  session: ProviderSession,
  /** Root process ids owned by this provider session. Empty for remote/external runtimes. */
  rootPids: Schema.Array(ProcessId),
  /** Percent of one logical CPU core; the value may exceed 100. */
  cpuPercent: Schema.Number,
  /** Resident memory for every locally-owned process in this provider session, in bytes. */
  rssBytes: NonNegativeInt,
  processCount: NonNegativeInt,
});
export type ProviderRuntimeResourceUsage = typeof ProviderRuntimeResourceUsage.Type;

/** Live inventory of every terminal and provider runtime owned by one environment. */
export const RuntimeResourceSnapshot = Schema.Struct({
  terminals: Schema.Array(TerminalRuntimeResourceUsage),
  providers: Schema.Array(ProviderRuntimeResourceUsage),
  totalCpuPercent: Schema.Number,
  totalRssBytes: NonNegativeInt,
  processCount: NonNegativeInt,
  collectedAt: Schema.DateTimeUtc,
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type RuntimeResourceSnapshot = typeof RuntimeResourceSnapshot.Type;
