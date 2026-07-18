import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("OpenCodeRecordedCloudCosts migration", (it) => {
  it.effect("invalidates OpenCode rows and scan cursors", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO provider_token_entries (provider, entry_key, sampled_epoch_ms, tokens)
        VALUES ('opencode', 'old-opencode', 1, 1), ('claude', 'claude-entry', 1, 1)
      `;
      yield* sql`
        INSERT INTO provider_token_files (path, mtime_ms, size_bytes)
        VALUES ('opencode.db', 1, 1)
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 42 });
      const entries = yield* sql<{ readonly provider: string }>`
        SELECT provider FROM provider_token_entries ORDER BY provider
      `;
      const files = yield* sql<{ readonly path: string }>`SELECT path FROM provider_token_files`;

      assert.deepStrictEqual(executed, [[42, "OpenCodeRecordedCloudCosts"]]);
      assert.deepStrictEqual(entries, [{ provider: "claude" }]);
      assert.deepStrictEqual(files, []);
    }),
  );
});
