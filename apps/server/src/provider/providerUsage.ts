/**
 * Provider subscription usage (rate-limit windows).
 *
 * Fetches how much of the session (~5h) and weekly (~7d) rate-limit windows
 * remain for the locally-authenticated Claude Code and Codex accounts:
 *
 * - Claude: `GET https://api.anthropic.com/api/oauth/usage` using the OAuth
 *   access token Claude Code stores in `~/.claude/.credentials.json` (or the
 *   macOS keychain entry "Claude Code-credentials"). The response's `limits`
 *   array carries the session window, the all-models weekly window, and any
 *   model-scoped weekly windows; `extra_usage` carries overflow credits.
 * - Codex: a short-lived `codex app-server` probe answering the
 *   `account/rateLimits/read` JSON-RPC request — the same channel the Codex
 *   CLI itself uses — plus the ChatGPT backend's rate-limit reset-credit
 *   endpoints (the "Reset now" feature) authenticated via
 *   `$CODEX_HOME/auth.json`.
 *
 * Results are cached in module state with a short TTL and coalesced across
 * concurrent callers, so any number of connected clients polling the usage
 * RPC trigger at most one probe (one codex spawn, one keychain read, one
 * HTTP round-trip per endpoint) per TTL window.
 *
 * Usage currently targets the legacy singleton provider settings
 * (`settings.providers.codex` / `settings.providers.claudeAgent`); custom
 * `providerInstances` with separate accounts are not yet reflected here.
 *
 * Per-provider failures never fail the RPC; they fold into the snapshot's
 * `status`/`message` so the client can render partial results.
 *
 * @module providerUsage
 */
import type {
  ClaudeSettings,
  CodexSettings,
  ProviderUsageExtraLimit,
  ProviderUsageProviderKind,
  ProviderUsageResetCredits,
  ProviderUsageSnapshot,
  ProviderUsageStatus,
  ProviderUsageWindow,
  ServerConsumeCodexResetCreditResult,
  ServerProviderUsageResult,
  ServerSettings,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import * as ProcessRunner from "../processRunner.ts";
import { AUTH_PROBE_TIMEOUT_MS } from "./providerSnapshot.ts";
import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { buildCodexInitializeParams, codexAccountAuthLabel } from "./Layers/CodexProvider.ts";

export const SESSION_WINDOW_MINUTES = 300;
export const WEEKLY_WINDOW_MINUTES = 10_080;

const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.0";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_HTTP_TIMEOUT_MS = 10_000;
const CODEX_APP_SERVER_USAGE_FORCE_KILL_AFTER = "2 seconds" as const;
const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_RESET_CREDITS_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`;
const CODEX_RESET_CREDITS_TIMEOUT_MS = 3_000;
const CLAUDE_USAGE_RATE_LIMIT_MESSAGE =
  "Rate limited by the Claude usage API — data will refresh automatically in a few minutes.";

/** How long a fetched usage snapshot stays fresh for all connected clients. */
const USAGE_CACHE_TTL_MS = 60_000;
/** Fallback backoff when a provider 429 omits Retry-After. */
const USAGE_CACHE_RATE_LIMIT_DEFAULT_TTL_MS = 5 * 60_000;
/** Any 429 should suppress immediate retries, even if Retry-After is tiny. */
const USAGE_CACHE_RATE_LIMIT_MIN_TTL_MS = 60_000;
/** Cap vendor backoff hints so stale UI can eventually self-heal. */
const USAGE_CACHE_RATE_LIMIT_MAX_TTL_MS = 30 * 60_000;
/** How long a successfully-read Claude token is reused before re-reading. */
const CLAUDE_TOKEN_CACHE_TTL_MS = 15 * 60_000;
/** How long "no credentials found" is trusted before re-probing keychain/file. */
const CLAUDE_TOKEN_NEGATIVE_TTL_MS = 2 * 60_000;
/** Minimum spacing between reset-credit consumes (each spends a real credit). */
const CONSUME_RESET_COOLDOWN_MS = 30_000;

const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);

function usageSnapshot(
  provider: ProviderUsageProviderKind,
  status: ProviderUsageStatus,
  message: string | null,
  updatedAt: number,
): ProviderUsageSnapshot {
  return {
    provider,
    status,
    session: null,
    weekly: null,
    extraLimits: [],
    planLabel: null,
    extraUsage: null,
    credits: null,
    resetCredits: null,
    message,
    updatedAt,
  };
}

/** Normalize a reset timestamp that may arrive as ISO string, unix seconds, or epoch ms. */
export function normalizeResetsAt(raw: unknown): number | null {
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Make extra-limit labels unique (clients key rows by label) by suffixing
 * repeats with a counter: "Spark", "Spark (2)", …
 */
function uniquifyLimitLabel(label: string, seen: Map<string, number>): string {
  const count = (seen.get(label) ?? 0) + 1;
  seen.set(label, count);
  return count === 1 ? label : `${label} (${count})`;
}

/**
 * Execute an HTTP request and read its JSON body inside one shared timeout,
 * folding transport errors, timeouts, and body failures into `null` payloads
 * so callers can branch purely on `{ status, payload }`.
 */
export function parseRetryAfterMs(raw: string | undefined, nowMs: number): number | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

function rateLimitTtlMs(retryAfterMs: number | null): number {
  return Math.min(
    USAGE_CACHE_RATE_LIMIT_MAX_TTL_MS,
    Math.max(
      USAGE_CACHE_RATE_LIMIT_MIN_TTL_MS,
      retryAfterMs ?? USAGE_CACHE_RATE_LIMIT_DEFAULT_TTL_MS,
    ),
  );
}

const fetchJsonWithTimeout = Effect.fn("fetchJsonWithTimeout")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(request).pipe(
    Effect.flatMap(
      (
        response: HttpClientResponse.HttpClientResponse,
      ): Effect.Effect<{
        readonly status: number;
        readonly payload: unknown;
        readonly retryAfterMs: number | null;
      }> =>
        Effect.gen(function* () {
          const receivedAt = DateTime.toEpochMillis(yield* DateTime.now);
          const retryAfterMs = parseRetryAfterMs(response.headers["retry-after"], receivedAt);
          const readResponse =
            response.status >= 200 && response.status < 300
              ? response.json.pipe(
                  Effect.map((payload) => ({ status: response.status, payload, retryAfterMs })),
                  Effect.orElseSucceed(() => ({
                    status: response.status,
                    payload: null,
                    retryAfterMs,
                  })),
                )
              : // Drain non-2xx bodies so the socket is released promptly instead
                // of waiting for the response object to be garbage-collected.
                response.text.pipe(
                  Effect.orElseSucceed(() => ""),
                  Effect.map(() => ({ status: response.status, payload: null, retryAfterMs })),
                );
          return yield* readResponse;
        }),
    ),
    Effect.timeoutOption(Duration.millis(USAGE_HTTP_TIMEOUT_MS)),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
});

// ── Shared usage cache ───────────────────────────────────────────────
//
// Module state shared by every WS connection's RPC handler layer. Multiple
// clients polling concurrently coalesce onto one probe: a fresh cache entry
// short-circuits, and while a fetch is in flight callers holding a stale
// entry are served that entry instead of spawning their own probe.

interface ProviderUsageCacheState {
  readonly key: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly snapshot: ProviderUsageSnapshot;
  readonly lastOkSnapshot: ProviderUsageSnapshot | null;
}

interface ProviderUsageInFlightState {
  readonly key: string;
  readonly generation: number;
  readonly deferred: Deferred.Deferred<ProviderUsageSnapshot>;
}

interface ProviderUsageFetchResult {
  readonly snapshot: ProviderUsageSnapshot;
  /**
   * Backoff requested by the provider's primary usage source. A failed
   * primary request may reuse the last good snapshot while this is active.
   */
  readonly mainBackoffTtlMs: number | null;
  /**
   * Backoff requested by secondary enrichment sources such as Codex reset
   * credits. This slows future enrichment reads but must not hide primary
   * usage failures.
   */
  readonly auxiliaryBackoffTtlMs: number | null;
}

let usageCache = new Map<ProviderUsageProviderKind, ProviderUsageCacheState>();
let usageInFlight = new Map<ProviderUsageProviderKind, ProviderUsageInFlightState>();
let usageGeneration = new Map<ProviderUsageProviderKind, number>();

const PROVIDER_USAGE_KINDS = [
  "claude",
  "codex",
] as const satisfies ReadonlyArray<ProviderUsageProviderKind>;

function providerUsageFetchResult(
  snapshot: ProviderUsageSnapshot,
  options: {
    readonly mainBackoffTtlMs?: number | null;
    readonly auxiliaryBackoffTtlMs?: number | null;
  } = {},
): ProviderUsageFetchResult {
  return {
    snapshot,
    mainBackoffTtlMs: options.mainBackoffTtlMs ?? null,
    auxiliaryBackoffTtlMs: options.auxiliaryBackoffTtlMs ?? null,
  };
}

function providerUsageGeneration(provider: ProviderUsageProviderKind): number {
  return usageGeneration.get(provider) ?? 0;
}

function bumpProviderUsageGeneration(provider: ProviderUsageProviderKind): void {
  usageGeneration.set(provider, providerUsageGeneration(provider) + 1);
}

export function invalidateProviderUsageCache(provider?: ProviderUsageProviderKind): void {
  if (provider !== undefined) {
    usageCache.delete(provider);
    usageInFlight.delete(provider);
    bumpProviderUsageGeneration(provider);
    return;
  }
  usageCache = new Map();
  usageInFlight = new Map();
  for (const kind of PROVIDER_USAGE_KINDS) {
    bumpProviderUsageGeneration(kind);
  }
}

export function usageSettingsKey(settings: ServerSettings): string {
  return JSON.stringify([
    claudeUsageSettingsKey(settings.providers.claudeAgent),
    codexUsageSettingsKey(settings.providers.codex),
  ]);
}

function claudeUsageSettingsKey(settings: ClaudeSettings): string {
  return JSON.stringify([settings.enabled, settings.homePath]);
}

function codexUsageSettingsKey(settings: CodexSettings): string {
  return JSON.stringify([
    settings.enabled,
    settings.binaryPath,
    settings.homePath,
    settings.shadowHomePath,
  ]);
}

export function providerUsageSettingsKey(
  provider: ProviderUsageProviderKind,
  settings: ServerSettings,
): string {
  return provider === "claude"
    ? claudeUsageSettingsKey(settings.providers.claudeAgent)
    : codexUsageSettingsKey(settings.providers.codex);
}

// ── Claude ───────────────────────────────────────────────────────────

interface ClaudeUsageWindowPayload {
  readonly utilization?: unknown;
  readonly resets_at?: unknown;
}

interface ClaudeLimitPayload {
  readonly kind?: unknown;
  readonly group?: unknown;
  readonly percent?: unknown;
  readonly resets_at?: unknown;
  readonly scope?: {
    readonly model?: { readonly display_name?: unknown } | null;
    readonly surface?: unknown;
  } | null;
}

interface ClaudeUsagePayload {
  readonly five_hour?: ClaudeUsageWindowPayload | null;
  readonly seven_day?: ClaudeUsageWindowPayload | null;
  readonly limits?: ReadonlyArray<ClaudeLimitPayload> | null;
  readonly extra_usage?: {
    readonly is_enabled?: unknown;
    readonly utilization?: unknown;
  } | null;
}

export interface ClaudeOAuthCredentials {
  readonly accessToken: string;
  /** Epoch milliseconds, when the credentials blob reports an expiry. */
  readonly expiresAt: number | null;
}

export function parseClaudeOAuthCredentials(raw: string): ClaudeOAuthCredentials | null {
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || token.length === 0) {
      return null;
    }
    const expiresAt = parsed.claudeAiOauth?.expiresAt;
    return {
      accessToken: token,
      expiresAt:
        typeof expiresAt === "number" && Number.isFinite(expiresAt)
          ? normalizeResetsAt(expiresAt)
          : null,
    };
  } catch {
    return null;
  }
}

function mapClaudeWindow(
  raw: ClaudeUsageWindowPayload | null | undefined,
  windowMinutes: number,
): ProviderUsageWindow | null {
  if (!raw || typeof raw.utilization !== "number") {
    return null;
  }
  return {
    usedPercent: clampPercent(raw.utilization),
    windowMinutes,
    resetsAt: normalizeResetsAt(raw.resets_at),
  };
}

function mapClaudeLimitWindow(limit: ClaudeLimitPayload, windowMinutes: number | null) {
  if (typeof limit.percent !== "number") {
    return null;
  }
  return {
    usedPercent: clampPercent(limit.percent),
    windowMinutes,
    resetsAt: normalizeResetsAt(limit.resets_at),
  } satisfies ProviderUsageWindow;
}

function humanizeClaudeLimitKind(kind: string): string {
  const words = kind.split(/[\s_-]+/g).filter((word) => word.length > 0);
  return words
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
    .replace(/^Weekly Scoped$/, "Weekly");
}

/**
 * Project the `limits` array (the same source Claude Code's `/usage` screen
 * renders) into the session window, the all-models weekly window, and any
 * scoped extra limits (e.g. a per-model weekly cap).
 */
export function parseClaudeLimits(usage: ClaudeUsagePayload): {
  readonly session: ProviderUsageWindow | null;
  readonly weekly: ProviderUsageWindow | null;
  readonly extraLimits: ReadonlyArray<ProviderUsageExtraLimit>;
} {
  let session: ProviderUsageWindow | null = null;
  let weekly: ProviderUsageWindow | null = null;
  const extraLimits: Array<ProviderUsageExtraLimit> = [];
  const seenLabels = new Map<string, number>();

  // Defensive: the payload is an unvalidated vendor response — a non-array
  // `limits` or null entries must degrade, not crash the fetch.
  const rawLimits = Array.isArray(usage.limits) ? usage.limits : [];
  for (const limit of rawLimits) {
    if (limit === null || typeof limit !== "object" || typeof limit.kind !== "string") {
      continue;
    }
    if (limit.kind === "session") {
      session ??= mapClaudeLimitWindow(limit, SESSION_WINDOW_MINUTES);
      continue;
    }
    if (limit.kind === "weekly_all") {
      weekly ??= mapClaudeLimitWindow(limit, WEEKLY_WINDOW_MINUTES);
      continue;
    }
    const isWeekly = limit.group === "weekly";
    const window = mapClaudeLimitWindow(limit, isWeekly ? WEEKLY_WINDOW_MINUTES : null);
    if (!window) {
      continue;
    }
    const modelName = limit.scope?.model?.display_name;
    const label =
      typeof modelName === "string" && modelName.length > 0
        ? modelName
        : humanizeClaudeLimitKind(limit.kind);
    extraLimits.push({
      label: uniquifyLimitLabel(label, seenLabels),
      session: isWeekly ? null : window,
      weekly: isWeekly ? window : null,
    });
  }

  return {
    session: session ?? mapClaudeWindow(usage.five_hour, SESSION_WINDOW_MINUTES),
    weekly: weekly ?? mapClaudeWindow(usage.seven_day, WEEKLY_WINDOW_MINUTES),
    extraLimits,
  };
}

interface ClaudeTokenCacheState {
  readonly home: string;
  readonly fileFingerprint: string | null;
  readonly credentials: ClaudeOAuthCredentials | null;
  readonly expiresAt: number;
}

let claudeTokenCache: ClaudeTokenCacheState | null = null;

/**
 * The API rejected the cached token (401/403). Mark it expired but KEEP the
 * cache entry with the short negative TTL: dropping it entirely would make
 * every poll re-read the credentials file/keychain for as long as the user
 * stays signed out — exactly the prompt-spam the cache exists to prevent.
 */
function markClaudeCredentialsRejected(rejectedAt: number): void {
  const cached = claudeTokenCache;
  if (cached === null || cached.credentials === null) {
    return;
  }
  claudeTokenCache = {
    home: cached.home,
    fileFingerprint: cached.fileFingerprint,
    credentials: { ...cached.credentials, expiresAt: rejectedAt - 1 },
    expiresAt: rejectedAt + CLAUDE_TOKEN_NEGATIVE_TTL_MS,
  };
}

const claudeCredentialsFileFingerprint = Effect.fn("claudeCredentialsFileFingerprint")(function* (
  fileSystem: FileSystem.FileSystem,
  credentialsPath: string,
) {
  return yield* fileSystem.stat(credentialsPath).pipe(
    Effect.map((info) => {
      const mtimeMs = Option.match(info.mtime, {
        onNone: () => 0,
        onSome: (mtime) => mtime.getTime(),
      });
      return `${info.size}:${mtimeMs}`;
    }),
    Effect.orElseSucceed(() => null),
  );
});

/**
 * Resolve the Claude Code OAuth credentials: the credentials file inside the
 * instance's HOME first, then the macOS keychain entry Claude Code writes to
 * by default when no credentials file exists. Cached so the keychain (which
 * may prompt the user) is touched at most once per TTL, not on every poll.
 */
const readClaudeCredentials = Effect.fn("readClaudeCredentials")(function* (
  settings: ClaudeSettings,
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const home = yield* resolveClaudeHomePath(settings);
  const fileSystem = yield* FileSystem.FileSystem;
  const credentialsPath = `${home}/.claude/.credentials.json`;
  const fileFingerprint = yield* claudeCredentialsFileFingerprint(fileSystem, credentialsPath);
  const cached = claudeTokenCache;
  if (
    cached &&
    cached.home === home &&
    cached.fileFingerprint === fileFingerprint &&
    cached.expiresAt > now
  ) {
    return cached.credentials;
  }

  let credentials = yield* fileSystem.readFileString(credentialsPath).pipe(
    Effect.map(parseClaudeOAuthCredentials),
    Effect.orElseSucceed(() => null),
  );

  if (credentials === null) {
    const platform = yield* HostProcessPlatform;
    if (platform === "darwin") {
      const processRunner = yield* ProcessRunner.ProcessRunner;
      const keychainOutput = yield* processRunner
        .run({
          command: "security",
          args: ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
          timeout: "5 seconds",
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (keychainOutput !== null && keychainOutput.code === 0) {
        credentials = parseClaudeOAuthCredentials(keychainOutput.stdout.trim());
      }
    }
  }

  // Credentials that are missing or already expired are re-probed on the
  // short negative TTL (the user may sign in / refresh at any moment);
  // plausibly-valid tokens are trusted for the long TTL.
  const looksValid =
    credentials !== null && (credentials.expiresAt === null || credentials.expiresAt > now);
  claudeTokenCache = {
    home,
    fileFingerprint,
    credentials,
    expiresAt: now + (looksValid ? CLAUDE_TOKEN_CACHE_TTL_MS : CLAUDE_TOKEN_NEGATIVE_TTL_MS),
  };
  return credentials;
});

const fetchClaudeUsageResult = Effect.fn("fetchClaudeUsageResult")(function* (
  settings: ClaudeSettings,
) {
  const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
  if (!settings.enabled) {
    return providerUsageFetchResult(
      usageSnapshot("claude", "unavailable", "Claude is disabled in Zrode settings.", startedAt),
    );
  }
  const credentials = yield* readClaudeCredentials(settings);
  if (!credentials) {
    return providerUsageFetchResult(
      usageSnapshot(
        "claude",
        "unauthenticated",
        "No Claude Code credentials found. Sign in with the Claude CLI first.",
        startedAt,
      ),
    );
  }
  if (credentials.expiresAt !== null && credentials.expiresAt <= startedAt) {
    return providerUsageFetchResult(
      usageSnapshot(
        "claude",
        "unauthenticated",
        "The Claude Code token has expired — run the Claude CLI once to refresh it.",
        startedAt,
      ),
    );
  }
  const request = HttpClientRequest.get(CLAUDE_OAUTH_USAGE_URL).pipe(
    HttpClientRequest.setHeaders({
      Authorization: `Bearer ${credentials.accessToken}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      "User-Agent": CLAUDE_CODE_USER_AGENT,
    }),
  );
  const response = yield* fetchJsonWithTimeout(request);
  const updatedAt = DateTime.toEpochMillis(yield* DateTime.now);
  if (response === null) {
    return providerUsageFetchResult(
      usageSnapshot("claude", "error", "Failed to reach the Claude usage API.", updatedAt),
    );
  }
  if (response.status === 401 || response.status === 403) {
    markClaudeCredentialsRejected(updatedAt);
    return providerUsageFetchResult(
      usageSnapshot(
        "claude",
        "unauthenticated",
        "The Claude Code token has expired — run the Claude CLI once to refresh it.",
        updatedAt,
      ),
    );
  }
  if (response.status === 429 || (response.status === 503 && response.retryAfterMs !== null)) {
    const message =
      response.status === 429
        ? CLAUDE_USAGE_RATE_LIMIT_MESSAGE
        : "Claude usage API is temporarily unavailable — data will refresh automatically.";
    return providerUsageFetchResult(usageSnapshot("claude", "error", message, updatedAt), {
      mainBackoffTtlMs: rateLimitTtlMs(response.retryAfterMs),
    });
  }
  if (response.payload === null || typeof response.payload !== "object") {
    return providerUsageFetchResult(
      usageSnapshot(
        "claude",
        "error",
        `Claude usage API returned an unexpected response (HTTP ${response.status}).`,
        updatedAt,
      ),
    );
  }
  const usage = response.payload as ClaudeUsagePayload;
  const limits = parseClaudeLimits(usage);
  const extraUsage = usage.extra_usage
    ? {
        enabled: usage.extra_usage.is_enabled === true,
        utilization:
          typeof usage.extra_usage.utilization === "number"
            ? clampPercent(usage.extra_usage.utilization)
            : null,
      }
    : null;
  return providerUsageFetchResult({
    provider: "claude",
    status: "ok",
    session: limits.session,
    weekly: limits.weekly,
    extraLimits: limits.extraLimits,
    planLabel: null,
    extraUsage,
    credits: null,
    resetCredits: null,
    message: null,
    updatedAt,
  } satisfies ProviderUsageSnapshot);
});

export const fetchClaudeUsage = Effect.fn("fetchClaudeUsage")(function* (settings: ClaudeSettings) {
  return (yield* fetchClaudeUsageResult(settings)).snapshot;
});

// ── Codex ────────────────────────────────────────────────────────────

/** Auth lives in the shadow home when configured; matches session resolution. */
const resolveCodexAuthHomePath = Effect.fn("resolveCodexAuthHomePath")(function* (
  settings: CodexSettings,
) {
  const layout = yield* resolveCodexHomeLayout(settings);
  return layout.effectiveHomePath ?? layout.sharedHomePath;
});

function mapCodexWindow(
  raw: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
  fallbackWindowMinutes: number,
): ProviderUsageWindow | null {
  if (!raw || typeof raw.usedPercent !== "number") {
    return null;
  }
  return {
    usedPercent: clampPercent(raw.usedPercent),
    windowMinutes: raw.windowDurationMins ?? fallbackWindowMinutes,
    resetsAt: normalizeResetsAt(raw.resetsAt),
  };
}

export function mapCodexExtraLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
): ReadonlyArray<ProviderUsageExtraLimit> {
  const defaultLimitId = response.rateLimits.limitId ?? "codex";
  const buckets = response.rateLimitsByLimitId ?? {};
  const extraLimits: Array<ProviderUsageExtraLimit> = [];
  const seenLabels = new Map<string, number>();
  for (const [limitId, bucket] of Object.entries(buckets)) {
    if (limitId === defaultLimitId) {
      continue;
    }
    const session = mapCodexWindow(bucket.primary, SESSION_WINDOW_MINUTES);
    const weekly = mapCodexWindow(bucket.secondary, WEEKLY_WINDOW_MINUTES);
    if (!session && !weekly) {
      continue;
    }
    extraLimits.push({
      label: uniquifyLimitLabel(bucket.limitName ?? limitId, seenLabels),
      session,
      weekly,
    });
  }
  return extraLimits;
}

interface CodexBackendAuth {
  readonly accessToken: string;
  readonly accountId: string | null;
}

export function parseCodexBackendAuth(raw: string): CodexBackendAuth | null {
  try {
    const parsed = JSON.parse(raw) as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    const accessToken = parsed.tokens?.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return null;
    }
    const accountId = parsed.tokens?.account_id;
    return {
      accessToken,
      accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : null,
    };
  } catch {
    return null;
  }
}

/** Read the ChatGPT backend bearer token from `$CODEX_HOME/auth.json`. */
const readCodexBackendAuth = Effect.fn("readCodexBackendAuth")(function* (settings: CodexSettings) {
  const fileSystem = yield* FileSystem.FileSystem;
  const authHome = yield* resolveCodexAuthHomePath(settings);
  return yield* fileSystem.readFileString(`${authHome}/auth.json`).pipe(
    Effect.map(parseCodexBackendAuth),
    Effect.orElseSucceed(() => null),
  );
});

function codexBackendHeaders(auth: CodexBackendAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "User-Agent": "codex-cli",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
    ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
  };
}

interface CodexResetCreditPayload {
  readonly status?: unknown;
  readonly expires_at?: unknown;
}

export function parseCodexResetCredits(payload: unknown): ProviderUsageResetCredits | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const credits = (payload as { credits?: ReadonlyArray<CodexResetCreditPayload> | null }).credits;
  if (!Array.isArray(credits)) {
    return null;
  }
  const available = credits.filter(
    (credit): credit is CodexResetCreditPayload =>
      credit !== null && typeof credit === "object" && credit.status === "available",
  );
  const expirations = available
    .map((credit) => normalizeResetsAt(credit.expires_at))
    .filter((value): value is number => value !== null);
  return {
    availableCount: available.length,
    totalEarnedCount: credits.length,
    nextExpiresAt: expirations.length > 0 ? Math.min(...expirations) : null,
  };
}

/**
 * Fetch the account's rate-limit reset credits ("Full reset (Weekly + 5 hr)"
 * grants) from the ChatGPT backend. Best-effort, but failure modes stay
 * explicit so consume preflight and usage enrichment can make different calls.
 */
interface CodexResetCreditsFetchResult {
  readonly status: "ok" | "unauthenticated" | "rate-limited" | "error";
  readonly credits: ProviderUsageResetCredits | null;
  readonly rateLimitTtlMs: number | null;
}

let codexResetCreditsBackoffUntil = new Map<string, number>();

function setCodexResetCreditsBackoff(
  key: string,
  now: number,
  retryAfterMs: number | null,
): number {
  const ttlMs = rateLimitTtlMs(retryAfterMs);
  codexResetCreditsBackoffUntil.set(key, now + ttlMs);
  return ttlMs;
}

const fetchCodexResetCreditsResult = Effect.fn("fetchCodexResetCreditsResult")(function* (
  settings: CodexSettings,
) {
  const key = codexUsageSettingsKey(settings);
  const auth = yield* readCodexBackendAuth(settings);
  if (auth === null) {
    codexResetCreditsBackoffUntil.delete(key);
    return {
      status: "unauthenticated",
      credits: null,
      rateLimitTtlMs: null,
    } satisfies CodexResetCreditsFetchResult;
  }
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const backoffUntil = codexResetCreditsBackoffUntil.get(key) ?? 0;
  if (backoffUntil > now) {
    return {
      status: "rate-limited",
      credits: null,
      rateLimitTtlMs: backoffUntil - now,
    } satisfies CodexResetCreditsFetchResult;
  }
  const request = HttpClientRequest.get(CODEX_RESET_CREDITS_URL).pipe(
    HttpClientRequest.setHeaders(codexBackendHeaders(auth)),
  );
  const response = yield* fetchJsonWithTimeout(request).pipe(
    Effect.timeoutOption(Duration.millis(CODEX_RESET_CREDITS_TIMEOUT_MS)),
    Effect.map(Option.getOrNull),
  );
  if (response === null) {
    return {
      status: "error",
      credits: null,
      rateLimitTtlMs: null,
    } satisfies CodexResetCreditsFetchResult;
  }
  if (response.status === 429 || (response.status === 503 && response.retryAfterMs !== null)) {
    const ttlMs = setCodexResetCreditsBackoff(key, now, response.retryAfterMs);
    return {
      status: "rate-limited",
      credits: null,
      rateLimitTtlMs: ttlMs,
    } satisfies CodexResetCreditsFetchResult;
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      status: "error",
      credits: null,
      rateLimitTtlMs: null,
    } satisfies CodexResetCreditsFetchResult;
  }
  const credits = parseCodexResetCredits(response.payload);
  codexResetCreditsBackoffUntil.delete(key);
  return {
    status: credits === null ? "error" : "ok",
    credits,
    rateLimitTtlMs: null,
  } satisfies CodexResetCreditsFetchResult;
});

let consumeResetInFlight = false;
let consumeResetCooldownUntil = 0;

function setConsumeResetCooldown(now: number, ttlMs: number): void {
  consumeResetCooldownUntil = Math.max(consumeResetCooldownUntil, now + ttlMs);
}

const performConsumeCodexResetCredit = Effect.fn("performConsumeCodexResetCredit")(function* (
  settings: CodexSettings,
) {
  const auth = yield* readCodexBackendAuth(settings);
  if (auth === null) {
    return {
      ok: false,
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  const availableResult = yield* fetchCodexResetCreditsResult(settings);
  if (availableResult.status === "rate-limited") {
    setConsumeResetCooldown(
      DateTime.toEpochMillis(yield* DateTime.now),
      availableResult.rateLimitTtlMs ?? rateLimitTtlMs(null),
    );
    return {
      ok: false,
      message: "Codex reset-credit API is rate limited — wait a moment before trying again.",
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  if (availableResult.status === "error" || availableResult.credits === null) {
    return {
      ok: false,
      message:
        "Could not read Codex reset credits. Wait a moment and try again before spending a reset.",
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  if (availableResult.credits.availableCount <= 0) {
    return {
      ok: false,
      message: "No rate-limit reset credits are available on this account.",
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  const request = HttpClientRequest.post(CODEX_RESET_CREDITS_CONSUME_URL).pipe(
    HttpClientRequest.setHeaders({
      ...codexBackendHeaders(auth),
      "Content-Type": "application/json",
    }),
    HttpClientRequest.bodyText("{}", "application/json"),
  );
  const response = yield* fetchJsonWithTimeout(request);
  if (response === null) {
    // Ambiguous outcome: the request may have been processed even though we
    // never saw the response. Engage the cooldown and invalidate the cached
    // usage anyway so an immediate retry can't burn a second real credit.
    setConsumeResetCooldown(DateTime.toEpochMillis(yield* DateTime.now), CONSUME_RESET_COOLDOWN_MS);
    invalidateProviderUsageCache("codex");
    return {
      ok: false,
      message:
        "The reset request timed out — it may still have gone through. Usage will refresh shortly; wait a moment before retrying.",
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  if (response.status === 429 || (response.status === 503 && response.retryAfterMs !== null)) {
    setConsumeResetCooldown(
      DateTime.toEpochMillis(yield* DateTime.now),
      rateLimitTtlMs(response.retryAfterMs),
    );
    return {
      ok: false,
      message: "Codex reset-credit API is rate limited — wait a moment before trying again.",
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      message: `Codex reset-credit API returned HTTP ${response.status}.`,
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  setConsumeResetCooldown(DateTime.toEpochMillis(yield* DateTime.now), CONSUME_RESET_COOLDOWN_MS);
  invalidateProviderUsageCache("codex");
  return { ok: true, message: null } satisfies ServerConsumeCodexResetCreditResult;
});

/**
 * Consume one rate-limit reset credit ("Reset now"), immediately resetting
 * the account's session and weekly windows. Spends a real credit, so it is
 * guarded server-side: rejected when the provider is disabled, when another
 * consume is in flight (e.g. two windows confirming at once), during a short
 * cooldown after a successful consume, and when no credit is available.
 */
export const consumeCodexResetCredit = Effect.fn("consumeCodexResetCredit")(function* (
  settings: CodexSettings,
) {
  if (!settings.enabled) {
    return {
      ok: false,
      message: "Codex is disabled in Zrode settings.",
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (consumeResetInFlight) {
    return {
      ok: false,
      message: "A rate-limit reset is already in progress.",
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  if (now < consumeResetCooldownUntil) {
    return {
      ok: false,
      message: "A rate-limit reset was just performed — wait a moment before trying again.",
    } satisfies ServerConsumeCodexResetCreditResult;
  }
  consumeResetInFlight = true;
  return yield* performConsumeCodexResetCredit(settings).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        consumeResetInFlight = false;
      }),
    ),
  );
});

const probeCodexUsage = Effect.fn("probeCodexUsage")(function* (settings: CodexSettings) {
  const updatedAt = DateTime.toEpochMillis(yield* DateTime.now);
  const resolvedHomePath = yield* resolveCodexAuthHomePath(settings);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = {
    ...process.env,
    CODEX_HOME: resolvedHomePath,
  };
  const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["app-server"], {
    env: environment,
    extendEnv: true,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: process.cwd(),
        env: environment,
        extendEnv: true,
        forceKillAfter: CODEX_APP_SERVER_USAGE_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${settings.binaryPath} app-server`,
            cause,
          }),
      ),
    );
  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);

  const account = yield* client.request("account/read", {});
  if (!account.account && account.requiresOpenaiAuth) {
    return usageSnapshot(
      "codex",
      "unauthenticated",
      "Codex CLI is not authenticated. Run `codex login` and try again.",
      updatedAt,
    );
  }

  const rateLimits = yield* client.request("account/rateLimits/read", undefined);
  const credits = rateLimits.rateLimits.credits;
  return {
    provider: "codex",
    status: "ok",
    session: mapCodexWindow(rateLimits.rateLimits.primary, SESSION_WINDOW_MINUTES),
    weekly: mapCodexWindow(rateLimits.rateLimits.secondary, WEEKLY_WINDOW_MINUTES),
    extraLimits: mapCodexExtraLimits(rateLimits),
    planLabel: codexAccountAuthLabel(account.account) ?? null,
    extraUsage: null,
    credits: credits
      ? {
          balance: credits.balance ?? null,
          hasCredits: credits.hasCredits,
          unlimited: credits.unlimited,
        }
      : null,
    resetCredits: null,
    message: null,
    updatedAt,
  } satisfies ProviderUsageSnapshot;
});

const fetchCodexUsageResult = Effect.fn("fetchCodexUsageResult")(function* (
  settings: CodexSettings,
) {
  const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
  if (!settings.enabled) {
    return providerUsageFetchResult(
      usageSnapshot("codex", "unavailable", "Codex is disabled in Zrode settings.", startedAt),
    );
  }
  const probeResult = yield* probeCodexUsage(settings).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)),
    Effect.result,
  );
  const updatedAt = DateTime.toEpochMillis(yield* DateTime.now);
  if (Result.isFailure(probeResult)) {
    if (isCodexAppServerSpawnError(probeResult.failure)) {
      return providerUsageFetchResult(
        usageSnapshot(
          "codex",
          "unavailable",
          "Codex CLI (`codex`) is not installed or not on PATH.",
          updatedAt,
        ),
      );
    }
    return providerUsageFetchResult(
      usageSnapshot(
        "codex",
        "error",
        `Failed to fetch Codex usage: ${probeResult.failure.message}`,
        updatedAt,
      ),
    );
  }
  if (Option.isNone(probeResult.success)) {
    return providerUsageFetchResult(
      usageSnapshot("codex", "error", "Timed out while fetching Codex usage.", updatedAt),
    );
  }
  const snapshot = probeResult.success.value;
  if (snapshot.status !== "ok") {
    return providerUsageFetchResult({ ...snapshot, updatedAt });
  }
  const resetCreditsResult = yield* fetchCodexResetCreditsResult(settings);
  return providerUsageFetchResult(
    { ...snapshot, resetCredits: resetCreditsResult.credits, updatedAt },
    { auxiliaryBackoffTtlMs: resetCreditsResult.rateLimitTtlMs },
  );
});

export const fetchCodexUsage = Effect.fn("fetchCodexUsage")(function* (settings: CodexSettings) {
  return (yield* fetchCodexUsageResult(settings)).snapshot;
});

// ── Aggregation ──────────────────────────────────────────────────────

/** Errored snapshots expire quickly so a fixed provider recovers promptly. */
const USAGE_CACHE_ERROR_TTL_MS = 10_000;

/**
 * If a provider asks us to slow down, keep showing that provider's last good
 * snapshot while its cache backs off. This avoids converting a transient 429
 * into user-visible churn, but still surfaces the rate-limit message on a cold
 * cache where no good snapshot exists.
 */
export function selectProviderUsageSnapshotForCache(
  fetched: ProviderUsageSnapshot,
  cached: ProviderUsageSnapshot | null,
  rateLimited: boolean,
): ProviderUsageSnapshot {
  if (!rateLimited || fetched.status === "ok" || cached?.status !== "ok") {
    return fetched;
  }
  return cached;
}

function providerUsageCacheTtlMs(result: ProviderUsageFetchResult): number {
  return (
    result.mainBackoffTtlMs ??
    (result.snapshot.status === "ok" ? USAGE_CACHE_TTL_MS : USAGE_CACHE_ERROR_TTL_MS)
  );
}

function materializeProviderUsageSnapshot(
  fetched: ProviderUsageFetchResult,
  cachedOk: ProviderUsageSnapshot | null,
): ProviderUsageSnapshot {
  const selected = selectProviderUsageSnapshotForCache(
    fetched.snapshot,
    cachedOk,
    fetched.mainBackoffTtlMs !== null,
  );
  if (
    selected === fetched.snapshot &&
    fetched.auxiliaryBackoffTtlMs !== null &&
    fetched.snapshot.provider === "codex" &&
    fetched.snapshot.status === "ok" &&
    fetched.snapshot.resetCredits === null &&
    cachedOk?.provider === "codex" &&
    cachedOk.status === "ok" &&
    cachedOk.resetCredits !== null
  ) {
    return { ...fetched.snapshot, resetCredits: cachedOk.resetCredits };
  }
  return selected;
}

function providerUsageSupersededSnapshot(
  provider: ProviderUsageProviderKind,
  updatedAt: number,
): ProviderUsageSnapshot {
  return usageSnapshot(
    provider,
    "error",
    "Usage refresh was superseded by a newer request — reopen usage details to refresh.",
    updatedAt,
  );
}

function makeProviderUsageCacheState(input: {
  readonly key: string;
  readonly generation: number;
  readonly completedAt: number;
  readonly fetched: ProviderUsageFetchResult;
  readonly cached: ProviderUsageCacheState | null;
}): ProviderUsageCacheState {
  const cachedOk = input.cached?.lastOkSnapshot ?? null;
  const snapshot = materializeProviderUsageSnapshot(input.fetched, cachedOk);
  return {
    key: input.key,
    generation: input.generation,
    expiresAt: input.completedAt + providerUsageCacheTtlMs(input.fetched),
    snapshot,
    lastOkSnapshot: snapshot.status === "ok" ? snapshot : cachedOk,
  };
}

/**
 * Fold defects (e.g. an unexpected vendor payload shape crashing a parser)
 * into an "error" snapshot so a single provider can never fail the RPC.
 */
const foldProviderDefects = <R>(
  provider: ProviderUsageProviderKind,
  fetchSnapshot: Effect.Effect<ProviderUsageFetchResult, never, R>,
): Effect.Effect<ProviderUsageFetchResult, never, R> =>
  fetchSnapshot.pipe(
    Effect.catchDefect((defect) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Provider usage fetch crashed", { provider, defect });
        const updatedAt = DateTime.toEpochMillis(yield* DateTime.now);
        return providerUsageFetchResult(
          usageSnapshot(
            provider,
            "error",
            "Usage data could not be read from the provider's response.",
            updatedAt,
          ),
        );
      }),
    ),
  );

const getProviderUsageSnapshot = Effect.fn("getProviderUsageSnapshot")(function* <R>(
  provider: ProviderUsageProviderKind,
  key: string,
  fetchSnapshot: Effect.Effect<ProviderUsageFetchResult, never, R>,
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const generation = providerUsageGeneration(provider);
  const cached = usageCache.get(provider) ?? null;
  if (
    cached !== null &&
    cached.key === key &&
    cached.generation === generation &&
    cached.expiresAt > now
  ) {
    return cached.snapshot;
  }

  const inFlight = usageInFlight.get(provider) ?? null;
  if (inFlight !== null && inFlight.key === key && inFlight.generation === generation) {
    if (cached !== null && cached.key === key && cached.generation === generation) {
      return cached.snapshot;
    }
    return yield* Deferred.await(inFlight.deferred);
  }

  const deferred = yield* Deferred.make<ProviderUsageSnapshot>();
  const claimed = usageInFlight.get(provider) ?? null;
  if (claimed !== null && claimed.key === key && claimed.generation === generation) {
    return yield* Deferred.await(claimed.deferred);
  }

  const ownRecord: ProviderUsageInFlightState = { key, generation, deferred };
  const cachedForFetch = cached?.key === key && cached.generation === generation ? cached : null;
  const settleFetch = fetchSnapshot.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.gen(function* () {
          const isCurrentGeneration = providerUsageGeneration(provider) === ownRecord.generation;
          const isOwner = usageInFlight.get(provider) === ownRecord && isCurrentGeneration;
          if (isOwner) {
            usageInFlight.delete(provider);
          }
          if (!isCurrentGeneration || !isOwner) {
            const updatedAt = DateTime.toEpochMillis(yield* DateTime.now);
            yield* Deferred.succeed(deferred, providerUsageSupersededSnapshot(provider, updatedAt));
            return;
          }
          yield* Deferred.failCause(deferred, cause);
        }),
      onSuccess: (fetched) =>
        Effect.gen(function* () {
          const isCurrentGeneration = providerUsageGeneration(provider) === ownRecord.generation;
          const isOwner = usageInFlight.get(provider) === ownRecord && isCurrentGeneration;
          if (isOwner) {
            usageInFlight.delete(provider);
          }
          if (!isCurrentGeneration || !isOwner) {
            const updatedAt = DateTime.toEpochMillis(yield* DateTime.now);
            yield* Deferred.succeed(deferred, providerUsageSupersededSnapshot(provider, updatedAt));
            return;
          }
          const snapshot = makeProviderUsageCacheState({
            key,
            generation,
            completedAt: DateTime.toEpochMillis(yield* DateTime.now),
            fetched,
            cached: cachedForFetch,
          });
          usageCache.set(provider, snapshot);
          yield* Deferred.succeed(deferred, snapshot.snapshot);
        }),
    }),
  );
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const replaced = usageInFlight.get(provider) ?? null;
      if (replaced !== null && replaced.key !== key) {
        const updatedAt = DateTime.toEpochMillis(yield* DateTime.now);
        yield* Deferred.succeed(
          replaced.deferred,
          providerUsageSupersededSnapshot(provider, updatedAt),
        );
      }
      usageInFlight.set(provider, ownRecord);
      yield* settleFetch.pipe(Effect.forkDetach({ startImmediately: true }));
    }),
  );
  return yield* Deferred.await(deferred);
});

export const getProviderUsage = Effect.fn("getProviderUsage")(function* (settings: ServerSettings) {
  const usage = yield* Effect.all(
    [
      getProviderUsageSnapshot(
        "claude",
        claudeUsageSettingsKey(settings.providers.claudeAgent),
        foldProviderDefects("claude", fetchClaudeUsageResult(settings.providers.claudeAgent)),
      ),
      getProviderUsageSnapshot(
        "codex",
        codexUsageSettingsKey(settings.providers.codex),
        foldProviderDefects("codex", fetchCodexUsageResult(settings.providers.codex)),
      ),
    ],
    { concurrency: "unbounded" },
  );
  return { usage } satisfies ServerProviderUsageResult;
});

/** Fallback result when server settings cannot be read at all. */
export const providerUsageUnavailable = Effect.fn("providerUsageUnavailable")(function* (
  message: string,
) {
  const updatedAt = DateTime.toEpochMillis(yield* DateTime.now);
  return {
    usage: [
      usageSnapshot("claude", "error", message, updatedAt),
      usageSnapshot("codex", "error", message, updatedAt),
    ],
  } satisfies ServerProviderUsageResult;
});

interface ProviderUsageFetchResultForTests {
  readonly snapshot: ProviderUsageSnapshot;
  readonly mainBackoffTtlMs?: number | null | undefined;
  readonly auxiliaryBackoffTtlMs?: number | null | undefined;
}

interface ProviderUsageCacheStateForTests {
  readonly key: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly snapshot: ProviderUsageSnapshot;
  readonly lastOkSnapshot: ProviderUsageSnapshot | null;
}

function providerUsageFetchOptionsForTests(input: ProviderUsageFetchResultForTests): {
  readonly mainBackoffTtlMs?: number | null;
  readonly auxiliaryBackoffTtlMs?: number | null;
} {
  const options: {
    mainBackoffTtlMs?: number | null;
    auxiliaryBackoffTtlMs?: number | null;
  } = {};
  if (input.mainBackoffTtlMs !== undefined) {
    options.mainBackoffTtlMs = input.mainBackoffTtlMs;
  }
  if (input.auxiliaryBackoffTtlMs !== undefined) {
    options.auxiliaryBackoffTtlMs = input.auxiliaryBackoffTtlMs;
  }
  return options;
}

/** Exposed for tests. */
export const __testing = {
  getProviderUsageSnapshot: <R>(
    provider: ProviderUsageProviderKind,
    key: string,
    fetchSnapshot: Effect.Effect<ProviderUsageFetchResultForTests, never, R>,
  ): Effect.Effect<ProviderUsageSnapshot, never, R> =>
    getProviderUsageSnapshot(
      provider,
      key,
      fetchSnapshot.pipe(
        Effect.map(({ snapshot, mainBackoffTtlMs, auxiliaryBackoffTtlMs }) =>
          providerUsageFetchResult(
            snapshot,
            providerUsageFetchOptionsForTests({
              snapshot,
              mainBackoffTtlMs,
              auxiliaryBackoffTtlMs,
            }),
          ),
        ),
      ),
    ),
  makeProviderUsageCacheState: (input: {
    readonly key: string;
    readonly generation: number;
    readonly completedAt: number;
    readonly fetched: ProviderUsageFetchResultForTests;
    readonly cached: ProviderUsageCacheStateForTests | null;
  }): ProviderUsageCacheStateForTests =>
    makeProviderUsageCacheState({
      key: input.key,
      generation: input.generation,
      completedAt: input.completedAt,
      fetched: providerUsageFetchResult(
        input.fetched.snapshot,
        providerUsageFetchOptionsForTests(input.fetched),
      ),
      cached: input.cached,
    }),
  providerUsageCacheTtlMs: (input: ProviderUsageFetchResultForTests): number =>
    providerUsageCacheTtlMs(
      providerUsageFetchResult(input.snapshot, providerUsageFetchOptionsForTests(input)),
    ),
};

/** Test-only: clear all module-level caches and cooldowns. */
export function resetProviderUsageStateForTests(): void {
  usageCache = new Map();
  usageInFlight = new Map();
  usageGeneration = new Map();
  codexResetCreditsBackoffUntil = new Map();
  claudeTokenCache = null;
  consumeResetInFlight = false;
  consumeResetCooldownUntil = 0;
}
