import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
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
  parseClaudeTranscriptEntries,
  parseCodexRolloutFile,
  parseCodexRolloutLine,
  parseCodexTurnContextModel,
  parseGrokUnifiedLog,
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
    grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: false },
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
        model: "claude-sonnet-5",
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
      entryKey: '["request","msg_1","req_1"]',
      epochMs: Date.parse("2026-07-04T20:53:16.209Z"),
      tokens: 200,
      model: "claude-sonnet-5",
      inputTokens: 100,
      cachedInputTokens: 25,
      cacheWriteTokens: 25,
      cacheWrite1hTokens: 0,
      outputTokens: 50,
      recordedCostUsd: null,
      isFast: false,
      usesLongContext: false,
      dedupPriority: 800,
      claudeDedup: { groupKey: "msg_1", requestId: "req_1", isSidechain: false },
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

  it("keeps Claude cache duration, fast tier, carried cost, and advisor usage", () => {
    const entries = parseClaudeTranscriptEntries(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-04T20:53:16.209Z",
        costUSD: 0.42,
        message: {
          id: "msg_rich",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            speed: "fast",
            cache_creation: {
              ephemeral_5m_input_tokens: 30,
              ephemeral_1h_input_tokens: 40,
            },
            cache_read_input_tokens: 50,
            iterations: [
              {
                type: "advisor_message",
                model: "claude-haiku-4-5",
                input_tokens: 2,
                output_tokens: 3,
              },
            ],
          },
        },
      }),
    );
    assert.lengthOf(entries, 2);
    assert.include(entries[0], {
      tokens: 150,
      cacheWriteTokens: 30,
      cacheWrite1hTokens: 40,
      recordedCostUsd: 0.42,
      isFast: true,
    });
    assert.include(entries[1], {
      entryKey: '["request","msg_rich:advisor:0",""]',
      tokens: 5,
      model: "claude-haiku-4-5",
      recordedCostUsd: null,
    });
  });

  it("parses a Codex rollout token_count line", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-01T18:26:25.971Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 100_000 },
          last_token_usage: {
            input_tokens: 14_475,
            cached_input_tokens: 4_000,
            output_tokens: 321,
            total_tokens: 14_796,
          },
        },
      },
    });
    const parsed = parseCodexRolloutLine(line, "rollout-a.jsonl", 7, "gpt-5.3-codex");
    assert.deepStrictEqual(parsed, {
      entryKey: "rollout-a.jsonl:7",
      epochMs: Date.parse("2026-07-01T18:26:25.971Z"),
      tokens: 14_796,
      model: "gpt-5.3-codex",
      inputTokens: 10_475,
      cachedInputTokens: 4_000,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 321,
      recordedCostUsd: null,
      isFast: false,
      usesLongContext: false,
      dedupPriority: 0,
    });
  });

  it("does not double-count Codex reasoning and separates cache writes", () => {
    const parsed = parseCodexRolloutLine(
      JSON.stringify({
        timestamp: "2026-07-01T18:26:25.971Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 25,
              cache_write_input_tokens: 15,
              output_tokens: 50,
              reasoning_output_tokens: 30,
              total_tokens: 150,
            },
          },
        },
      }),
      "rollout-a.jsonl",
      8,
      "gpt-5.6-sol",
    );
    assert.include(parsed, {
      tokens: 150,
      inputTokens: 60,
      cachedInputTokens: 25,
      cacheWriteTokens: 15,
      outputTokens: 50,
    });
  });

  it("reads the active model from a Codex turn context", () => {
    assert.strictEqual(
      parseCodexTurnContextModel(
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4" } }),
      ),
      "gpt-5.4",
    );
    assert.isNull(parseCodexTurnContextModel('{"type":"event_msg","payload":{}}'));
  });

  it("recovers Codex deltas, skips stale totals, and retains priority tier", () => {
    const token = (timestamp: string, info: Record<string, unknown>) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: { type: "token_count", info },
      });
    const entries = parseCodexRolloutFile(
      [
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4" } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: { service_tier: "priority" },
          },
        }),
        token("2026-07-01T18:26:25.000Z", {
          total_token_usage: {
            input_tokens: 100,
            cache_write_input_tokens: 10,
            total_tokens: 100,
          },
          last_token_usage: {
            input_tokens: 100,
            cache_write_input_tokens: 10,
            total_tokens: 100,
          },
        }),
        token("2026-07-01T18:26:26.000Z", {
          total_token_usage: {
            input_tokens: 100,
            cache_write_input_tokens: 10,
            total_tokens: 100,
          },
          last_token_usage: {
            input_tokens: 100,
            cache_write_input_tokens: 10,
            total_tokens: 100,
          },
        }),
        token("2026-07-01T18:26:27.000Z", {
          total_token_usage: {
            input_tokens: 160,
            cache_write_input_tokens: 25,
            total_tokens: 160,
          },
        }),
      ].join("\n"),
    );
    assert.deepStrictEqual(
      entries.map((entry) => [entry.tokens, entry.cacheWriteTokens, entry.isFast]),
      [
        [100, 10, true],
        [60, 15, true],
      ],
    );
  });

  it("resets Codex priority when a complete settings snapshot clears the tier", () => {
    const token = (timestamp: string, input: number) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: input, total_tokens: input },
            total_token_usage: { input_tokens: input, total_tokens: input },
          },
        },
      });
    const entries = parseCodexRolloutFile(
      [
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "thread_settings_applied", service_tier: "priority" },
        }),
        token("2026-07-01T18:26:25.000Z", 10),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_settings: {} },
        }),
        token("2026-07-01T18:26:26.000Z", 20),
      ].join("\n"),
    );
    assert.deepStrictEqual(
      entries.map((entry) => entry.isFast),
      [true, false],
    );
  });

  it("suppresses copied parent history in a Codex child rollout", () => {
    const created = "2026-07-01T18:26:25.000Z";
    const token = (timestamp: string, input: number, total: number) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: total, total_tokens: total },
            last_token_usage: { input_tokens: input, total_tokens: input },
          },
        },
      });
    const entries = parseCodexRolloutFile(
      [
        JSON.stringify({
          timestamp: created,
          type: "session_meta",
          payload: { thread_source: "subagent" },
        }),
        token("2026-07-01T18:26:26.000Z", 100, 100),
        JSON.stringify({
          timestamp: "2026-07-01T18:26:27.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            started_at: Math.floor(Date.parse(created) / 1_000) + 2,
          },
        }),
        token("2026-07-01T18:26:28.000Z", 50, 150),
      ].join("\n"),
    );
    assert.deepStrictEqual(
      entries.map((entry) => entry.tokens),
      [50],
    );
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
      providerID: "opencode",
      time: { created: 1_770_416_054_123, completed: 1_770_416_060_856 },
      tokens: { input: 11_312, output: 36, reasoning: 223, cache: { read: 100, write: 50 } },
      cost: 0.025_732,
    });
    assert.deepStrictEqual(parseOpenCodeMessageFile(file), {
      entryKey: "msg_1",
      epochMs: 1_770_416_060_856,
      tokens: 11_721,
      model: "opencode/gemini-3-pro-preview",
      inputTokens: 11_312,
      cachedInputTokens: 100,
      cacheWriteTokens: 50,
      cacheWrite1hTokens: 0,
      outputTokens: 259,
      recordedCostUsd: 0.025_732,
      isFast: false,
      usesLongContext: false,
      dedupPriority: 0,
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

  it("does not treat BYO OpenCode zero-cost placeholders as authoritative", () => {
    const parsed = parseOpenCodeMessageFile(
      JSON.stringify({
        id: "msg_byo",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
        cost: 0,
        time: { created: 100 },
        tokens: { total: 12, input: 10, output: 2 },
      }),
    );
    assert.strictEqual(parsed?.tokens, 12);
    assert.isNull(parsed?.recordedCostUsd);
  });

  it("marks BYO OpenCode requests with provider-specific long-context tiers", () => {
    const claude = parseOpenCodeMessageFile(
      JSON.stringify({
        id: "msg_claude_long",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
        time: { created: 100 },
        tokens: { input: 200_001, output: 1 },
      }),
    );
    const openAiBoundary = parseOpenCodeMessageFile(
      JSON.stringify({
        id: "msg_openai_boundary",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        time: { created: 100 },
        tokens: { input: 272_000, output: 1 },
      }),
    );
    const openAiLong = parseOpenCodeMessageFile(
      JSON.stringify({
        id: "msg_openai_long",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        time: { created: 100 },
        tokens: { input: 272_001, output: 1 },
      }),
    );
    assert.isTrue(claude?.usesLongContext);
    assert.isFalse(openAiBoundary?.usesLongContext);
    assert.isTrue(openAiLong?.usesLongContext);
  });

  it("attributes Grok token rows to the active model for each process", () => {
    const entries = parseGrokUnifiedLog(
      [
        JSON.stringify({ pid: 7, msg: "model changed", ctx: { model: "grok-code-fast-1" } }),
        JSON.stringify({
          pid: 7,
          ts: "2026-07-01T18:26:25.000Z",
          msg: "shell.turn.inference_done",
          ctx: {
            prompt_tokens: 100,
            cached_prompt_tokens: 20,
            completion_tokens: 10,
            reasoning_tokens: 5,
            cost_in_usd_ticks: "250000000",
          },
        }),
      ].join("\n"),
    );
    assert.include(entries[0], {
      tokens: 115,
      model: "grok-code-fast-1",
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 15,
      recordedCostUsd: 0.025,
    });
  });

  it("retains Grok output-only events and gives them a semantic identity", () => {
    const entries = parseGrokUnifiedLog(
      [
        JSON.stringify({ pid: 9, msg: "model changed", ctx: { model: "grok-4.3" } }),
        JSON.stringify({
          pid: 9,
          ts: "2026-07-01T18:26:25.000Z",
          msg: "shell.turn.inference_done",
          ctx: { prompt_tokens: 0, completion_tokens: 10, reasoning_tokens: 5 },
        }),
      ].join("\n"),
    );

    assert.strictEqual(entries.length, 1);
    assert.include(entries[0], {
      tokens: 15,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 15,
    });
    assert.strictEqual(
      entries[0]?.entryKey,
      JSON.stringify([
        "inference",
        Date.parse("2026-07-01T18:26:25.000Z"),
        9,
        "grok-4.3",
        0,
        0,
        15,
        null,
      ]),
    );
  });

  it("retains an exact Grok charge when model attribution is unavailable", () => {
    const entries = parseGrokUnifiedLog(
      JSON.stringify({
        pid: 11,
        ts: "2026-07-01T18:26:25.000Z",
        msg: "shell.turn.inference_done",
        ctx: {
          prompt_tokens: 0,
          usage: { cost_in_usd_ticks: 1_000_000_000 },
        },
      }),
    );

    assert.strictEqual(entries.length, 1);
    assert.include(entries[0], { model: null, tokens: 0, recordedCostUsd: 0.1 });
  });
});

// ── Real-scanner integration (temp homes, file-backed sqlite) ────────

function claudeLine(input: {
  readonly messageId: string;
  readonly requestId: string;
  readonly timestamp: string;
  readonly tokens: number;
  readonly isSidechain?: boolean;
  readonly model?: string;
  readonly costUsd?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    requestId: input.requestId,
    isSidechain: input.isSidechain,
    costUSD: input.costUsd,
    message: {
      id: input.messageId,
      model: input.model ?? "claude-sonnet-5",
      usage: { input_tokens: input.tokens, output_tokens: 0 },
    },
  });
}

function codexLine(input: { readonly timestamp: string; readonly tokens: number }): string {
  return JSON.stringify({
    timestamp: input.timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: input.tokens, total_tokens: input.tokens },
        last_token_usage: { input_tokens: input.tokens, total_tokens: input.tokens },
      },
    },
  });
}

function codexTurnContext(): string {
  return JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4" } });
}

function openCodeHostedDatabaseMessage(): string {
  return JSON.stringify({
    role: "assistant",
    providerID: "opencode-go",
    modelID: "gpt-5.4",
    cost: 0.02,
    tokens: { total: 300, input: 250, output: 50 },
  });
}

function openCodeIncompleteMessage(id: string, createdAt: number): string {
  return JSON.stringify({ id, role: "assistant", time: { created: createdAt } });
}

function openCodeWalDatabaseMessage(): string {
  return JSON.stringify({
    role: "assistant",
    providerID: "opencode-go",
    modelID: "gpt-5.4",
    cost: 0.01,
    tokens: { total: 100, input: 100, output: 0 },
  });
}

describe("token log scanning (integration)", () => {
  it.live(
    "scans temp homes, rescans appended files, and dedupes replays",
    () => {
      // Captured in the outer scope so the restore below always runs, even if
      // an assertion inside the generator throws.
      const previousXdg = process.env.XDG_DATA_HOME;
      const previousGrokHome = process.env.GROK_HOME;
      let opencodeDatabase: NodeSqlite.DatabaseSync | null = null;
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
        process.env.GROK_HOME = path.join(root, "grok-home");
        const opencodeMessages = path.join(root, "opencode", "storage", "message", "ses_1");
        yield* fs.makeDirectory(opencodeMessages, { recursive: true });
        const opencodeDbPath = path.join(root, "opencode", "opencode.db");
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
            grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: false },
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
            modelID: "glm-5",
            providerID: "opencode",
            cost: 0.01,
            time: { created: nowMs - 90 * 60_000, completed: nowMs - 89 * 60_000 },
            tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          });

        yield* fs.writeFileString(
          claudeFile,
          [
            claudeLine({
              messageId: "msg_1",
              requestId: "req_1",
              timestamp: t1,
              tokens: 100,
              costUsd: 0.2,
            }),
            '{"type":"user","message":{"content":"hi"}}',
            "corrupt {not json",
            claudeLine({ messageId: "msg_2", requestId: "req_2", timestamp: t2, tokens: 200 }),
            // Same message id, distinct real request ids: both are billable.
            claudeLine({ messageId: "msg_shared", requestId: "req_a", timestamp: t2, tokens: 30 }),
            claudeLine({ messageId: "msg_shared", requestId: "req_b", timestamp: t2, tokens: 40 }),
            // A sidechain can arrive first, but the real parent must replace it.
            claudeLine({
              messageId: "msg_side",
              requestId: "req_side",
              timestamp: t2,
              tokens: 70,
              isSidechain: true,
            }),
            claudeLine({
              messageId: "msg_side",
              requestId: "req_parent",
              timestamp: t2,
              tokens: 60,
            }),
            // Exact carried spend must survive even without a model attribution.
            claudeLine({
              messageId: "msg_synthetic",
              requestId: "req_synthetic",
              timestamp: t2,
              tokens: 15,
              model: "<synthetic>",
              costUsd: 0.1,
            }),
            "",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          codexFile,
          `${codexTurnContext()}\n${codexLine({ timestamp: t1, tokens: 500 })}\n`,
        );
        yield* fs.writeFileString(
          path.join(opencodeMessages, "msg_o1.json"),
          opencodeMessage("msg_o1", 700),
        );
        const pendingMessagePath = path.join(opencodeMessages, "msg_pending.json");
        yield* fs.writeFileString(
          pendingMessagePath,
          openCodeIncompleteMessage("msg_pending", nowMs - 70 * 60_000),
        );
        yield* Effect.sync(() => {
          const database = new NodeSqlite.DatabaseSync(opencodeDbPath);
          database.exec("PRAGMA journal_mode = WAL");
          database.exec(
            "CREATE TABLE message (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL, data TEXT NOT NULL)",
          );
          database
            .prepare("INSERT INTO message (id, time_created, data) VALUES (?, ?, ?)")
            .run("msg_db", nowMs - 80 * 60_000, openCodeHostedDatabaseMessage());
          opencodeDatabase = database;
        });

        let seedLegacyRows = true;
        const runScan = Effect.gen(function* () {
          yield* runMigrations();
          if (seedLegacyRows) {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
              INSERT INTO provider_token_entries (
                provider, entry_key, sampled_epoch_ms, tokens
              ) VALUES ('claude', 'msg_1:req_1', ${nowMs}, 100)
            `;
            yield* sql`
              INSERT INTO provider_token_entries (
                provider, entry_key, sampled_epoch_ms, tokens
              ) VALUES ('codex', 'rollout-x.jsonl:2', ${nowMs}, 500)
            `;
            seedLegacyRows = false;
          }
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
        assert.strictEqual(total("claude", first), 445);
        assert.strictEqual(total("codex", first), 500);
        assert.strictEqual(total("opencode", first), 1_000);
        assert.deepStrictEqual(
          [
            ...new Map(
              first.modelActivity.map((entry) => [
                `${entry.provider}:${entry.model}`,
                [entry.provider, entry.model],
              ]),
            ).values(),
          ],
          [
            ["claude", "Unattributed"],
            ["claude", "claude-sonnet-5"],
            ["codex", "gpt-5.4"],
            ["opencode", "opencode-go/gpt-5.4"],
            ["opencode", "opencode/glm-5"],
          ],
        );
        assert.strictEqual(
          first.modelActivity.find(
            (entry) => entry.provider === "claude" && entry.model === "Unattributed",
          )?.recordedCostUsd,
          0.1,
        );
        assert.strictEqual(first.today, localDayKey(nowMs));

        // Append a replayed message (same ids — must dedupe) plus a new one,
        // and add a new immutable OpenCode message file.
        const existing = yield* fs.readFileString(claudeFile);
        yield* fs.writeFileString(
          claudeFile,
          existing +
            [
              // A richer replay can correct token counts without erasing the
              // authoritative cost carried by the earlier duplicate.
              claudeLine({ messageId: "msg_1", requestId: "req_1", timestamp: t1, tokens: 101 }),
              claudeLine({ messageId: "msg_3", requestId: "req_3", timestamp: t2, tokens: 50 }),
              "",
            ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(opencodeMessages, "msg_o2.json"),
          opencodeMessage("msg_o2", 200),
        );
        yield* fs.writeFileString(pendingMessagePath, opencodeMessage("msg_pending", 50));
        yield* Effect.sync(() => {
          opencodeDatabase
            ?.prepare("INSERT INTO message (id, time_created, data) VALUES (?, ?, ?)")
            .run("msg_db_wal", nowMs - 40 * 60_000, openCodeWalDatabaseMessage());
        });

        const second = yield* runScan;
        assert.strictEqual(total("claude", second), 496);
        assert.strictEqual(total("codex", second), 500);
        // Includes a completed legacy message and a WAL-only database insert.
        assert.strictEqual(total("opencode", second), 1_350);
        assert.strictEqual(
          second.modelActivity.find(
            (entry) =>
              entry.provider === "claude" &&
              entry.model === "claude-sonnet-5" &&
              entry.recordedCostUsd !== null,
          )?.recordedCostUsd,
          0.2,
        );

        opencodeDatabase?.close();
        opencodeDatabase = null;
        yield* fs.remove(root, { recursive: true });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            opencodeDatabase?.close();
            if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previousXdg;
            if (previousGrokHome === undefined) delete process.env.GROK_HOME;
            else process.env.GROK_HOME = previousGrokHome;
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
