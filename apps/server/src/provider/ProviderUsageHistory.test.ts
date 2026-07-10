import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderUsageSnapshot,
  type ServerProviderUsageHistoryResult,
  type ServerProviderUsageResult,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  localDayKey,
  make,
  parseClaudeTranscriptLine,
  parseCodexRolloutLine,
  parseOpenCodeMessageFile,
  USAGE_HISTORY_RETENTION_DAYS,
} from "./ProviderUsageHistory.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory(), NodeServices.layer));

/** Providers disabled so readHistory never scans this machine's real logs. */
const TEST_SETTINGS: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, enabled: false },
    codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
    opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: false },
  },
};

function snapshot(overrides: Partial<ProviderUsageSnapshot>): ProviderUsageSnapshot {
  return {
    provider: "claude",
    status: "ok",
    session: { usedPercent: 40, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 12, windowMinutes: 10_080, resetsAt: null },
    extraLimits: [],
    planLabel: null,
    extraUsage: null,
    credits: null,
    resetCredits: null,
    message: null,
    updatedAt: 0,
    ...overrides,
  };
}

function usageResult(
  ...snapshots: ReadonlyArray<ProviderUsageSnapshot>
): ServerProviderUsageResult {
  return { usage: snapshots };
}

describe("token log parsing", () => {
  it("parses a Claude transcript assistant line", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-04T20:53:16.209Z",
      requestId: "req_1",
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 25,
        },
      },
    });
    const parsed = parseClaudeTranscriptLine(line);
    assert.deepStrictEqual(parsed, {
      entryKey: "msg_1:req_1",
      epochMs: Date.parse("2026-07-04T20:53:16.209Z"),
      tokens: 200,
    });
  });

  it("rejects Claude lines without assistant usage", () => {
    assert.isNull(parseClaudeTranscriptLine('{"type":"user","message":{"content":"hi"}}'));
    assert.isNull(parseClaudeTranscriptLine("not json"));
    assert.isNull(
      parseClaudeTranscriptLine(
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-04T20:53:16.209Z",
          message: { id: "msg_1", usage: { input_tokens: 0, output_tokens: 0 } },
        }),
      ),
    );
  });

  it("parses a Codex rollout token_count line", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-01T18:26:25.971Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 100_000 },
          last_token_usage: { input_tokens: 14_475, output_tokens: 321, total_tokens: 14_796 },
        },
      },
    });
    const parsed = parseCodexRolloutLine(line, "rollout-a.jsonl", 7);
    assert.deepStrictEqual(parsed, {
      entryKey: "rollout-a.jsonl:7",
      epochMs: Date.parse("2026-07-01T18:26:25.971Z"),
      tokens: 14_796,
    });
  });

  it("rejects Codex lines without last token usage", () => {
    assert.isNull(
      parseCodexRolloutLine(
        JSON.stringify({
          timestamp: "2026-07-01T18:26:25.971Z",
          payload: { type: "token_count", info: {} },
        }),
        "rollout-a.jsonl",
        1,
      ),
    );
    assert.isNull(parseCodexRolloutLine('{"payload":{"type":"agent_message"}}', "f", 1));
  });

  it("parses an OpenCode assistant message file", () => {
    const file = JSON.stringify({
      id: "msg_1",
      role: "assistant",
      sessionID: "ses_1",
      modelID: "gemini-3-pro-preview",
      providerID: "google-vertex",
      time: { created: 1_770_416_054_123, completed: 1_770_416_060_856 },
      tokens: { input: 11_312, output: 36, reasoning: 223, cache: { read: 100, write: 50 } },
      cost: 0.025_732,
    });
    assert.deepStrictEqual(parseOpenCodeMessageFile(file), {
      entryKey: "msg_1",
      epochMs: 1_770_416_060_856,
      tokens: 11_721,
    });
  });

  it("rejects OpenCode non-assistant or token-less messages", () => {
    assert.isNull(
      parseOpenCodeMessageFile(JSON.stringify({ id: "m", role: "user", time: { created: 1 } })),
    );
    assert.isNull(
      parseOpenCodeMessageFile(
        JSON.stringify({ id: "m", role: "assistant", time: { created: 1 } }),
      ),
    );
    assert.isNull(parseOpenCodeMessageFile("not json"));
  });
});

// ── Real-scanner integration (temp homes, file-backed sqlite) ────────

function claudeLine(input: {
  readonly messageId: string;
  readonly requestId: string;
  readonly timestamp: string;
  readonly tokens: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    requestId: input.requestId,
    message: { id: input.messageId, usage: { input_tokens: input.tokens, output_tokens: 0 } },
  });
}

function codexLine(input: { readonly timestamp: string; readonly tokens: number }): string {
  return JSON.stringify({
    timestamp: input.timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { total_tokens: input.tokens } },
    },
  });
}

describe("token log scanning (integration)", () => {
  it.live(
    "scans temp homes, rescans appended files, and dedupes replays",
    () => {
      // Captured in the outer scope so the restore below always runs, even if
      // an assertion inside the generator throws.
      const previousXdg = process.env.XDG_DATA_HOME;
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "zrode-usage-scan-" });
        const claudeHome = path.join(root, "claude-home");
        const codexHome = path.join(root, "codex-home");
        const claudeProject = path.join(claudeHome, ".claude", "projects", "proj");
        const codexSessions = path.join(codexHome, "sessions", "2026", "07");
        yield* fs.makeDirectory(claudeProject, { recursive: true });
        yield* fs.makeDirectory(codexSessions, { recursive: true });
        const claudeFile = path.join(claudeProject, "session-a.jsonl");
        const codexFile = path.join(codexSessions, "rollout-x.jsonl");
        // OpenCode resolves its store from XDG_DATA_HOME; point it at the temp
        // root and restore afterwards so no real machine data is scanned.
        process.env.XDG_DATA_HOME = root;
        const opencodeMessages = path.join(root, "opencode", "storage", "message", "ses_1");
        yield* fs.makeDirectory(opencodeMessages, { recursive: true });
        const dbPath = path.join(root, "history.sqlite");

        const settings: ServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            claudeAgent: {
              ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
              homePath: claudeHome,
            },
            codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: codexHome },
            opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: true },
          },
        };

        // Recent timestamps so entries sit inside the retention window.
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const t1 = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 2 * 60 * 60_000));
        const t2 = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 60 * 60_000));
        const opencodeMessage = (id: string, tokens: number) =>
          JSON.stringify({
            id,
            role: "assistant",
            time: { created: nowMs - 90 * 60_000, completed: nowMs - 89 * 60_000 },
            tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          });

        yield* fs.writeFileString(
          claudeFile,
          [
            claudeLine({ messageId: "msg_1", requestId: "req_1", timestamp: t1, tokens: 100 }),
            '{"type":"user","message":{"content":"hi"}}',
            "corrupt {not json",
            claudeLine({ messageId: "msg_2", requestId: "req_2", timestamp: t2, tokens: 200 }),
            "",
          ].join("\n"),
        );
        yield* fs.writeFileString(codexFile, `${codexLine({ timestamp: t1, tokens: 500 })}\n`);
        yield* fs.writeFileString(
          path.join(opencodeMessages, "msg_o1.json"),
          opencodeMessage("msg_o1", 700),
        );

        const runScan = Effect.gen(function* () {
          yield* runMigrations();
          const history = yield* make;
          let result = yield* history.readHistory({ days: 400, rescan: true }, settings);
          for (let i = 0; i < 300; i += 1) {
            if (!result.isBackfilling && result.lastScanAt !== null) break;
            yield* Effect.sleep(100);
            result = yield* history.readHistory({ days: 400 }, settings);
          }
          return result;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        const total = (provider: string, result: ServerProviderUsageHistoryResult): number =>
          result.tokenActivity
            .filter((entry) => entry.provider === provider)
            .reduce((sum, entry) => sum + entry.tokens, 0);

        const first = yield* runScan;
        assert.strictEqual(total("claude", first), 300);
        assert.strictEqual(total("codex", first), 500);
        assert.strictEqual(total("opencode", first), 700);
        assert.strictEqual(first.today, localDayKey(nowMs));

        // Append a replayed message (same ids — must dedupe) plus a new one,
        // and add a new immutable OpenCode message file.
        const existing = yield* fs.readFileString(claudeFile);
        yield* fs.writeFileString(
          claudeFile,
          existing +
            [
              claudeLine({ messageId: "msg_1", requestId: "req_1", timestamp: t1, tokens: 100 }),
              claudeLine({ messageId: "msg_3", requestId: "req_3", timestamp: t2, tokens: 50 }),
              "",
            ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(opencodeMessages, "msg_o2.json"),
          opencodeMessage("msg_o2", 200),
        );

        const second = yield* runScan;
        assert.strictEqual(total("claude", second), 350);
        assert.strictEqual(total("codex", second), 500);
        // 700 (already parsed, immutable) + 200 (new file) — no double count.
        assert.strictEqual(total("opencode", second), 900);

        yield* fs.remove(root, { recursive: true });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previousXdg;
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
    },
    { timeout: 60_000 },
  );
});

// The suite shares one in-memory database; each test resets the tables.
const freshTables = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM provider_usage_history`;
  yield* sql`DELETE FROM provider_token_entries`;
  yield* sql`DELETE FROM provider_token_files`;
});

layer("ProviderUsageHistory", (it) => {
  it.effect("records ok snapshots and aggregates them per provider per day", () =>
    Effect.gen(function* () {
      yield* freshTables;
      const history = yield* make;
      const base = DateTime.toEpochMillis(yield* DateTime.now);

      yield* history.record(
        usageResult(
          snapshot({
            provider: "claude",
            session: { usedPercent: 40, windowMinutes: 300, resetsAt: null },
            updatedAt: base,
          }),
          snapshot({
            provider: "codex",
            session: { usedPercent: 15, windowMinutes: 300, resetsAt: null },
            weekly: { usedPercent: 5, windowMinutes: 10_080, resetsAt: null },
            updatedAt: base,
          }),
          snapshot({
            provider: "grok",
            session: null,
            weekly: {
              label: "Monthly allowance",
              usedPercent: 25,
              windowMinutes: 44_640,
              resetsAt: null,
            },
            updatedAt: base,
          }),
        ),
      );
      yield* history.record(
        usageResult(
          snapshot({
            provider: "claude",
            session: { usedPercent: 80, windowMinutes: 300, resetsAt: null },
            weekly: { usedPercent: 20, windowMinutes: 10_080, resetsAt: null },
            updatedAt: base + 60_000,
          }),
        ),
      );

      const result = yield* history.readHistory({ days: 30 }, TEST_SETTINGS);
      assert.strictEqual(result.retentionDays, USAGE_HISTORY_RETENTION_DAYS);

      const claudeDays = result.days.filter((day) => day.provider === "claude");
      const codexDays = result.days.filter((day) => day.provider === "codex");
      const grokDays = result.days.filter((day) => day.provider === "grok");
      // Both samples land within a minute, so at most two local days are hit
      // (midnight edge); peak must surface the 80% sample either way.
      assert.ok(claudeDays.length >= 1 && claudeDays.length <= 2);
      assert.strictEqual(Math.max(...claudeDays.map((day) => day.peakSessionPercent ?? 0)), 80);
      assert.strictEqual(
        claudeDays.reduce((total, day) => total + day.sampleCount, 0),
        2,
      );
      assert.strictEqual(codexDays.length, 1);
      assert.strictEqual(codexDays[0]!.peakSessionPercent, 15);
      assert.strictEqual(grokDays.length, 1);
      assert.strictEqual(grokDays[0]!.peakWeeklyPercent, 25);
    }),
  );

  it.effect("dedupes repeated snapshots and skips non-ok ones", () =>
    Effect.gen(function* () {
      yield* freshTables;
      const history = yield* make;
      const sql = yield* SqlClient.SqlClient;
      const base = DateTime.toEpochMillis(yield* DateTime.now);

      const repeated = usageResult(
        snapshot({ provider: "claude", updatedAt: base }),
        snapshot({
          provider: "codex",
          status: "unauthenticated",
          session: null,
          weekly: null,
          updatedAt: base,
        }),
      );
      yield* history.record(repeated);
      yield* history.record(repeated);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM provider_usage_history
      `;
      assert.strictEqual(rows[0]!.count, 1);
    }),
  );

  // The day-aggregation query intentionally has no index assertion: its
  // range covers ~the whole (retention-bounded) table, so a scan is the
  // optimal plan. The timestamp index exists for the *selective* retention
  // delete, which usually matches few or no rows.
  it.effect("retention delete can use the timestamp index", () =>
    Effect.gen(function* () {
      yield* freshTables;
      const sql = yield* SqlClient.SqlClient;
      for (let i = 0; i < 64; i += 1) {
        yield* sql`
          INSERT INTO provider_token_entries (provider, entry_key, sampled_epoch_ms, tokens)
          VALUES ('claude', ${`k${i}`}, ${1_000_000 + i * 86_400_000}, 1)
        `;
      }
      yield* sql`ANALYZE`;
      const deletePlans = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        DELETE FROM provider_token_entries WHERE sampled_epoch_ms < 5
      `;
      const deleteDetail = deletePlans.map((row) => row.detail).join(" | ");
      assert.include(deleteDetail, "idx_provider_token_entries_sampled_at");
    }),
  );

  it.effect("prunes samples older than the retention window", () =>
    Effect.gen(function* () {
      yield* freshTables;
      const history = yield* make;
      const sql = yield* SqlClient.SqlClient;
      const base = DateTime.toEpochMillis(yield* DateTime.now);
      const ancient = base - (USAGE_HISTORY_RETENTION_DAYS + 10) * 24 * 60 * 60_000;

      yield* sql`
        INSERT INTO provider_usage_history (provider, sampled_at, session_used_percent, weekly_used_percent)
        VALUES ('claude', ${ancient}, 50, 10)
      `;
      yield* history.record(usageResult(snapshot({ provider: "claude", updatedAt: base })));

      const rows = yield* sql<{ readonly sampled_at: number }>`
        SELECT sampled_at FROM provider_usage_history
      `;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.sampled_at, base);
    }),
  );

  it.effect("aggregates token entries per provider per day, deduped by entry key", () =>
    Effect.gen(function* () {
      yield* freshTables;
      const history = yield* make;
      const sql = yield* SqlClient.SqlClient;
      const base = DateTime.toEpochMillis(yield* DateTime.now);
      const day = localDayKey(base);

      for (const [key, tokens] of [
        ["msg_1:req_1", 100],
        ["msg_1:req_1", 999], // duplicate key from a resumed session — ignored
        ["msg_2:req_2", 50],
      ] as const) {
        yield* sql`
          INSERT OR IGNORE INTO provider_token_entries (provider, entry_key, sampled_epoch_ms, tokens)
          VALUES ('claude', ${key}, ${base}, ${tokens})
        `;
      }
      yield* sql`
        INSERT OR IGNORE INTO provider_token_entries (provider, entry_key, sampled_epoch_ms, tokens)
        VALUES ('codex', 'rollout-a.jsonl:1', ${base}, 14796)
      `;

      const result = yield* history.readHistory({ days: 7 }, TEST_SETTINGS);
      assert.deepStrictEqual(
        result.tokenActivity.filter((entry) => entry.provider === "claude"),
        [{ day, provider: "claude", tokens: 150 }],
      );
      assert.deepStrictEqual(
        result.tokenActivity.filter((entry) => entry.provider === "codex"),
        [{ day, provider: "codex", tokens: 14_796 }],
      );
    }),
  );
});
