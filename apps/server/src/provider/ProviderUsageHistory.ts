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
 *   `<home>/.claude/projects/**.jsonl`, Codex rollouts under
 *   `$CODEX_HOME/sessions/**.jsonl`, and OpenCode messages under
 *   `<xdg-data>/opencode/storage/message/**.json`, one message per file). A
 *   throttled background scan parses them into per-day token totals, which is
 *   what lets the heatmap show real usage from before zrode started sampling.
 *   The scan is incremental: append-only transcripts are re-parsed only when
 *   their mtime/size changes, immutable per-message files are parsed once, and
 *   entries carry stable keys so resumed/forked sessions that replay history
 *   dedupe via INSERT OR IGNORE. (Cursor and Grok keep no local token usage,
 *   so they have no backfill source.)
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

import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

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
  readonly entryKey: string;
  readonly epochMs: number;
  readonly tokens: number;
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
  if (!line.includes('"usage"')) return null;
  let record: {
    readonly type?: unknown;
    readonly timestamp?: unknown;
    readonly requestId?: unknown;
    readonly message?: {
      readonly id?: unknown;
      readonly usage?: {
        readonly input_tokens?: unknown;
        readonly output_tokens?: unknown;
        readonly cache_creation_input_tokens?: unknown;
        readonly cache_read_input_tokens?: unknown;
      } | null;
    } | null;
  };
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record.type !== "assistant") return null;
  const usage = record.message?.usage;
  const messageId = record.message?.id;
  if (!usage || typeof messageId !== "string" || messageId.length === 0) return null;
  const epochMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (!Number.isFinite(epochMs)) return null;
  const tokens =
    asFiniteNumber(usage.input_tokens) +
    asFiniteNumber(usage.output_tokens) +
    asFiniteNumber(usage.cache_creation_input_tokens) +
    asFiniteNumber(usage.cache_read_input_tokens);
  if (tokens <= 0) return null;
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  return { entryKey: `${messageId}:${requestId}`, epochMs, tokens };
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
): ParsedTokenEntry | null {
  if (!line.includes('"token_count"')) return null;
  let record: {
    readonly timestamp?: unknown;
    readonly payload?: {
      readonly type?: unknown;
      readonly info?: {
        readonly last_token_usage?: {
          readonly total_tokens?: unknown;
          readonly input_tokens?: unknown;
          readonly output_tokens?: unknown;
        } | null;
      } | null;
    } | null;
  };
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record.payload?.type !== "token_count") return null;
  const lastUsage = record.payload.info?.last_token_usage;
  if (!lastUsage) return null;
  const epochMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (!Number.isFinite(epochMs)) return null;
  const total = asFiniteNumber(lastUsage.total_tokens);
  const tokens =
    total > 0
      ? total
      : asFiniteNumber(lastUsage.input_tokens) + asFiniteNumber(lastUsage.output_tokens);
  if (tokens <= 0) return null;
  return { entryKey: `${entryKeyPrefix}:${lineNumber}`, epochMs, tokens };
}

/**
 * Parse one OpenCode message file. OpenCode stores each message as its own
 * JSON object under `<data>/storage/message/<sessionId>/<messageId>.json`;
 * assistant messages carry `tokens{input,output,reasoning,cache{read,write}}`
 * and a completion time. Keyed by the message id, which is globally unique and
 * stable, so re-scanning a file is idempotent.
 */
export function parseOpenCodeMessageFile(content: string): ParsedTokenEntry | null {
  let record: {
    readonly id?: unknown;
    readonly role?: unknown;
    readonly time?: { readonly created?: unknown; readonly completed?: unknown } | null;
    readonly tokens?: {
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
  const id = record.id;
  const usage = record.tokens;
  if (!usage || typeof id !== "string" || id.length === 0) return null;
  // `completed` is set once the assistant turn finishes; fall back to
  // `created` for a turn still in flight when the scan runs.
  const epochMs = asFiniteNumber(record.time?.completed) || asFiniteNumber(record.time?.created);
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  const tokens =
    asFiniteNumber(usage.input) +
    asFiniteNumber(usage.output) +
    asFiniteNumber(usage.reasoning) +
    asFiniteNumber(usage.cache?.read) +
    asFiniteNumber(usage.cache?.write);
  if (tokens <= 0) return null;
  return { entryKey: id, epochMs, tokens };
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

/** Providers with a live rate-limit usage API (session/weekly percent). */
const RATE_LIMIT_PROVIDERS: ReadonlyArray<ProviderUsageProviderKind> = ["claude", "codex"];
/** Providers whose per-message token usage is backfillable from local logs. */
const TOKEN_PROVIDERS: ReadonlyArray<ProviderTokenActivityKind> = ["claude", "codex", "opencode"];

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
  /** File extension to enumerate (".jsonl" transcripts vs ".json" messages). */
  readonly extension: string;
  /**
   * "jsonl": append-only transcript, one entry per line, files grow — re-scan
   * on mtime/size change. "message-json": one immutable message per file —
   * once parsed a file never changes, so it's skipped on later scans.
   */
  readonly format: "jsonl" | "message-json";
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
      if (settings.providers.claudeAgent.enabled) {
        const home = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
        sources.push({
          provider: "claude",
          directory: path.join(home, ".claude", "projects"),
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
          sources.push({
            provider: "codex",
            directory: path.join(home, "sessions"),
            extension: ".jsonl",
            format: "jsonl",
          });
        }
      }
      if (settings.providers.opencode.enabled) {
        // OpenCode keeps its message store in the XDG data dir (the same on
        // macOS and Linux); each assistant message is its own JSON file.
        const xdgData = process.env.XDG_DATA_HOME?.trim();
        const dataHome =
          xdgData && xdgData.length > 0 ? xdgData : path.join(NodeOS.homedir(), ".local", "share");
        sources.push({
          provider: "opencode",
          directory: path.join(dataHome, "opencode", "storage", "message"),
          extension: ".json",
          format: "message-json",
        });
      }
      return sources;
    }).pipe(Effect.provideService(Path.Path, path));

  const listSourceFiles = (source: TokenLogSource) =>
    fs.readDirectory(source.directory, { recursive: true }).pipe(
      Effect.map((entries) =>
        entries
          .filter((entry) => entry.endsWith(source.extension))
          .map((entry) => path.join(source.directory, entry)),
      ),
      Effect.orElseSucceed((): Array<string> => []),
    );

  const parseSourceFile = (source: TokenLogSource, filePath: string) =>
    Effect.gen(function* () {
      const entries: ParsedTokenEntry[] = [];
      if (source.format === "message-json") {
        // One small immutable JSON object per file — read it whole.
        const content = yield* fs.readFileString(filePath);
        const parsed = parseOpenCodeMessageFile(content);
        if (parsed !== null) entries.push(parsed);
        return entries;
      }
      const fileName = path.basename(filePath);
      let lineNumber = 0;
      // Stream line-by-line so multi-megabyte transcripts never sit in
      // memory whole; only the (small) parsed entries are collected.
      yield* fs.stream(filePath).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
            lineNumber += 1;
            const parsed =
              source.provider === "claude"
                ? parseClaudeTranscriptLine(line)
                : parseCodexRolloutLine(line, fileName, lineNumber);
            if (parsed !== null) entries.push(parsed);
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
      const parsed = yield* parseSourceFile(source, filePath);
      const entries = parsed.filter((entry) => entry.epochMs >= retentionCutoffMs);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const entry of entries) {
            yield* sql`
              INSERT OR IGNORE INTO provider_token_entries (provider, entry_key, sampled_epoch_ms, tokens)
              VALUES (${source.provider}, ${entry.entryKey}, ${entry.epochMs}, ${entry.tokens})
            `;
          }
          yield* sql`
            INSERT INTO provider_token_files (path, mtime_ms, size_bytes)
            VALUES (${filePath}, ${mtimeMs}, ${Number(info.size)})
            ON CONFLICT (path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes
          `;
        }),
      );
    });

  const syncOnce = (settings: ServerSettings) =>
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
          // Message-json files are immutable once written: if we've already
          // recorded this path, it can never change, so skip it without even
          // stat-ing — this keeps OpenCode's thousands of files cheap to scan.
          const known = knownByPath.get(filePath);
          if (source.format === "message-json" && known) continue;
          const info = yield* fs.stat(filePath).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          const mtimeMs = Option.match(info.value.mtime, {
            onNone: () => 0,
            onSome: (mtime) => mtime.getTime(),
          });
          // A file whose newest write predates the retention window cannot
          // contain in-window entries it hasn't already contributed.
          if (mtimeMs < retentionCutoffMs) continue;
          if (known && known.mtime_ms === mtimeMs && known.size_bytes === Number(info.value.size)) {
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
      yield* syncOnce(settings).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Provider token activity scan failed", { cause }),
        ),
        Effect.onExit(() =>
          Effect.gen(function* () {
            const completedAt = DateTime.toEpochMillis(yield* DateTime.now);
            yield* Ref.set(syncState, { running: false, lastCompletedAt: completedAt });
          }),
        ),
        Effect.forkDetach,
      );
    });

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
      const [rows, tokenRows, currentSync] = yield* Effect.all([
        listHistoryDays({ cutoffMs }),
        listTokenActivity({ cutoffMs }),
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
