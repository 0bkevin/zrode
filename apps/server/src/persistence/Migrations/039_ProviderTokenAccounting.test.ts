import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("ProviderTokenAccounting migration", (it) => {
  it.effect("preserves rows while invalidating scan checkpoints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        INSERT INTO provider_token_entries (
          provider, entry_key, sampled_epoch_ms, tokens, model
        ) VALUES ('codex', 'event-1', 1, 42, 'gpt-5.4')
      `;
      yield* sql`
        INSERT INTO provider_token_entries (
          provider, entry_key, sampled_epoch_ms, tokens, model
        ) VALUES ('opencode', 'message-1', 2, 24, 'opencode/gpt-5.4')
      `;
      yield* sql`
        INSERT INTO provider_token_files (path, mtime_ms, size_bytes)
        VALUES ('/tmp/rollout.jsonl', 1, 2)
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 39 });
      assert.deepStrictEqual(executed, [[39, "ProviderTokenAccounting"]]);

      const rows = yield* sql<{
        readonly provider: string;
        readonly tokens: number;
        readonly cache_write_1h_tokens: number;
        readonly is_fast: number;
        readonly dedup_priority: number;
        readonly uses_long_context: number;
      }>`
        SELECT provider, tokens, cache_write_1h_tokens, is_fast, dedup_priority, uses_long_context
        FROM provider_token_entries
        ORDER BY provider
      `;
      const files = yield* sql`SELECT path FROM provider_token_files`;
      assert.deepStrictEqual(rows, [
        {
          provider: "codex",
          tokens: 42,
          cache_write_1h_tokens: 0,
          is_fast: 0,
          dedup_priority: 0,
          uses_long_context: 0,
        },
        {
          provider: "opencode",
          tokens: 24,
          cache_write_1h_tokens: 0,
          is_fast: 0,
          dedup_priority: 0,
          uses_long_context: 0,
        },
      ]);
      assert.deepStrictEqual(files, []);
    }),
  );
});
