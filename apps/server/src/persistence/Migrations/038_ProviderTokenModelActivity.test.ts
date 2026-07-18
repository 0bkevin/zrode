import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ProviderTokenModelActivity", (it) => {
  it.effect("adds billing fields without dropping historical token rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO provider_token_entries (provider, entry_key, sampled_epoch_ms, tokens)
        VALUES ('claude', 'existing', 1000, 42)
      `;
      yield* sql`
        INSERT INTO provider_token_files (path, mtime_ms, size_bytes)
        VALUES ('/tmp/transcript.jsonl', 1000, 100)
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 38 });
      assert.deepStrictEqual(executed, [[38, "ProviderTokenModelActivity"]]);

      const rows = yield* sql<{
        readonly tokens: number;
        readonly model: string | null;
        readonly input_tokens: number;
        readonly recorded_cost_usd: number | null;
      }>`
        SELECT tokens, model, input_tokens, recorded_cost_usd
        FROM provider_token_entries
      `;
      assert.deepStrictEqual(rows, [
        { tokens: 42, model: null, input_tokens: 0, recorded_cost_usd: null },
      ]);

      const files = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM provider_token_files
      `;
      assert.deepStrictEqual(files, [{ count: 0 }]);
    }),
  );
});
