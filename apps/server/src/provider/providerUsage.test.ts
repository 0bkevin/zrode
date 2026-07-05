import { beforeEach, describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import type * as CodexSchema from "effect-codex-app-server/schema";

import * as ProcessRunner from "../processRunner.ts";
import {
  consumeCodexResetCredit,
  getProviderUsage,
  invalidateProviderUsageCache,
  mapCodexExtraLimits,
  normalizeResetsAt,
  parseClaudeLimits,
  parseClaudeOAuthCredentials,
  parseCodexBackendAuth,
  parseCodexResetCredits,
  resetProviderUsageStateForTests,
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
  },
};

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
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("serves the cached result on subsequent calls", () =>
    Effect.gen(function* () {
      const first = yield* getProviderUsage(DISABLED_SETTINGS);
      const second = yield* getProviderUsage(DISABLED_SETTINGS);
      expect(second).toBe(first);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.live("refetches after the cache is invalidated", () =>
    Effect.gen(function* () {
      const first = yield* getProviderUsage(DISABLED_SETTINGS);
      invalidateProviderUsageCache();
      const second = yield* getProviderUsage(DISABLED_SETTINGS);
      expect(second).not.toBe(first);
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
      expect(second).toBe(first);
      expect(third).toBe(first);
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
});
