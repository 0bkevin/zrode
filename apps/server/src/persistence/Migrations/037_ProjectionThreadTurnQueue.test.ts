import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_ProjectionThreadTurnQueue", (it) => {
  it.effect("runs after an existing migration 36 from another worktree", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (36, 'QuickChat')
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 37 });
      assert.deepStrictEqual(executed, [[37, "ProjectionThreadTurnQueue"]]);

      const migrationRows = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id = 37
      `;
      assert.deepStrictEqual(migrationRows, [
        {
          migration_id: 37,
          name: "ProjectionThreadTurnQueue",
        },
      ]);

      const tableRows = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_turn_queue'
      `;
      assert.deepStrictEqual(tableRows, [{ name: "projection_thread_turn_queue" }]);

      const indexRows = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_thread_turn_queue_thread_sequence'
      `;
      assert.deepStrictEqual(indexRows, [
        { name: "idx_projection_thread_turn_queue_thread_sequence" },
      ]);
    }),
  );
});
