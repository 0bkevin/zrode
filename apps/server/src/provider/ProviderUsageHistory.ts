/**
 * Persisted provider usage history.
 *
 * Two data sources back the usage-heatmap settings page:
 *
 * - **Rate-limit samples** — every "ok" usage snapshot the server fetches
 *   (see `providerUsage.ts`) is recorded keyed by `(provider, updatedAt)`,
 *   so serving a cached snapshot again is a no-op instead of a duplicate.
 * - **Token activity backfill** — the providers keep local session logs with
 *   per-message token usage (Claude Code transcripts under
 *   `<config-dir>/projects/**.jsonl`, Codex rollouts under
 *   `$CODEX_HOME/{sessions,archived_sessions}/**.jsonl`, Grok's
 *   `$GROK_HOME/logs/unified.jsonl`, and OpenCode's current local SQLite
 *   stores (with its legacy per-message JSON store as a fallback). A
 *   throttled background scan parses them into per-day token totals, which is
 *   what lets the heatmap show real usage from before zrode started sampling.
 *   The scan is incremental: append-only transcripts are re-parsed only when
 *   their mtime/size changes, immutable per-message files are parsed once, and
 *   entries carry stable semantic keys so resumed/forked sessions that replay
 *   history are counted once. Cursor has no local token ledger here.
 *
 * Aggregates are read per provider per *local* calendar day (the server runs
 * on the user's machine, so local time is the user's timezone). Everything
 * is best-effort: recording, scanning, and reading fold failures into logged
 * warnings so they can never fail the usage RPCs they piggyback on.
 */
import * as NodeOS from "node:os";

import type {
  ProviderTokenActivityKind,
  ProviderUsageProviderKind,
  ServerProviderUsageHistoryInput,
  ServerProviderUsageHistoryResult,
  ServerProviderUsageResult,
  ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { defaultClaudeInstanceSettings, resolveClaudeConfigDirPath } from "./Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { readOpenCodeUsageDatabase } from "./OpenCodeUsageDatabase.ts";

/** Samples older than this are pruned as new samples are recorded. */
export const USAGE_HISTORY_RETENTION_DAYS = 400;

/**
 * Minimum spacing between passive background scans of the local session
 * logs. Reads are decoupled from scans: a history poll only re-reads SQL,
 * and the (directory-walk + stat sweep) scan runs at most this often.
 */
const TOKEN_SYNC_MIN_INTERVAL_MS = 30 * 60_000;
/** Even a forced rescan won't repeat a sweep more often than this. */
const TOKEN_SYNC_FORCE_MIN_INTERVAL_MS = 15_000;
/** How many log files are read concurrently during a scan. */
const TOKEN_SYNC_FILE_CONCURRENCY = 2;

const DAY_MS = 24 * 60 * 60_000;

class OpenCodeUsageDatabaseReadError extends Schema.TaggedErrorClass<OpenCodeUsageDatabaseReadError>()(
  "OpenCodeUsageDatabaseReadError",
  { filename: Schema.String, cause: Schema.Defect() },
) {}

export class ProviderUsageHistory extends Context.Service<
  ProviderUsageHistory,
  {
    /** Persist the "ok" snapshots of a usage result; never fails. */
    readonly record: (result: ServerProviderUsageResult) => Effect.Effect<void>;
    /**
     * Read day-aggregated history (rate-limit samples + token activity) and
     * kick off a throttled background log scan; folds failures into an
     * empty result.
     */
    readonly readHistory: (
      input: ServerProviderUsageHistoryInput,
      settings: ServerSettings,
    ) => Effect.Effect<ServerProviderUsageHistoryResult>;
  }
>()("t3/provider/ProviderUsageHistory") {}

// ── Log-line parsing (pure, exported for tests) ──────────────────────

export interface ParsedTokenEntry {
  /** Override the source provider when a gateway log identifies the real subscription. */
  readonly provider?: ProviderTokenActivityKind;
  readonly entryKey: string;
  readonly epochMs: number;
  readonly tokens: number;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly outputTokens: number;
  readonly recordedCostUsd: number | null;
  readonly isFast: boolean;
  readonly usesLongContext: boolean;
  /** Claude replay identity. Exact requests coexist; sidechain copies do not. */
  readonly claudeDedup?: {
    readonly groupKey: string;
    readonly requestId: string;
    readonly isSidechain: boolean;
  };
  /** Higher wins when the same semantic provider event is replayed. */
  readonly dedupPriority: number;
}

function claudeRequestEntryKey(groupKey: string, requestId: string): string {
  return JSON.stringify(["request", groupKey, requestId]);
}

function claudeRequestEntryPrefix(groupKey: string): string {
  return `${JSON.stringify(["request", groupKey]).slice(0, -1)},`;
}

function claudeSidechainEntryKey(groupKey: string): string {
  return JSON.stringify(["sidechain", groupKey]);
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const localZone = DateTime.zoneMakeLocal();

/** Local calendar day (YYYY-MM-DD) an epoch-ms timestamp falls on. */
export function localDayKey(epochMs: number): string {
  const parts = DateTime.toParts(DateTime.setZone(DateTime.makeUnsafe(epochMs), localZone));
  const month = `${parts.month}`.padStart(2, "0");
  const day = `${parts.day}`.padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

/**
 * Parse one Claude Code transcript line. Token-bearing lines are assistant
 * messages whose `message.usage` carries the request's token counts; the
 * total counts input, output, and both cache directions (all tokens the
 * subscription processed). Keyed by message id + request id, the same pair
 * a resumed session replays verbatim.
 */
export function parseClaudeTranscriptLine(line: string): ParsedTokenEntry | null {
  return parseClaudeTranscriptEntries(line)[0] ?? null;
}

interface ClaudeUsageShape {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly speed?: unknown;
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: unknown;
    readonly ephemeral_1h_input_tokens?: unknown;
  } | null;
  readonly iterations?: ReadonlyArray<Record<string, unknown>> | null;
}

function parseClaudeTokenBreakdown(usage: ClaudeUsageShape): {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly outputTokens: number;
  readonly tokens: number;
  readonly isFast: boolean;
  readonly hasSpeed: boolean;
} | null {
  if (
    typeof usage.input_tokens !== "number" ||
    !Number.isFinite(usage.input_tokens) ||
    typeof usage.output_tokens !== "number" ||
    !Number.isFinite(usage.output_tokens)
  ) {
    return null;
  }
  const speed = usage.speed;
  if (speed !== undefined && speed !== "fast" && speed !== "standard") return null;
  const inputTokens = Math.max(0, usage.input_tokens);
  const outputTokens = Math.max(0, usage.output_tokens);
  const cacheCreation = usage.cache_creation;
  const cacheWriteTokens = cacheCreation
    ? Math.max(0, asFiniteNumber(cacheCreation.ephemeral_5m_input_tokens))
    : Math.max(0, asFiniteNumber(usage.cache_creation_input_tokens));
  const cacheWrite1hTokens = cacheCreation
    ? Math.max(0, asFiniteNumber(cacheCreation.ephemeral_1h_input_tokens))
    : 0;
  const cachedInputTokens = Math.max(0, asFiniteNumber(usage.cache_read_input_tokens));
  const tokens =
    inputTokens + outputTokens + cacheWriteTokens + cacheWrite1hTokens + cachedInputTokens;
  if (tokens <= 0) return null;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    cacheWrite1hTokens,
    outputTokens,
    tokens,
    isFast: speed === "fast",
    hasSpeed: speed !== undefined,
  };
}

/** Parse the main Claude request and any nested advisor requests exactly once. */
export function parseClaudeTranscriptEntries(line: string): ReadonlyArray<ParsedTokenEntry> {
  if (!line.includes('"usage"')) return [];
  let record: {
    readonly type?: unknown;
    readonly timestamp?: unknown;
    readonly requestId?: unknown;
    readonly isSidechain?: unknown;
    readonly costUSD?: unknown;
    readonly message?: {
      readonly id?: unknown;
      readonly model?: unknown;
      readonly usage?: ClaudeUsageShape | null;
    } | null;
  };
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  if (record.type !== "assistant") return [];
  const usage = record.message?.usage;
  const messageId = record.message?.id;
  if (!usage || typeof messageId !== "string" || messageId.length === 0) return [];
  const epochMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (!Number.isFinite(epochMs)) return [];
  const parsed = parseClaudeTokenBreakdown(usage);
  if (parsed === null) return [];
  const isSidechain = record.isSidechain === true;
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  const model =
    typeof record.message?.model === "string" && record.message.model.length > 0
      ? record.message.model === "<synthetic>"
        ? null
        : record.message.model
      : null;
  const carriedCost =
    typeof record.costUSD === "number" && Number.isFinite(record.costUSD) && record.costUSD >= 0
      ? record.costUSD
      : null;
  const parent: ParsedTokenEntry = {
    // Exact requests are message+request pairs. Sidechain replays instead use
    // a message-level key so they cannot inflate the originating request.
    entryKey: isSidechain
      ? claudeSidechainEntryKey(messageId)
      : claudeRequestEntryKey(messageId, requestId),
    epochMs,
    tokens: parsed.tokens,
    model,
    inputTokens: parsed.inputTokens,
    cachedInputTokens: parsed.cachedInputTokens,
    cacheWriteTokens: parsed.cacheWriteTokens,
    cacheWrite1hTokens: parsed.cacheWrite1hTokens,
    outputTokens: parsed.outputTokens,
    recordedCostUsd: carriedCost,
    isFast: parsed.isFast,
    usesLongContext:
      parsed.inputTokens +
        parsed.cachedInputTokens +
        parsed.cacheWriteTokens +
        parsed.cacheWrite1hTokens >
      200_000,
    dedupPriority: parsed.tokens * 4 + (carriedCost !== null ? 2 : 0) + (parsed.hasSpeed ? 1 : 0),
    claudeDedup: { groupKey: messageId, requestId, isSidechain },
  };
  const entries: ParsedTokenEntry[] = [parent];
  let advisorIndex = 0;
  for (const iteration of usage.iterations ?? []) {
    if (iteration.type !== "advisor_message") continue;
    const advisorModel =
      typeof iteration.model === "string" && iteration.model.length > 0 ? iteration.model : null;
    const advisor = parseClaudeTokenBreakdown(iteration as ClaudeUsageShape);
    if (advisorModel === null || advisor === null) continue;
    const advisorGroupKey = `${messageId}:advisor:${advisorIndex}`;
    entries.push({
      entryKey: isSidechain
        ? claudeSidechainEntryKey(advisorGroupKey)
        : claudeRequestEntryKey(advisorGroupKey, requestId),
      epochMs,
      tokens: advisor.tokens,
      model: advisorModel,
      inputTokens: advisor.inputTokens,
      cachedInputTokens: advisor.cachedInputTokens,
      cacheWriteTokens: advisor.cacheWriteTokens,
      cacheWrite1hTokens: advisor.cacheWrite1hTokens,
      outputTokens: advisor.outputTokens,
      recordedCostUsd: null,
      isFast: advisor.isFast,
      usesLongContext:
        advisor.inputTokens +
          advisor.cachedInputTokens +
          advisor.cacheWriteTokens +
          advisor.cacheWrite1hTokens >
        200_000,
      dedupPriority: advisor.tokens * 4 + (advisor.hasSpeed ? 1 : 0),
      claudeDedup: { groupKey: advisorGroupKey, requestId, isSidechain },
    });
    advisorIndex += 1;
  }
  return entries;
}

/**
 * Parse one Codex rollout line. `token_count` events carry the turn's token
 * usage in `info.last_token_usage`; summing them across a rollout equals the
 * rollout's total. Keyed by file + line number (rollout filenames embed a
 * UUID, and files only ever grow).
 */
export function parseCodexRolloutLine(
  line: string,
  entryKeyPrefix: string,
  lineNumber: number,
  model: string | null = null,
): ParsedTokenEntry | null {
  const state = makeCodexParseState();
  state.currentModel = model;
  const parsed = parseCodexRolloutLineWithState(line, state);
  return parsed === null ? null : { ...parsed, entryKey: `${entryKeyPrefix}:${lineNumber}` };
}

interface RawCodexUsage {
  readonly input: number;
  readonly cached: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
  readonly total: number;
}

interface CodexReplayGate {
  readonly createdAtSeconds: number | null;
}

interface CodexParseState {
  sessionId: string | null;
  currentModel: string | null;
  previousTotals: RawCodexUsage | null;
  isFast: boolean;
  sawSessionMeta: boolean;
  replayGate: CodexReplayGate | null;
}

function makeCodexParseState(): CodexParseState {
  return {
    sessionId: null,
    currentModel: null,
    previousTotals: null,
    isFast: false,
    sawSessionMeta: false,
    replayGate: null,
  };
}

function asCodexUsage(value: unknown): RawCodexUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const json = value as Record<string, unknown>;
  const read = (...keys: ReadonlyArray<string>): number => {
    for (const key of keys) {
      if (typeof json[key] === "number" && Number.isFinite(json[key])) {
        return Math.max(0, json[key]);
      }
    }
    return 0;
  };
  const input = read("input_tokens", "prompt_tokens", "input");
  const cached = read("cached_input_tokens", "cache_read_input_tokens", "cached_tokens");
  const cacheWrite = read("cache_write_input_tokens", "cache_write_tokens");
  const output = read("output_tokens", "completion_tokens", "output");
  const reasoning = read("reasoning_output_tokens", "reasoning_tokens");
  const reportedTotal = read("total_tokens");
  // Responses API reasoning tokens are a detail bucket inside output_tokens,
  // not an additional output category. Codex preserves both values in its
  // rollout protocol, so adding them would double count reasoning.
  const recomputed = input + output;
  return {
    input,
    cached,
    cacheWrite,
    output,
    reasoning,
    total: reportedTotal > 0 || recomputed === 0 ? reportedTotal : recomputed,
  };
}

function codexUsageEquals(left: RawCodexUsage, right: RawCodexUsage): boolean {
  return (
    left.input === right.input &&
    left.cached === right.cached &&
    left.cacheWrite === right.cacheWrite &&
    left.output === right.output &&
    left.reasoning === right.reasoning &&
    left.total === right.total
  );
}

function subtractCodexUsage(totals: RawCodexUsage, previous: RawCodexUsage | null): RawCodexUsage {
  return {
    input: Math.max(0, totals.input - (previous?.input ?? 0)),
    cached: Math.max(0, totals.cached - (previous?.cached ?? 0)),
    cacheWrite: Math.max(0, totals.cacheWrite - (previous?.cacheWrite ?? 0)),
    output: Math.max(0, totals.output - (previous?.output ?? 0)),
    reasoning: Math.max(0, totals.reasoning - (previous?.reasoning ?? 0)),
    total: Math.max(0, totals.total - (previous?.total ?? 0)),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function codexModelFrom(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const json = value as Record<string, unknown>;
  const metadata =
    typeof json.metadata === "object" && json.metadata !== null
      ? (json.metadata as Record<string, unknown>)
      : null;
  return (
    nonEmptyString(json.model) ?? nonEmptyString(json.model_name) ?? nonEmptyString(metadata?.model)
  );
}

function isPresentJsonValue(value: unknown): boolean {
  return (
    value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0)
  );
}

function isCodexChildSession(payload: Record<string, unknown>): boolean {
  if (isPresentJsonValue(payload.forked_from_id)) return true;
  if (isPresentJsonValue(payload.parent_thread_id)) return true;
  if (payload.thread_source === "subagent") return true;
  const source =
    typeof payload.source === "object" && payload.source !== null
      ? (payload.source as Record<string, unknown>)
      : null;
  return isPresentJsonValue(source?.subagent);
}

const CODEX_AUTO_REVIEW_MODELS: ReadonlyArray<readonly [string, string]> = [
  ["2026-04-23", "gpt-5.5"],
  ["2026-03-05", "gpt-5.4"],
  ["2026-02-05", "gpt-5.3-codex"],
  ["2025-12-11", "gpt-5.2-codex"],
  ["2025-11-13", "gpt-5.1-codex"],
  ["2025-09-15", "gpt-5-codex"],
  ["2025-08-07", "gpt-5"],
];

function resolveCodexModel(model: string | null, timestamp: string): string {
  const resolved = model ?? "gpt-5";
  if (resolved !== "codex-auto-review") return resolved;
  const day = timestamp.slice(0, 10);
  return CODEX_AUTO_REVIEW_MODELS.find(([released]) => day >= released)?.[1] ?? "gpt-5";
}

function parseCodexRolloutLineWithState(
  line: string,
  state: CodexParseState,
): ParsedTokenEntry | null {
  if (
    !line.includes('"token_count"') &&
    !line.includes('"turn_context"') &&
    !line.includes('"session_meta"') &&
    !line.includes('"task_started"') &&
    !line.includes('"thread_settings_applied"')
  ) {
    return null;
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const payload =
    typeof record.payload === "object" && record.payload !== null
      ? (record.payload as Record<string, unknown>)
      : null;
  if (record.type === "turn_context") {
    state.currentModel = codexModelFrom(payload) ?? state.currentModel;
    return null;
  }
  if (record.type === "session_meta" && !state.sawSessionMeta) {
    state.sawSessionMeta = true;
    state.sessionId = nonEmptyString(payload?.id);
    if (payload !== null && isCodexChildSession(payload)) {
      const createdAt = nonEmptyString(record.timestamp);
      const createdAtMs = createdAt === null ? Number.NaN : Date.parse(createdAt);
      state.replayGate = {
        createdAtSeconds: Number.isFinite(createdAtMs) ? Math.floor(createdAtMs / 1_000) : null,
      };
    }
    return null;
  }
  if (record.type !== "event_msg" || payload === null) return null;
  if (payload.type === "thread_settings_applied") {
    const settings =
      typeof payload.thread_settings === "object" && payload.thread_settings !== null
        ? (payload.thread_settings as Record<string, unknown>)
        : null;
    const tier = nonEmptyString(settings?.service_tier) ?? nonEmptyString(payload.service_tier);
    // This event is a complete settings snapshot. An omitted/null tier means
    // the preference was cleared and must not inherit an earlier fast turn.
    state.isFast = tier === "fast" || tier === "priority";
    return null;
  }
  if (payload.type === "task_started") {
    if (state.replayGate !== null && typeof payload.started_at === "number") {
      const lineTimestamp = nonEmptyString(record.timestamp);
      const lineEpochMs = lineTimestamp === null ? Number.NaN : Date.parse(lineTimestamp);
      const threshold =
        state.replayGate.createdAtSeconds ??
        (Number.isFinite(lineEpochMs) ? Math.floor(lineEpochMs / 1_000) : Number.POSITIVE_INFINITY);
      if (payload.started_at >= threshold) state.replayGate = null;
    }
    return null;
  }
  if (payload.type !== "token_count") return null;
  const timestamp = nonEmptyString(record.timestamp);
  const epochMs = timestamp === null ? Number.NaN : Date.parse(timestamp);
  if (!Number.isFinite(epochMs)) return null;
  const info =
    typeof payload.info === "object" && payload.info !== null
      ? (payload.info as Record<string, unknown>)
      : null;
  const totals = asCodexUsage(info?.total_token_usage);
  if (state.replayGate !== null) {
    if (totals !== null) state.previousTotals = totals;
    return null;
  }
  if (
    totals !== null &&
    state.previousTotals !== null &&
    codexUsageEquals(totals, state.previousTotals)
  ) {
    return null;
  }
  const last = asCodexUsage(info?.last_token_usage);
  const usage = last ?? (totals === null ? null : subtractCodexUsage(totals, state.previousTotals));
  if (totals !== null) state.previousTotals = totals;
  if (
    usage === null ||
    (usage.input <= 0 &&
      usage.cached <= 0 &&
      usage.cacheWrite <= 0 &&
      usage.output <= 0 &&
      usage.reasoning <= 0)
  ) {
    return null;
  }
  state.currentModel = codexModelFrom(payload) ?? codexModelFrom(info) ?? state.currentModel;
  const model = resolveCodexModel(state.currentModel, timestamp!);
  state.currentModel = model;
  const cachedInputTokens = Math.min(usage.cached, usage.input);
  const cacheWriteTokens = Math.min(usage.cacheWrite, usage.input - cachedInputTokens);
  const inputTokens = Math.max(0, usage.input - cachedInputTokens - cacheWriteTokens);
  const outputTokens = usage.output;
  const tokens = usage.total > 0 ? usage.total : usage.input + outputTokens;
  if (tokens <= 0) return null;
  return {
    entryKey: [
      state.sessionId ?? "unknown-session",
      "event",
      epochMs,
      model,
      usage.input,
      cachedInputTokens,
      cacheWriteTokens,
      usage.output,
      usage.reasoning,
      tokens,
    ].join(":"),
    epochMs,
    tokens,
    model,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: 0,
    outputTokens,
    recordedCostUsd: null,
    isFast: state.isFast,
    usesLongContext: usage.input > 272_000,
    dedupPriority: 0,
  };
}

/** Parse a complete rollout with cumulative-delta and child-replay state. */
export function parseCodexRolloutFile(content: string): ReadonlyArray<ParsedTokenEntry> {
  const state = makeCodexParseState();
  const entries: ParsedTokenEntry[] = [];
  for (const line of content.split("\n")) {
    const entry = parseCodexRolloutLineWithState(line, state);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** The active model is recorded on each Codex `turn_context` rollout line. */
export function parseCodexTurnContextModel(line: string): string | null {
  if (!line.includes('"turn_context"') || !line.includes('"model"')) return null;
  try {
    const record = JSON.parse(line) as {
      readonly type?: unknown;
      readonly payload?: { readonly model?: unknown } | null;
    };
    return record.type === "turn_context" &&
      typeof record.payload?.model === "string" &&
      record.payload.model.length > 0
      ? record.payload.model
      : null;
  } catch {
    return null;
  }
}

function usesKnownLongContextTier(model: string, promptTokens: number): boolean {
  const slug = model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
  if (/^gpt-5[.-](?:4|5|6)(?:-|$)/.test(slug)) return promptTokens > 272_000;
  if (slug.startsWith("claude-") || slug.startsWith("grok-")) return promptTokens > 200_000;
  return false;
}

/**
 * Parse one OpenCode message file. OpenCode stores each message as its own
 * JSON object under `<data>/storage/message/<sessionId>/<messageId>.json`;
 * assistant messages carry `tokens{input,output,reasoning,cache{read,write}}`
 * and a completion time. Keyed by the message id, which is globally unique and
 * stable, so re-scanning a file is idempotent.
 */
export function parseOpenCodeMessageFile(
  content: string,
  fallback?: { readonly id: string; readonly epochMs: number },
): ParsedTokenEntry | null {
  let record: {
    readonly id?: unknown;
    readonly role?: unknown;
    readonly modelID?: unknown;
    readonly providerID?: unknown;
    readonly cost?: unknown;
    readonly time?: { readonly created?: unknown; readonly completed?: unknown } | null;
    readonly tokens?: {
      readonly total?: unknown;
      readonly input?: unknown;
      readonly output?: unknown;
      readonly reasoning?: unknown;
      readonly cache?: { readonly read?: unknown; readonly write?: unknown } | null;
    } | null;
  };
  try {
    record = JSON.parse(content);
  } catch {
    return null;
  }
  if (record.role !== "assistant") return null;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : fallback?.id;
  const usage = record.tokens;
  if (!usage || id === undefined || id.length === 0) return null;
  // `completed` is set once the assistant turn finishes; fall back to
  // `created` for a turn still in flight when the scan runs.
  const epochMs =
    asFiniteNumber(record.time?.completed) ||
    asFiniteNumber(record.time?.created) ||
    fallback?.epochMs ||
    0;
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  const inputTokens = asFiniteNumber(usage.input);
  const cachedInputTokens = asFiniteNumber(usage.cache?.read);
  const cacheWriteTokens = asFiniteNumber(usage.cache?.write);
  const outputTokens = asFiniteNumber(usage.output) + asFiniteNumber(usage.reasoning);
  const categorizedTokens = inputTokens + outputTokens + cachedInputTokens + cacheWriteTokens;
  const reportedTokens = Math.max(0, asFiniteNumber(usage.total));
  const tokens = reportedTokens > 0 ? reportedTokens : categorizedTokens;
  if (tokens <= 0) return null;
  const modelId = typeof record.modelID === "string" ? record.modelID : "";
  const providerId = typeof record.providerID === "string" ? record.providerID : "";
  const qualifiedModel =
    modelId.length > 0 ? (providerId.length > 0 ? `${providerId}/${modelId}` : modelId) : null;
  const isHostedGateway = providerId === "opencode" || providerId === "opencode-go";
  const recordedCost =
    typeof record.cost === "number" &&
    Number.isFinite(record.cost) &&
    // OpenCode calculates this ledger value from the exact provider/model
    // catalog active for the request. Positive BYO charges (Vertex, Azure,
    // Bedrock, etc.) are therefore more precise than re-pricing a stripped
    // model alias later. BYO providers also emit zero as an unknown-price
    // placeholder, so only hosted gateways may treat zero as authoritative.
    (record.cost > 0 || (isHostedGateway && record.cost === 0))
      ? record.cost
      : null;
  return {
    ...(providerId === "github-copilot" ? { provider: "githubCopilot" as const } : {}),
    entryKey: id,
    epochMs,
    tokens,
    model: qualifiedModel,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: 0,
    outputTokens,
    recordedCostUsd: recordedCost,
    isFast: false,
    usesLongContext:
      qualifiedModel !== null &&
      usesKnownLongContextTier(qualifiedModel, inputTokens + cachedInputTokens + cacheWriteTokens),
    dedupPriority: 0,
  };
}

/** Parse Copilot CLI's final per-model session accounting event. */
export function parseGitHubCopilotEventLine(line: string): ReadonlyArray<ParsedTokenEntry> {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (record.type !== "session.shutdown") return [];
  const data = record.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  const eventId = typeof record.id === "string" ? record.id : null;
  const epochMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  const metrics = (data as Record<string, unknown>).modelMetrics;
  if (
    eventId === null ||
    !Number.isFinite(epochMs) ||
    metrics === null ||
    typeof metrics !== "object" ||
    Array.isArray(metrics)
  ) {
    return [];
  }
  return Object.entries(metrics as Record<string, unknown>).flatMap(([model, raw]) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
    const usage = (raw as Record<string, unknown>).usage;
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return [];
    const values = usage as Record<string, unknown>;
    const inputTokens = asFiniteNumber(values.inputTokens);
    const cachedInputTokens = asFiniteNumber(values.cacheReadTokens);
    const cacheWriteTokens = asFiniteNumber(values.cacheWriteTokens);
    const outputTokens =
      asFiniteNumber(values.outputTokens) + asFiniteNumber(values.reasoningTokens);
    const tokens = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens;
    if (tokens <= 0) return [];
    return [
      {
        entryKey: `${eventId}:${model}`,
        epochMs,
        tokens,
        model,
        inputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        cacheWrite1hTokens: 0,
        outputTokens,
        recordedCostUsd: null,
        isFast: false,
        usesLongContext: false,
        dedupPriority: 0,
      },
    ];
  });
}

interface GrokParseState {
  readonly modelByPid: Map<number, string>;
}

function makeGrokParseState(): GrokParseState {
  return { modelByPid: new Map() };
}

function grokModelFromEvent(message: string, context: Record<string, unknown>): string | null {
  switch (message) {
    case "model changed":
      return nonEmptyString(context.model);
    case "model catalog: notifying clients":
      return nonEmptyString(context.current_model_id);
    case "backend_search: model switch":
      return (
        nonEmptyString(context.model) ??
        nonEmptyString(context.current_model_id) ??
        nonEmptyString(context.model_id)
      );
    case "subagent model resolved":
      return nonEmptyString(context.model_id) ?? nonEmptyString(context.model);
    default:
      return null;
  }
}

/** Parse one Grok unified-log line while tracking the active model per CLI process. */
function parseGrokLogLine(line: string, state: GrokParseState): ParsedTokenEntry | null {
  if (!line.includes("inference_done") && !line.includes("model")) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const message = nonEmptyString(record.msg);
  if (message === null) return null;
  const context =
    typeof record.ctx === "object" && record.ctx !== null
      ? (record.ctx as Record<string, unknown>)
      : {};
  const pid = typeof record.pid === "number" && Number.isFinite(record.pid) ? record.pid : null;
  const changedModel = grokModelFromEvent(message, context);
  if (changedModel !== null) {
    if (pid !== null) state.modelByPid.set(pid, changedModel);
    return null;
  }
  if (message !== "shell.turn.inference_done") return null;
  if (typeof context.prompt_tokens !== "number" || !Number.isFinite(context.prompt_tokens)) {
    return null;
  }
  const promptTokens = Math.max(0, context.prompt_tokens);
  const timestamp = nonEmptyString(record.ts);
  const epochMs = timestamp === null ? Number.NaN : Date.parse(timestamp);
  if (!Number.isFinite(epochMs)) return null;
  const model = pid === null ? null : (state.modelByPid.get(pid) ?? null);
  const cachedInputTokens = Math.min(
    promptTokens,
    Math.max(0, asFiniteNumber(context.cached_prompt_tokens)),
  );
  const inputTokens = Math.max(0, promptTokens - cachedInputTokens);
  const outputTokens =
    Math.max(0, asFiniteNumber(context.completion_tokens)) +
    Math.max(0, asFiniteNumber(context.reasoning_tokens));
  const tokens = promptTokens + outputTokens;
  const usage =
    typeof context.usage === "object" && context.usage !== null
      ? (context.usage as Record<string, unknown>)
      : null;
  const rawCostTicks = context.cost_in_usd_ticks ?? usage?.cost_in_usd_ticks;
  const costTicks =
    typeof rawCostTicks === "number"
      ? rawCostTicks
      : typeof rawCostTicks === "string" && rawCostTicks.trim().length > 0
        ? Number(rawCostTicks)
        : Number.NaN;
  // New xAI responses carry the authoritative per-request charge. Prefer it
  // whenever the CLI persists it; one US dollar is exactly 10^10 ticks.
  const recordedCostUsd =
    Number.isFinite(costTicks) && costTicks >= 0 ? costTicks / 10_000_000_000 : null;
  // The provider-recorded charge remains authoritative even if log rotation
  // removed the earlier PID-to-model event, or if a charged event has no
  // token categories. Surface it as Unattributed instead of losing spend.
  if (model === null && recordedCostUsd === null) return null;
  if (tokens <= 0 && recordedCostUsd === null) return null;
  return {
    entryKey: JSON.stringify([
      "inference",
      epochMs,
      pid,
      model,
      promptTokens,
      cachedInputTokens,
      outputTokens,
      recordedCostUsd,
    ]),
    epochMs,
    tokens,
    model,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens,
    recordedCostUsd,
    isFast: false,
    usesLongContext: promptTokens > 200_000,
    dedupPriority: 0,
  };
}

/** Parse a complete Grok unified log in chronological order. */
export function parseGrokUnifiedLog(content: string): ReadonlyArray<ParsedTokenEntry> {
  const state = makeGrokParseState();
  const entries: ParsedTokenEntry[] = [];
  for (const line of content.split("\n")) {
    const entry = parseGrokLogLine(line, state);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

// ── Schemas ──────────────────────────────────────────────────────────

const HistorySample = Schema.Struct({
  provider: Schema.String,
  sampledAt: Schema.Number,
  sessionUsedPercent: Schema.NullOr(Schema.Number),
  weeklyUsedPercent: Schema.NullOr(Schema.Number),
});

const HistoryDayRow = Schema.Struct({
  day: Schema.String,
  provider: Schema.String,
  peakSessionPercent: Schema.NullOr(Schema.Number),
  avgSessionPercent: Schema.NullOr(Schema.Number),
  peakWeeklyPercent: Schema.NullOr(Schema.Number),
  sampleCount: Schema.Number,
});

const TokenActivityRow = Schema.Struct({
  day: Schema.String,
  provider: Schema.String,
  tokens: Schema.Number,
});

const ModelTokenActivityRow = Schema.Struct({
  day: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  cacheWrite1hTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
  recordedCostUsd: Schema.NullOr(Schema.Number),
  isFast: Schema.Number,
  usesLongContext: Schema.Number,
});

/** Providers with a live rate-limit usage API (session/weekly percent). */
const RATE_LIMIT_PROVIDERS: ReadonlyArray<ProviderUsageProviderKind> = [
  "claude",
  "codex",
  "grok",
  "kilocode",
  "githubCopilot",
];
/** Providers whose per-message token usage is backfillable from local logs. */
const TOKEN_PROVIDERS: ReadonlyArray<ProviderTokenActivityKind> = [
  "claude",
  "codex",
  "grok",
  "opencode",
  "githubCopilot",
];

function isRateLimitProvider(provider: string): provider is ProviderUsageProviderKind {
  return (RATE_LIMIT_PROVIDERS as ReadonlyArray<string>).includes(provider);
}

function isTokenProvider(provider: string): provider is ProviderTokenActivityKind {
  return (TOKEN_PROVIDERS as ReadonlyArray<string>).includes(provider);
}

interface TokenSyncState {
  readonly running: boolean;
  readonly lastCompletedAt: number;
}

interface TokenLogSource {
  readonly provider: ProviderTokenActivityKind;
  readonly directory: string;
  /** File extension to enumerate (JSONL transcripts, JSON messages, or SQLite stores). */
  readonly extension: string;
  /**
   * "jsonl": append-only transcript, one entry per line, files grow — re-scan
   * on mtime/size change. "message-json": one immutable message per file —
   * once parsed a file never changes, so it's skipped on later scans.
   */
  readonly format: "jsonl" | "message-json" | "opencode-sqlite" | "github-copilot-jsonl";
  /** Optional exact filename matcher inside the source directory. */
  readonly accepts?: (filename: string) => boolean;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const syncState = yield* Ref.make<TokenSyncState>({ running: false, lastCompletedAt: 0 });

  const insertSample = SqlSchema.void({
    Request: HistorySample,
    execute: (row) =>
      sql`
        INSERT OR IGNORE INTO provider_usage_history (
          provider,
          sampled_at,
          session_used_percent,
          weekly_used_percent
        )
        VALUES (
          ${row.provider},
          ${row.sampledAt},
          ${row.sessionUsedPercent},
          ${row.weeklyUsedPercent}
        )
      `,
  });

  const listHistoryDays = SqlSchema.findAll({
    Request: Schema.Struct({ cutoffMs: Schema.Number }),
    Result: HistoryDayRow,
    execute: ({ cutoffMs }) =>
      sql`
        SELECT
          date(sampled_at / 1000, 'unixepoch', 'localtime') AS day,
          provider,
          MAX(session_used_percent) AS "peakSessionPercent",
          AVG(session_used_percent) AS "avgSessionPercent",
          MAX(weekly_used_percent) AS "peakWeeklyPercent",
          COUNT(*) AS "sampleCount"
        FROM provider_usage_history
        WHERE sampled_at >= ${cutoffMs}
        GROUP BY day, provider
        ORDER BY day ASC, provider ASC
      `,
  });

  const listTokenActivity = SqlSchema.findAll({
    Request: Schema.Struct({ cutoffMs: Schema.Number }),
    Result: TokenActivityRow,
    execute: ({ cutoffMs }) =>
      sql`
        SELECT
          provider,
          date(sampled_epoch_ms / 1000, 'unixepoch', 'localtime') AS day,
          SUM(tokens) AS tokens
        FROM provider_token_entries
        WHERE sampled_epoch_ms >= ${cutoffMs}
        GROUP BY provider, day
        ORDER BY day ASC, provider ASC
      `,
  });

  const listModelActivity = SqlSchema.findAll({
    Request: Schema.Struct({ cutoffMs: Schema.Number }),
    Result: ModelTokenActivityRow,
    execute: ({ cutoffMs }) =>
      sql`
        SELECT
          provider,
          CASE
            WHEN model IS NOT NULL AND model <> '' THEN model
            ELSE 'Unattributed'
          END AS model,
          date(sampled_epoch_ms / 1000, 'unixepoch', 'localtime') AS day,
          SUM(input_tokens) AS "inputTokens",
          SUM(cached_input_tokens) AS "cachedInputTokens",
          SUM(cache_write_tokens) AS "cacheWriteTokens",
          SUM(cache_write_1h_tokens) AS "cacheWrite1hTokens",
          SUM(output_tokens) AS "outputTokens",
          SUM(tokens) AS "totalTokens",
          CASE
            WHEN COUNT(recorded_cost_usd) > 0 THEN SUM(recorded_cost_usd)
            ELSE NULL
          END AS "recordedCostUsd",
          is_fast <> 0 AS "isFast",
          uses_long_context <> 0 AS "usesLongContext"
        FROM provider_token_entries
        WHERE sampled_epoch_ms >= ${cutoffMs}
          AND ((model IS NOT NULL AND model <> '') OR recorded_cost_usd IS NOT NULL)
        GROUP BY
          provider,
          CASE
            WHEN model IS NOT NULL AND model <> '' THEN model
            ELSE 'Unattributed'
          END,
          is_fast,
          uses_long_context,
          recorded_cost_usd IS NOT NULL,
          day
        ORDER BY
          day ASC,
          provider ASC,
          model ASC,
          is_fast ASC,
          uses_long_context ASC,
          recorded_cost_usd IS NOT NULL ASC
      `,
  });

  const record: ProviderUsageHistory["Service"]["record"] = (result) =>
    Effect.gen(function* () {
      const samples = result.usage.filter(
        (snapshot) =>
          snapshot.status === "ok" && (snapshot.session !== null || snapshot.weekly !== null),
      );
      if (samples.length === 0) {
        return;
      }
      for (const snapshot of samples) {
        yield* insertSample({
          provider: snapshot.provider,
          sampledAt: snapshot.updatedAt,
          sessionUsedPercent: snapshot.session?.usedPercent ?? null,
          weeklyUsedPercent: snapshot.weekly?.usedPercent ?? null,
        });
      }
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const retentionCutoffMs = nowMs - USAGE_HISTORY_RETENTION_DAYS * DAY_MS;
      yield* sql`DELETE FROM provider_usage_history WHERE sampled_at < ${retentionCutoffMs}`;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to record provider usage history", { cause }),
      ),
    );

  // ── Token-activity scan ──────────────────────────────────────────

  const resolveLogSources = (settings: ServerSettings) =>
    Effect.gen(function* () {
      const sources: TokenLogSource[] = [];
      const claude = defaultClaudeInstanceSettings(settings);
      if (claude.config.enabled) {
        const configDir = yield* resolveClaudeConfigDirPath(claude.config, claude.environment);
        sources.push({
          provider: "claude",
          directory: path.join(configDir, "projects"),
          extension: ".jsonl",
          format: "jsonl",
        });
      }
      if (settings.providers.codex.enabled) {
        const layout = yield* resolveCodexHomeLayout(settings.providers.codex);
        const homes = new Set([
          layout.sharedHomePath,
          layout.effectiveHomePath ?? layout.sharedHomePath,
        ]);
        for (const home of homes) {
          for (const directory of ["sessions", "archived_sessions"]) {
            sources.push({
              provider: "codex",
              directory: path.join(home, directory),
              extension: ".jsonl",
              format: "jsonl",
            });
          }
        }
      }
      if (settings.providers.grok.enabled) {
        const configuredHome = process.env.GROK_HOME?.trim();
        const grokHome =
          configuredHome && configuredHome.length > 0
            ? configuredHome
            : path.join(NodeOS.homedir(), ".grok");
        sources.push({
          provider: "grok",
          directory: path.join(grokHome, "logs"),
          extension: ".jsonl",
          format: "jsonl",
          accepts: (filename) => filename === "unified.jsonl",
        });
      }
      if (settings.providers.opencode.enabled) {
        const configuredData = process.env.OPENCODE_DATA_DIR?.trim();
        const xdgData = process.env.XDG_DATA_HOME?.trim();
        const opencodeData =
          configuredData && configuredData.length > 0
            ? configuredData
            : path.join(
                xdgData && xdgData.length > 0
                  ? xdgData
                  : path.join(NodeOS.homedir(), ".local", "share"),
                "opencode",
              );
        // Legacy OpenCode releases persisted one JSON object per message.
        sources.push({
          provider: "opencode",
          directory: path.join(opencodeData, "storage", "message"),
          extension: ".json",
          format: "message-json",
        });
        // Current releases persist messages in one database per release channel.
        sources.push({
          provider: "opencode",
          directory: opencodeData,
          extension: ".db",
          format: "opencode-sqlite",
          accepts: (filename) => /^opencode(?:-[^.]+)?\.db$/.test(filename),
        });
      }
      const copilotEnabled = Object.values(settings.providerInstances).some(
        (instance) => instance.driver === "githubCopilot" && instance.enabled !== false,
      );
      if (copilotEnabled || settings.providers.githubCopilot.enabled) {
        const configuredHome = settings.providers.githubCopilot.homePath.trim();
        const copilotHome =
          configuredHome.length > 0 ? configuredHome : path.join(NodeOS.homedir(), ".copilot");
        sources.push({
          provider: "githubCopilot",
          directory: path.join(copilotHome, "session-state"),
          extension: ".jsonl",
          format: "github-copilot-jsonl",
          accepts: (filename) => filename === "events.jsonl",
        });
      }
      return sources;
    }).pipe(Effect.provideService(Path.Path, path));

  const listSourceFiles = (source: TokenLogSource) =>
    fs.readDirectory(source.directory, { recursive: true }).pipe(
      Effect.map((entries) =>
        entries
          .filter(
            (entry) =>
              entry.endsWith(source.extension) &&
              (source.accepts === undefined || source.accepts(path.basename(entry))),
          )
          .map((entry) => path.join(source.directory, entry)),
      ),
      Effect.orElseSucceed((): Array<string> => []),
    );

  const parseSourceFile = (source: TokenLogSource, filePath: string, retentionCutoffMs: number) =>
    Effect.gen(function* () {
      const entries: ParsedTokenEntry[] = [];
      if (source.format === "message-json") {
        // One small immutable JSON object per file — read it whole.
        const content = yield* fs.readFileString(filePath);
        const parsed = parseOpenCodeMessageFile(content);
        if (parsed !== null) entries.push(parsed);
        return entries;
      }
      if (source.format === "opencode-sqlite") {
        const rows = yield* Effect.try({
          try: () => readOpenCodeUsageDatabase(filePath, retentionCutoffMs),
          catch: (cause) => new OpenCodeUsageDatabaseReadError({ filename: filePath, cause }),
        });
        for (const row of rows) {
          const parsed = parseOpenCodeMessageFile(row.data, {
            id: row.id,
            epochMs: row.timeCreated,
          });
          if (parsed !== null) entries.push(parsed);
        }
        return entries;
      }
      const codexState = source.provider === "codex" ? makeCodexParseState() : null;
      const grokState = source.provider === "grok" ? makeGrokParseState() : null;
      // Stream line-by-line so multi-megabyte transcripts never sit in
      // memory whole; only the (small) parsed entries are collected.
      yield* fs.stream(filePath).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
            if (source.provider === "claude") {
              entries.push(...parseClaudeTranscriptEntries(line));
            } else if (source.provider === "codex" && codexState !== null) {
              const parsed = parseCodexRolloutLineWithState(line, codexState);
              if (parsed !== null) entries.push(parsed);
            } else if (source.provider === "grok" && grokState !== null) {
              const parsed = parseGrokLogLine(line, grokState);
              if (parsed !== null) entries.push(parsed);
            } else if (source.format === "github-copilot-jsonl") {
              entries.push(...parseGitHubCopilotEventLine(line));
            }
          }),
        ),
      );
      return entries;
    });

  const scanFile = (source: TokenLogSource, filePath: string, retentionCutoffMs: number) =>
    Effect.gen(function* () {
      // Stat *before* reading: bytes appended while we read stay newer than
      // the recorded state, so the next scan re-parses them (INSERT OR
      // IGNORE absorbs the overlap) instead of skipping them forever.
      const info = yield* fs.stat(filePath);
      const mtimeMs = Option.match(info.mtime, {
        onNone: () => 0,
        onSome: (mtime) => mtime.getTime(),
      });
      const parsed = yield* parseSourceFile(source, filePath, retentionCutoffMs);
      const entries = parsed.filter((entry) => entry.epochMs >= retentionCutoffMs);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (source.provider === "codex") {
            const legacyPrefix = `${path.basename(filePath)}:`;
            const suffixStart = legacyPrefix.length + 1;
            yield* sql`
              DELETE FROM provider_token_entries
              WHERE provider = 'codex'
                AND substr(entry_key, 1, ${legacyPrefix.length}) = ${legacyPrefix}
                AND substr(entry_key, ${suffixStart}) <> ''
                AND substr(entry_key, ${suffixStart}) NOT GLOB '*[^0-9]*'
            `;
          }
          for (const entry of entries) {
            const entryProvider = entry.provider ?? source.provider;
            const claudeDedup = source.provider === "claude" ? entry.claudeDedup : undefined;
            if (claudeDedup?.isSidechain === true) {
              const requestPrefix = claudeRequestEntryPrefix(claudeDedup.groupKey);
              const legacyRequestKey = `${claudeDedup.groupKey}:${claudeDedup.requestId}`;
              const parents = yield* sql<{ readonly present: number }>`
                SELECT 1 AS present
                FROM provider_token_entries
                WHERE provider = 'claude'
                  AND (
                    substr(entry_key, 1, ${requestPrefix.length}) = ${requestPrefix}
                    OR entry_key = ${claudeDedup.groupKey}
                    OR entry_key = ${legacyRequestKey}
                  )
                LIMIT 1
              `;
              if (parents.length > 0) continue;
            } else if (claudeDedup !== undefined) {
              // A real parent always supersedes any sidechain replay for the
              // same logical message/advisor request, regardless of scan order.
              yield* sql`
                DELETE FROM provider_token_entries
                WHERE provider = 'claude'
                  AND entry_key = ${claudeSidechainEntryKey(claudeDedup.groupKey)}
              `;
            }
            yield* sql`
              INSERT INTO provider_token_entries (
                provider,
                entry_key,
                sampled_epoch_ms,
                tokens,
                model,
                input_tokens,
                cached_input_tokens,
                cache_write_tokens,
                cache_write_1h_tokens,
                output_tokens,
                recorded_cost_usd,
                is_fast,
                dedup_priority,
                uses_long_context
              )
              VALUES (
                ${entryProvider},
                ${entry.entryKey},
                ${entry.epochMs},
                ${entry.tokens},
                ${entry.model},
                ${entry.inputTokens},
                ${entry.cachedInputTokens},
                ${entry.cacheWriteTokens},
                ${entry.cacheWrite1hTokens},
                ${entry.outputTokens},
                ${entry.recordedCostUsd},
                ${entry.isFast ? 1 : 0},
                ${entry.dedupPriority},
                ${entry.usesLongContext ? 1 : 0}
              )
              ON CONFLICT (provider, entry_key) DO UPDATE SET
                sampled_epoch_ms = excluded.sampled_epoch_ms,
                tokens = excluded.tokens,
                model = excluded.model,
                input_tokens = excluded.input_tokens,
                cached_input_tokens = excluded.cached_input_tokens,
                cache_write_tokens = excluded.cache_write_tokens,
                cache_write_1h_tokens = excluded.cache_write_1h_tokens,
                output_tokens = excluded.output_tokens,
                recorded_cost_usd = COALESCE(
                  excluded.recorded_cost_usd,
                  provider_token_entries.recorded_cost_usd
                ),
                is_fast = excluded.is_fast,
                dedup_priority = excluded.dedup_priority,
                uses_long_context = excluded.uses_long_context
              WHERE excluded.dedup_priority >= provider_token_entries.dedup_priority
            `;
            if (claudeDedup !== undefined && !claudeDedup.isSidechain) {
              const legacyRequestKey = `${claudeDedup.groupKey}:${claudeDedup.requestId}`;
              yield* sql`
                DELETE FROM provider_token_entries
                WHERE provider = 'claude'
                  AND (
                    entry_key = ${claudeDedup.groupKey}
                    OR entry_key = ${legacyRequestKey}
                  )
              `;
            }
          }
          yield* sql`
            INSERT INTO provider_token_files (path, mtime_ms, size_bytes)
            VALUES (${filePath}, ${mtimeMs}, ${Number(info.size)})
            ON CONFLICT (path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes
          `;
        }),
      );
    });

  const syncOnce = (settings: ServerSettings, force: boolean) =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const retentionCutoffMs = nowMs - USAGE_HISTORY_RETENTION_DAYS * DAY_MS;
      const sources = yield* resolveLogSources(settings);

      const knownFiles = yield* sql<{
        readonly path: string;
        readonly mtime_ms: number;
        readonly size_bytes: number;
      }>`SELECT path, mtime_ms, size_bytes FROM provider_token_files`;
      const knownByPath = new Map(knownFiles.map((row) => [row.path, row]));

      const seenPaths = new Set<string>();
      let scannedCount = 0;
      for (const source of sources) {
        const files = yield* listSourceFiles(source);
        const changed: string[] = [];
        for (const filePath of files) {
          seenPaths.add(filePath);
          const known = knownByPath.get(filePath);
          const info = yield* fs.stat(filePath).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          const mtimeMs = Option.match(info.value.mtime, {
            onNone: () => 0,
            onSome: (mtime) => mtime.getTime(),
          });
          // OpenCode writes current messages through SQLite WAL. The main DB
          // fingerprint can remain unchanged until checkpoint, so query the
          // small set of DBs on every sync. A user-forced rescan likewise
          // bypasses fingerprints for every source.
          if (source.format === "opencode-sqlite") {
            changed.push(filePath);
            continue;
          }
          // A non-database file whose newest write predates the retention
          // window cannot contain in-window entries it has not contributed.
          if (mtimeMs < retentionCutoffMs) continue;
          if (
            !force &&
            known &&
            known.mtime_ms === mtimeMs &&
            known.size_bytes === Number(info.value.size)
          ) {
            continue;
          }
          changed.push(filePath);
        }
        yield* Effect.forEach(
          changed,
          (filePath) =>
            scanFile(source, filePath, retentionCutoffMs).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to scan provider token log", { filePath, cause }),
              ),
            ),
          { concurrency: TOKEN_SYNC_FILE_CONCURRENCY, discard: true },
        );
        scannedCount += changed.length;
      }

      // Drop scan state for deleted files. Their *entries* stay on purpose:
      // the CLIs prune old logs, but the usage those logs recorded still
      // happened — surviving that cleanup is the point of the backfill.
      for (const row of knownFiles) {
        if (!seenPaths.has(row.path)) {
          yield* sql`DELETE FROM provider_token_files WHERE path = ${row.path}`;
        }
      }
      yield* sql`DELETE FROM provider_token_entries WHERE sampled_epoch_ms < ${retentionCutoffMs}`;

      if (scannedCount > 0) {
        yield* Effect.log("Provider token activity scan finished", { scannedCount });
      }
    });

  /**
   * Kick a background scan unless one is running or ran very recently.
   * `force` swaps the passive throttle for a short one (never removes the
   * running check), so a double-fired rescan can't sweep the disk twice.
   */
  const ensureTokenActivitySync = (settings: ServerSettings, force: boolean) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const minIntervalMs = force ? TOKEN_SYNC_FORCE_MIN_INTERVAL_MS : TOKEN_SYNC_MIN_INTERVAL_MS;
        const claimed = yield* Ref.modify(syncState, (state) => {
          if (state.running || nowMs - state.lastCompletedAt < minIntervalMs) {
            return [false, state] as const;
          }
          return [true, { ...state, running: true }] as const;
        });
        if (!claimed) {
          return;
        }
        yield* syncOnce(settings, force).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider token activity scan failed", { cause }),
          ),
          Effect.onExit(() =>
            Effect.gen(function* () {
              const completedAt = DateTime.toEpochMillis(yield* DateTime.now);
              yield* Ref.set(syncState, { running: false, lastCompletedAt: completedAt });
            }),
          ),
          Effect.forkDetach({ startImmediately: true }),
        );
      }),
    );

  const readHistory: ProviderUsageHistory["Service"]["readHistory"] = (input, settings) =>
    Effect.gen(function* () {
      const windowDays = Math.min(
        USAGE_HISTORY_RETENTION_DAYS,
        Math.max(1, Math.floor(input.days)),
      );
      yield* ensureTokenActivitySync(settings, input.rescan === true);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      // Over-fetch by one day so the oldest requested *local* day is fully
      // covered regardless of where the ms cutoff lands within it.
      const cutoffMs = nowMs - (windowDays + 1) * DAY_MS;
      const [rows, tokenRows, modelRows, currentSync] = yield* Effect.all([
        listHistoryDays({ cutoffMs }),
        listTokenActivity({ cutoffMs }),
        listModelActivity({ cutoffMs }),
        Ref.get(syncState),
      ]);
      return {
        days: rows.flatMap((row) =>
          isRateLimitProvider(row.provider)
            ? [
                {
                  day: row.day,
                  provider: row.provider,
                  peakSessionPercent: row.peakSessionPercent,
                  avgSessionPercent: row.avgSessionPercent,
                  peakWeeklyPercent: row.peakWeeklyPercent,
                  sampleCount: row.sampleCount,
                },
              ]
            : [],
        ),
        tokenActivity: tokenRows.flatMap((row) =>
          isTokenProvider(row.provider)
            ? [{ day: row.day, provider: row.provider, tokens: row.tokens }]
            : [],
        ),
        modelActivity: modelRows.flatMap((row) =>
          isTokenProvider(row.provider)
            ? [
                {
                  day: row.day,
                  provider: row.provider,
                  model: row.model,
                  inputTokens: row.inputTokens,
                  cachedInputTokens: row.cachedInputTokens,
                  cacheWriteTokens: row.cacheWriteTokens,
                  cacheWrite1hTokens: row.cacheWrite1hTokens,
                  outputTokens: row.outputTokens,
                  totalTokens: row.totalTokens,
                  recordedCostUsd: row.recordedCostUsd,
                  isFast: row.isFast !== 0,
                  usesLongContext: row.usesLongContext !== 0,
                },
              ]
            : [],
        ),
        githubCopilotBilling: null,
        isBackfilling: currentSync.running,
        today: localDayKey(nowMs),
        lastScanAt: currentSync.lastCompletedAt > 0 ? currentSync.lastCompletedAt : null,
        retentionDays: USAGE_HISTORY_RETENTION_DAYS,
      } satisfies ServerProviderUsageHistoryResult;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Failed to read provider usage history", { cause });
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          return {
            days: [],
            tokenActivity: [],
            modelActivity: [],
            githubCopilotBilling: null,
            isBackfilling: false,
            today: localDayKey(nowMs),
            lastScanAt: null,
            retentionDays: USAGE_HISTORY_RETENTION_DAYS,
          } satisfies ServerProviderUsageHistoryResult;
        }),
      ),
    );

  return ProviderUsageHistory.of({ record, readHistory });
});

export const layer = Layer.effect(ProviderUsageHistory, make);
