import { beforeEach, describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUsageSnapshot,
  type ServerSettings,
} from "@t3tools/contracts";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import type * as CodexSchema from "effect-codex-app-server/schema";

import * as ProcessRunner from "../processRunner.ts";
import {
  __testing,
  claudeCredentialSourceKey,
  claudeKeychainServiceName,
  consumeCodexResetCredit,
  fetchGrokUsage,
  getProviderUsage,
  invalidateProviderUsageCache,
  mapCodexExtraLimits,
  normalizeResetsAt,
  parseClaudeLimits,
  parseClaudeOAuthCredentials,
  parseCodexBackendAuth,
  parseCodexResetCredits,
  parseGrokAuthCredentials,
  parseGrokBilling,
  parseRetryAfterMs,
  providerUsageSettingsKey,
  resetProviderUsageStateForTests,
  selectProviderUsageSnapshotForCache,
  SESSION_WINDOW_MINUTES,
  usageSettingsKey,
  WEEKLY_WINDOW_MINUTES,
} from "./providerUsage.ts";

const TestLayer = Layer.mergeAll(ProcessRunner.layer, FetchHttpClient.layer).pipe(
  Layer.provideMerge(NodeServicesLayer),
);

/** Both providers disabled: usage resolves instantly with no external calls. */
const DISABLED_SETTINGS: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, enabled: false },
    codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
    grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: false },
  },
};

function snapshot(overrides: Partial<ProviderUsageSnapshot>): ProviderUsageSnapshot {
  return {
    provider: "claude",
    status: "ok",
    session: { usedPercent: 10, windowMinutes: SESSION_WINDOW_MINUTES, resetsAt: null },
    weekly: { usedPercent: 20, windowMinutes: WEEKLY_WINDOW_MINUTES, resetsAt: null },
    extraLimits: [],
    planLabel: null,
    extraUsage: null,
    credits: null,
    resetCredits: null,
    message: null,
    updatedAt: 1,
    ...overrides,
  };
}

const makeTempCodexHomeWithAuth = Effect.fn("makeTempCodexHomeWithAuth")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "zrode-codex-usage-" });
  yield* fileSystem.writeFileString(
    path.join(dir, "auth.json"),
    '{"tokens":{"access_token":"codex-token","account_id":"account-1"}}',
  );
  return dir;
});

describe("normalizeResetsAt", () => {
  it("parses ISO-8601 strings to epoch milliseconds", () => {
    expect(normalizeResetsAt("2026-07-05T13:30:00.000Z")).toBe(
      Date.parse("2026-07-05T13:30:00.000Z"),
    );
  });

  it("treats small numbers as unix seconds", () => {
    expect(normalizeResetsAt(1_783_258_838)).toBe(1_783_258_838_000);
  });

  it("passes epoch-millisecond numbers through", () => {
    expect(normalizeResetsAt(1_783_258_838_000)).toBe(1_783_258_838_000);
  });

  it("rejects malformed values", () => {
    expect(normalizeResetsAt("not a date")).toBeNull();
    expect(normalizeResetsAt(Number.NaN)).toBeNull();
    expect(normalizeResetsAt(null)).toBeNull();
    expect(normalizeResetsAt(undefined)).toBeNull();
    expect(normalizeResetsAt({})).toBeNull();
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta seconds", () => {
    expect(parseRetryAfterMs("120", Date.parse("2026-07-06T12:00:00Z"))).toBe(120_000);
  });

  it("parses HTTP dates relative to the response time", () => {
    expect(
      parseRetryAfterMs("Mon, 06 Jul 2026 12:05:00 GMT", Date.parse("2026-07-06T12:00:00Z")),
    ).toBe(300_000);
  });

  it("rejects malformed values", () => {
    const nowMs = Date.parse("2026-07-06T12:00:00Z");
    expect(parseRetryAfterMs(undefined, nowMs)).toBeNull();
    expect(parseRetryAfterMs("not a retry date", nowMs)).toBeNull();
  });
});

describe("parseClaudeOAuthCredentials", () => {
  it("extracts the access token and expiry", () => {
    const credentials = parseClaudeOAuthCredentials(
      JSON.stringify({
        claudeAiOauth: { accessToken: "tok-123", expiresAt: 1_783_258_838_000 },
      }),
    );
    expect(credentials).toEqual({ accessToken: "tok-123", expiresAt: 1_783_258_838_000 });
  });

  it("tolerates a missing expiry", () => {
    const credentials = parseClaudeOAuthCredentials(
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-123" } }),
    );
    expect(credentials).toEqual({ accessToken: "tok-123", expiresAt: null });
  });

  it("rejects blobs without a usable token", () => {
    expect(parseClaudeOAuthCredentials(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
    expect(
      parseClaudeOAuthCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "" } })),
    ).toBeNull();
    expect(parseClaudeOAuthCredentials("not json")).toBeNull();
  });
});

describe("claudeKeychainServiceName", () => {
  it("uses Claude Code's default service for the default config directory", () => {
    expect(claudeKeychainServiceName("/Users/test/.claude", false)).toBe("Claude Code-credentials");
  });

  it("uses Claude Code's config-scoped service for an isolated account", () => {
    expect(claudeKeychainServiceName("/Users/test/.claude-work/.claude", true)).toBe(
      "Claude Code-credentials-2212dfe3",
    );
    expect(claudeKeychainServiceName("/Users/test/.claude-work/.claude", true)).not.toBe(
      claudeKeychainServiceName("/Users/test/.claude-personal/.claude", true),
    );
  });

  it("normalizes Unicode paths before deriving the Keychain service", () => {
    expect(claudeKeychainServiceName("/Users/test/.claude-cafe\u0301", true)).toBe(
      claudeKeychainServiceName("/Users/test/.claude-café", true),
    );
  });
});

describe("claudeCredentialSourceKey", () => {
  it("changes for secure-storage directories and Keychain accounts", () => {
    const configDir = "/Users/test/.claude";
    const first = claudeCredentialSourceKey(configDir, {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/Users/test/.claude-personal",
      USER: "alice",
    });

    expect(
      claudeCredentialSourceKey(configDir, {
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/Users/test/.claude-work",
        USER: "alice",
      }),
    ).not.toBe(first);
    expect(
      claudeCredentialSourceKey(configDir, {
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/Users/test/.claude-personal",
        USER: "bob",
      }),
    ).not.toBe(first);
  });
});

describe("parseGrokAuthCredentials", () => {
  it("selects the newest usable Grok CLI credential", () => {
    expect(
      parseGrokAuthCredentials(
        JSON.stringify({
          older: {
            key: "older-token",
            email: "old@example.com",
            create_time: "2026-06-01T00:00:00Z",
          },
          current: {
            key: "current-token",
            email: "current@example.com",
            create_time: "2026-07-01T00:00:00Z",
            expires_at: "2026-07-10T18:00:00Z",
          },
        }),
      ),
    ).toEqual({
      accessToken: "current-token",
      expiresAt: Date.parse("2026-07-10T18:00:00Z"),
      accountLabel: "current@example.com",
      source: "auth-file",
    });
  });

  it("rejects malformed Grok auth files", () => {
    expect(parseGrokAuthCredentials("not json")).toBeNull();
    expect(parseGrokAuthCredentials(JSON.stringify({ account: { key: "" } }))).toBeNull();
  });
});

describe("parseGrokBilling", () => {
  it("maps Grok Build credits into a monthly allowance window", () => {
    const parsed = parseGrokBilling({
      config: {
        monthlyLimit: { val: 4_000 },
        used: { val: 1_000 },
        onDemandCap: { val: 0 },
        billingPeriodStart: "2026-07-01T00:00:00Z",
        billingPeriodEnd: "2026-08-01T00:00:00Z",
      },
    });
    expect(parsed).toEqual({
      window: {
        label: "Monthly allowance",
        usedPercent: 25,
        windowMinutes: 44_640,
        resetsAt: Date.parse("2026-08-01T00:00:00Z"),
      },
      extraLimits: [],
      extraUsage: null,
      credits: null,
    });
  });

  it("maps the unified weekly pool, product breakdown, and prepaid credits", () => {
    const start = Date.parse("2026-07-06T12:00:00Z") / 1_000;
    const end = Date.parse("2026-07-13T12:00:00Z") / 1_000;
    const parsed = parseGrokBilling({
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: { seconds: String(start) },
          end: { seconds: String(end) },
        },
        productUsage: [
          { product: "GrokBuild", usagePercent: 25 },
          { product: "GrokChat", usagePercent: 10 },
        ],
        prepaidBalance: { val: "1234" },
        onDemandCap: { val: "1000" },
        onDemandUsed: { val: "250" },
      },
    });

    expect(parsed).toEqual({
      window: {
        label: "Weekly allowance",
        usedPercent: 42.5,
        windowMinutes: WEEKLY_WINDOW_MINUTES,
        resetsAt: Date.parse("2026-07-13T12:00:00Z"),
      },
      extraLimits: [
        {
          label: "Grok Build",
          session: null,
          weekly: {
            usedPercent: 25,
            windowMinutes: WEEKLY_WINDOW_MINUTES,
            resetsAt: Date.parse("2026-07-13T12:00:00Z"),
          },
        },
        {
          label: "Chat",
          session: null,
          weekly: {
            usedPercent: 10,
            windowMinutes: WEEKLY_WINDOW_MINUTES,
            resetsAt: Date.parse("2026-07-13T12:00:00Z"),
          },
        },
      ],
      extraUsage: { enabled: true, utilization: 25 },
      credits: { balance: "$12.34", hasCredits: true, unlimited: false },
    });
  });

  it("reports utilization above the included allowance against on-demand capacity", () => {
    const parsed = parseGrokBilling({
      config: {
        monthlyLimit: { val: "4000" },
        used: { val: "4500" },
        onDemandCap: { val: "2000" },
      },
    });
    expect(parsed?.window.usedPercent).toBe(100);
    expect(parsed?.extraUsage).toEqual({ enabled: true, utilization: 25 });
  });

  it("rejects responses without a positive allowance", () => {
    expect(parseGrokBilling({ config: { monthlyLimit: { val: 0 }, used: { val: 0 } } })).toBeNull();
    expect(parseGrokBilling({})).toBeNull();
  });
});

describe("fetchGrokUsage", () => {
  effectIt.live("reads the CLI credential and fetches the Grok usage allowance", () => {
    let authorization: string | undefined;
    let requestUrl: string | undefined;
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        authorization = request.headers.authorization;
        requestUrl = request.url;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              config: {
                monthlyLimit: { val: 4_000 },
                used: { val: 1_000 },
                onDemandCap: { val: 0 },
                billingPeriodStart: "2026-07-01T00:00:00Z",
                billingPeriodEnd: "2026-08-01T00:00:00Z",
              },
            }),
          ),
        );
      }),
    );
    const processRunnerLayer = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: () => Effect.die("Grok credential refresh should not run for a valid token"),
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "zrode-grok-usage-" });
        yield* fileSystem.writeFileString(
          path.join(home, "auth.json"),
          '{"account":{"key":"grok-token","email":"person@example.com","expires_at":"2099-01-01T00:00:00Z"}}',
        );
        const previousHome = process.env.GROK_HOME;
        const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;
        process.env.GROK_HOME = home;
        delete process.env.GROK_CODE_XAI_API_KEY;
        const result = yield* fetchGrokUsage({
          ...DEFAULT_SERVER_SETTINGS.providers.grok,
          enabled: true,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousHome === undefined) delete process.env.GROK_HOME;
              else process.env.GROK_HOME = previousHome;
              if (previousApiKey === undefined) delete process.env.GROK_CODE_XAI_API_KEY;
              else process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
            }),
          ),
        );

        expect(authorization).toBe("Bearer grok-token");
        expect(requestUrl).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
        expect(result.status).toBe("ok");
        expect(result.planLabel).toBe("person@example.com");
        expect(result.weekly?.label).toBe("Monthly allowance");
        expect(result.weekly?.usedPercent).toBe(25);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServicesLayer, processRunnerLayer, httpLayer)));
  });
});

describe("parseClaudeLimits", () => {
  const limitsPayload = {
    five_hour: { utilization: 99, resets_at: "2026-07-05T13:30:00Z" },
    seven_day: { utilization: 98, resets_at: "2026-07-09T14:00:00Z" },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 17,
        resets_at: "2026-07-05T13:30:00Z",
        scope: null,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 16,
        resets_at: "2026-07-09T14:00:00Z",
        scope: null,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 26,
        resets_at: "2026-07-09T14:00:00Z",
        scope: { model: { display_name: "Fable" }, surface: null },
      },
    ],
  };

  it("prefers the limits array over the legacy window fields", () => {
    const parsed = parseClaudeLimits(limitsPayload);
    expect(parsed.session?.usedPercent).toBe(17);
    expect(parsed.session?.windowMinutes).toBe(SESSION_WINDOW_MINUTES);
    expect(parsed.weekly?.usedPercent).toBe(16);
    expect(parsed.weekly?.windowMinutes).toBe(WEEKLY_WINDOW_MINUTES);
  });

  it("projects scoped limits into labeled extra limits", () => {
    const parsed = parseClaudeLimits(limitsPayload);
    expect(parsed.extraLimits).toHaveLength(1);
    expect(parsed.extraLimits[0]).toMatchObject({ label: "Fable", session: null });
    expect(parsed.extraLimits[0]!.weekly?.usedPercent).toBe(26);
  });

  it("falls back to five_hour/seven_day when limits are absent", () => {
    const parsed = parseClaudeLimits({
      five_hour: { utilization: 13, resets_at: "2026-07-05T13:30:00Z" },
      seven_day: { utilization: 16, resets_at: "2026-07-09T14:00:00Z" },
    });
    expect(parsed.session?.usedPercent).toBe(13);
    expect(parsed.weekly?.usedPercent).toBe(16);
    expect(parsed.extraLimits).toEqual([]);
  });

  it("clamps utilization into the 0–100 range", () => {
    const parsed = parseClaudeLimits({
      limits: [{ kind: "session", group: "session", percent: 250, resets_at: null, scope: null }],
    });
    expect(parsed.session?.usedPercent).toBe(100);
  });

  it("skips limits without a numeric percent", () => {
    const parsed = parseClaudeLimits({
      limits: [{ kind: "session", group: "session", percent: "17", scope: null }],
    });
    expect(parsed.session).toBeNull();
  });
});

describe("mapCodexExtraLimits", () => {
  const window = (
    usedPercent: number,
  ): CodexSchema.V2GetAccountRateLimitsResponse["rateLimits"]["primary"] => ({
    usedPercent,
    windowDurationMins: 300,
    resetsAt: 1_783_258_838,
  });

  it("skips the default bucket and maps the rest by display name", () => {
    const response = {
      rateLimits: { limitId: "codex", primary: window(10), secondary: window(22) },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", limitName: null, primary: window(10), secondary: window(22) },
        codex_spark: {
          limitId: "codex_spark",
          limitName: "GPT-5.3-Codex-Spark",
          primary: window(1),
          secondary: window(2),
        },
      },
    } as unknown as CodexSchema.V2GetAccountRateLimitsResponse;
    const extraLimits = mapCodexExtraLimits(response);
    expect(extraLimits).toHaveLength(1);
    expect(extraLimits[0]!.label).toBe("GPT-5.3-Codex-Spark");
    expect(extraLimits[0]!.session?.usedPercent).toBe(1);
    expect(extraLimits[0]!.weekly?.usedPercent).toBe(2);
    expect(extraLimits[0]!.session?.resetsAt).toBe(1_783_258_838_000);
  });

  it("returns an empty list when no bucket map is present", () => {
    const response = {
      rateLimits: { limitId: "codex", primary: window(10), secondary: window(22) },
    } as unknown as CodexSchema.V2GetAccountRateLimitsResponse;
    expect(mapCodexExtraLimits(response)).toEqual([]);
  });
});

describe("parseCodexBackendAuth", () => {
  it("extracts the access token and account id", () => {
    expect(
      parseCodexBackendAuth(JSON.stringify({ tokens: { access_token: "tok", account_id: "acc" } })),
    ).toEqual({ accessToken: "tok", accountId: "acc" });
  });

  it("tolerates a missing account id", () => {
    expect(parseCodexBackendAuth(JSON.stringify({ tokens: { access_token: "tok" } }))).toEqual({
      accessToken: "tok",
      accountId: null,
    });
  });

  it("rejects blobs without a token", () => {
    expect(parseCodexBackendAuth(JSON.stringify({ tokens: {} }))).toBeNull();
    expect(parseCodexBackendAuth("not json")).toBeNull();
  });
});

describe("parseCodexResetCredits", () => {
  it("counts available credits and finds the soonest expiry", () => {
    const parsed = parseCodexResetCredits({
      credits: [
        { status: "available", expires_at: "2026-07-12T00:00:00Z" },
        { status: "available", expires_at: "2026-07-10T00:00:00Z" },
        { status: "redeemed", expires_at: "2026-07-01T00:00:00Z" },
      ],
    });
    expect(parsed).toEqual({
      availableCount: 2,
      totalEarnedCount: 3,
      nextExpiresAt: Date.parse("2026-07-10T00:00:00Z"),
    });
  });

  it("returns null for malformed payloads", () => {
    expect(parseCodexResetCredits(null)).toBeNull();
    expect(parseCodexResetCredits({})).toBeNull();
    expect(parseCodexResetCredits({ credits: "nope" })).toBeNull();
  });

  it("handles zero available credits", () => {
    const parsed = parseCodexResetCredits({ credits: [{ status: "redeemed" }] });
    expect(parsed).toEqual({ availableCount: 0, totalEarnedCount: 1, nextExpiresAt: null });
  });
});

describe("usageSettingsKey", () => {
  it("is stable for identical settings", () => {
    expect(usageSettingsKey(DISABLED_SETTINGS)).toBe(usageSettingsKey(DISABLED_SETTINGS));
  });

  it("does not collide across field boundaries", () => {
    const a: ServerSettings = {
      ...DISABLED_SETTINGS,
      providers: {
        ...DISABLED_SETTINGS.providers,
        claudeAgent: { ...DISABLED_SETTINGS.providers.claudeAgent, homePath: "/a b" },
        codex: { ...DISABLED_SETTINGS.providers.codex, binaryPath: "c" },
      },
    };
    const b: ServerSettings = {
      ...DISABLED_SETTINGS,
      providers: {
        ...DISABLED_SETTINGS.providers,
        claudeAgent: { ...DISABLED_SETTINGS.providers.claudeAgent, homePath: "/a" },
        codex: { ...DISABLED_SETTINGS.providers.codex, binaryPath: "b c" },
      },
    };
    expect(usageSettingsKey(a)).not.toBe(usageSettingsKey(b));
  });

  it("splits provider keys so one provider cache cannot invalidate the other", () => {
    const otherClaudeHome: ServerSettings = {
      ...DISABLED_SETTINGS,
      providers: {
        ...DISABLED_SETTINGS.providers,
        claudeAgent: {
          ...DISABLED_SETTINGS.providers.claudeAgent,
          homePath: "/tmp/other-claude-home",
        },
      },
    };
    expect(providerUsageSettingsKey("claude", otherClaudeHome)).not.toBe(
      providerUsageSettingsKey("claude", DISABLED_SETTINGS),
    );
    expect(providerUsageSettingsKey("codex", otherClaudeHome)).toBe(
      providerUsageSettingsKey("codex", DISABLED_SETTINGS),
    );
  });

  it("keys Claude usage from the explicit default provider instance", () => {
    const settings: ServerSettings = {
      ...DISABLED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [
            { name: "CLAUDE_CONFIG_DIR", value: "/tmp/instance-claude", sensitive: false },
          ],
          config: { enabled: true },
        },
      } as ServerSettings["providerInstances"],
    };

    expect(providerUsageSettingsKey("claude", settings)).not.toBe(
      providerUsageSettingsKey("claude", DISABLED_SETTINGS),
    );
  });
});

describe("selectProviderUsageSnapshotForCache", () => {
  const claudeRateLimited = snapshot({
    provider: "claude",
    status: "error",
    session: null,
    weekly: null,
    message:
      "Rate limited by the Claude usage API — data will refresh automatically in a few minutes.",
    updatedAt: 2,
  });

  it("keeps showing the last good provider snapshot during a 429 backoff", () => {
    const cachedClaude = snapshot({ provider: "claude", updatedAt: 1 });
    expect(selectProviderUsageSnapshotForCache(claudeRateLimited, cachedClaude, true)).toBe(
      cachedClaude,
    );
  });

  it("surfaces the rate-limit snapshot when no good cached value exists", () => {
    expect(
      selectProviderUsageSnapshotForCache(
        claudeRateLimited,
        snapshot({ provider: "claude", status: "unauthenticated" }),
        true,
      ),
    ).toBe(claudeRateLimited);
  });

  it("does not reuse cached data for ordinary provider errors", () => {
    const cachedClaude = snapshot({ provider: "claude", updatedAt: 1 });
    expect(selectProviderUsageSnapshotForCache(claudeRateLimited, cachedClaude, false)).toBe(
      claudeRateLimited,
    );
  });
});

describe("provider usage cache policy", () => {
  it("does not let auxiliary reset-credit backoff extend the main usage cache TTL", () => {
    const completedAt = 1_000;
    const state = __testing.makeProviderUsageCacheState({
      key: "codex-key",
      generation: 0,
      completedAt,
      fetched: {
        snapshot: snapshot({ provider: "codex", resetCredits: null, updatedAt: completedAt }),
        auxiliaryBackoffTtlMs: 10 * 60_000,
      },
      cached: null,
    });

    expect(state.expiresAt).toBe(completedAt + 60_000);
  });

  it("preserves cached Codex reset credits while reset-credit enrichment is rate limited", () => {
    const resetCredits = {
      availableCount: 1,
      totalEarnedCount: 2,
      nextExpiresAt: Date.parse("2026-07-10T00:00:00Z"),
    };
    const cached = __testing.makeProviderUsageCacheState({
      key: "codex-key",
      generation: 0,
      completedAt: 1_000,
      fetched: {
        snapshot: snapshot({ provider: "codex", resetCredits, updatedAt: 1_000 }),
      },
      cached: null,
    });
    const refreshed = __testing.makeProviderUsageCacheState({
      key: "codex-key",
      generation: 0,
      completedAt: 2_000,
      fetched: {
        snapshot: snapshot({ provider: "codex", resetCredits: null, updatedAt: 2_000 }),
        auxiliaryBackoffTtlMs: 5 * 60_000,
      },
      cached,
    });

    expect(refreshed.snapshot.resetCredits).toEqual(resetCredits);
    expect(refreshed.expiresAt).toBe(62_000);
  });

  it("backs off a primary rate-limited provider while keeping the last good snapshot", () => {
    const cached = __testing.makeProviderUsageCacheState({
      key: "claude-key",
      generation: 0,
      completedAt: 1_000,
      fetched: { snapshot: snapshot({ provider: "claude", updatedAt: 1_000 }) },
      cached: null,
    });
    const refreshed = __testing.makeProviderUsageCacheState({
      key: "claude-key",
      generation: 0,
      completedAt: 2_000,
      fetched: {
        snapshot: snapshot({
          provider: "claude",
          status: "error",
          session: null,
          weekly: null,
          message:
            "Rate limited by the Claude usage API — data will refresh automatically in a few minutes.",
          updatedAt: 2_000,
        }),
        mainBackoffTtlMs: 120_000,
      },
      cached,
    });

    expect(refreshed.snapshot).toBe(cached.snapshot);
    expect(refreshed.expiresAt).toBe(122_000);
  });
});

describe("getProviderUsage caching", () => {
  beforeEach(() => {
    resetProviderUsageStateForTests();
  });

  effectIt.live("returns unavailable snapshots for disabled providers", () =>
    Effect.gen(function* () {
      const result = yield* getProviderUsage(DISABLED_SETTINGS);
      expect(result.usage.map((snapshot) => snapshot.status)).toEqual([
        "unavailable",
        "unavailable",
        "unavailable",
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("serves the cached result on subsequent calls", () =>
    Effect.gen(function* () {
      const first = yield* getProviderUsage(DISABLED_SETTINGS);
      const second = yield* getProviderUsage(DISABLED_SETTINGS);
      expect(second.usage[0]).toBe(first.usage[0]);
      expect(second.usage[1]).toBe(first.usage[1]);
      expect(second.usage[2]).toBe(first.usage[2]);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("refetches after the cache is invalidated", () =>
    Effect.gen(function* () {
      const first = yield* getProviderUsage(DISABLED_SETTINGS);
      invalidateProviderUsageCache();
      const second = yield* getProviderUsage(DISABLED_SETTINGS);
      expect(second.usage[0]).not.toBe(first.usage[0]);
      expect(second.usage[1]).not.toBe(first.usage[1]);
      expect(second.usage[2]).not.toBe(first.usage[2]);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("coalesces concurrent cold-cache callers onto one result", () =>
    Effect.gen(function* () {
      const [first, second, third] = yield* Effect.all(
        [
          getProviderUsage(DISABLED_SETTINGS),
          getProviderUsage(DISABLED_SETTINGS),
          getProviderUsage(DISABLED_SETTINGS),
        ],
        { concurrency: "unbounded" },
      );
      expect(second.usage[0]).toBe(first.usage[0]);
      expect(second.usage[1]).toBe(first.usage[1]);
      expect(third.usage[0]).toBe(first.usage[0]);
      expect(third.usage[1]).toBe(first.usage[1]);
      expect(second.usage[2]).toBe(first.usage[2]);
      expect(third.usage[2]).toBe(first.usage[2]);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("coalesces concurrent active fetches before the first response settles", () =>
    Effect.gen(function* () {
      const fetchStarted = yield* Deferred.make<void>();
      const releaseFetch = yield* Deferred.make<void>();
      const fetchedSnapshot = snapshot({ provider: "claude", updatedAt: 101 });
      let fetchCount = 0;
      const fetch = Effect.gen(function* () {
        fetchCount += 1;
        yield* Deferred.succeed(fetchStarted, undefined);
        yield* Deferred.await(releaseFetch);
        return { snapshot: fetchedSnapshot };
      });

      const firstFiber = yield* __testing
        .getProviderUsageSnapshot("claude", "same-key", fetch)
        .pipe(Effect.forkChild);
      yield* Deferred.await(fetchStarted);
      const secondFiber = yield* __testing
        .getProviderUsageSnapshot("claude", "same-key", fetch)
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseFetch, undefined);

      const [first, second] = yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)], {
        concurrency: "unbounded",
      }).pipe(Effect.timeout(Duration.seconds(2)));
      expect(fetchCount).toBe(1);
      expect(first).toBe(fetchedSnapshot);
      expect(second).toBe(first);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("supersedes stale in-flight fetches when the settings key changes", () =>
    Effect.gen(function* () {
      const firstFetchStarted = yield* Deferred.make<void>();
      const releaseFirstFetch = yield* Deferred.make<void>();
      const firstFetchCompleted = yield* Deferred.make<void>();
      const staleSnapshot = snapshot({ provider: "claude", updatedAt: 201 });
      const freshSnapshot = snapshot({ provider: "claude", updatedAt: 202 });
      let freshFetchCount = 0;
      const staleFetch = Effect.gen(function* () {
        yield* Deferred.succeed(firstFetchStarted, undefined);
        yield* Deferred.await(releaseFirstFetch);
        yield* Deferred.succeed(firstFetchCompleted, undefined);
        return { snapshot: staleSnapshot };
      });
      const freshFetch = Effect.sync(() => {
        freshFetchCount += 1;
        return { snapshot: freshSnapshot };
      });

      const staleFiber = yield* __testing
        .getProviderUsageSnapshot("claude", "old-key", staleFetch)
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstFetchStarted);

      const fresh = yield* __testing.getProviderUsageSnapshot("claude", "new-key", freshFetch);
      const stale = yield* Fiber.join(staleFiber).pipe(Effect.timeout(Duration.seconds(2)));
      yield* Deferred.succeed(releaseFirstFetch, undefined);
      yield* Deferred.await(firstFetchCompleted).pipe(Effect.timeout(Duration.seconds(2)));
      yield* Effect.yieldNow;
      const cachedFresh = yield* __testing.getProviderUsageSnapshot(
        "claude",
        "new-key",
        freshFetch,
      );

      expect(fresh).toBe(freshSnapshot);
      expect(stale.status).toBe("error");
      expect(stale.message).toContain("superseded");
      expect(cachedFresh).toBe(freshSnapshot);
      expect(freshFetchCount).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("does not cache a provider fetch that completes after invalidation", () =>
    Effect.gen(function* () {
      const staleFetchStarted = yield* Deferred.make<void>();
      const releaseStaleFetch = yield* Deferred.make<void>();
      const staleFetchCompleted = yield* Deferred.make<void>();
      const staleSnapshot = snapshot({ provider: "claude", updatedAt: 301 });
      const freshSnapshot = snapshot({ provider: "claude", updatedAt: 302 });
      let freshFetchCount = 0;
      const staleFetch = Effect.gen(function* () {
        yield* Deferred.succeed(staleFetchStarted, undefined);
        yield* Deferred.await(releaseStaleFetch);
        yield* Deferred.succeed(staleFetchCompleted, undefined);
        return { snapshot: staleSnapshot };
      });
      const freshFetch = Effect.sync(() => {
        freshFetchCount += 1;
        return { snapshot: freshSnapshot };
      });

      const staleFiber = yield* __testing
        .getProviderUsageSnapshot("claude", "stable-key", staleFetch)
        .pipe(Effect.forkChild);
      yield* Deferred.await(staleFetchStarted);
      invalidateProviderUsageCache("claude");

      const fresh = yield* __testing.getProviderUsageSnapshot("claude", "stable-key", freshFetch);
      yield* Deferred.succeed(releaseStaleFetch, undefined);
      const stale = yield* Fiber.join(staleFiber).pipe(Effect.timeout(Duration.seconds(2)));
      yield* Deferred.await(staleFetchCompleted).pipe(Effect.timeout(Duration.seconds(2)));
      yield* Effect.yieldNow;
      const cachedFresh = yield* __testing.getProviderUsageSnapshot(
        "claude",
        "stable-key",
        freshFetch,
      );

      expect(fresh).toBe(freshSnapshot);
      expect(stale.status).toBe("error");
      expect(stale.message).toContain("superseded");
      expect(cachedFresh).toBe(freshSnapshot);
      expect(freshFetchCount).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("refetches when the settings key changes", () =>
    Effect.gen(function* () {
      const first = yield* getProviderUsage(DISABLED_SETTINGS);
      const otherSettings: ServerSettings = {
        ...DISABLED_SETTINGS,
        providers: {
          ...DISABLED_SETTINGS.providers,
          codex: { ...DISABLED_SETTINGS.providers.codex, homePath: "/tmp/other-codex-home" },
        },
      };
      const second = yield* getProviderUsage(otherSettings);
      expect(second).not.toBe(first);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("consumeCodexResetCredit guards", () => {
  beforeEach(() => {
    resetProviderUsageStateForTests();
  });

  effectIt.live("rejects when codex is disabled", () =>
    Effect.gen(function* () {
      const result = yield* consumeCodexResetCredit(DISABLED_SETTINGS.providers.codex);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("disabled");
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("rejects when codex is not authenticated", () =>
    Effect.gen(function* () {
      const result = yield* consumeCodexResetCredit({
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        homePath: "/tmp/zrode-usage-test-missing-codex-home",
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("not authenticated");
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("honors reset-credit consume Retry-After without repeat HTTP calls", () => {
    const requests: Array<{ readonly method: string; readonly url: string }> = [];
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push({ method: request.method, url: request.url });
        if (request.method === "GET" && request.url.endsWith("/rate-limit-reset-credits")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                credits: [{ status: "available", expires_at: "2026-07-10T00:00:00.000Z" }],
              }),
            ),
          );
        }
        if (
          request.method === "POST" &&
          request.url.endsWith("/rate-limit-reset-credits/consume")
        ) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("{}", {
                status: 429,
                headers: { "Retry-After": "120" },
              }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 })),
        );
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const codexHome = yield* makeTempCodexHomeWithAuth();
        const settings = {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          enabled: true,
          homePath: codexHome,
          shadowHomePath: "",
        };
        const first = yield* consumeCodexResetCredit(settings);
        const second = yield* consumeCodexResetCredit(settings);

        expect(first.ok).toBe(false);
        expect(first.message).toContain("rate limited");
        expect(second.ok).toBe(false);
        expect(second.message).toContain("wait a moment");
        expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServicesLayer, httpLayer)));
  });
});
