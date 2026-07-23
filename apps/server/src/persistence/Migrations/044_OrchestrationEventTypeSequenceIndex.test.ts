import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("OrchestrationEventTypeSequenceIndex migration", (it) => {
  it.effect("indexes filtered event replay by type and sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      const executed = yield* runMigrations({ toMigrationInclusive: 44 });
      const indexColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_orchestration_events_type_sequence')
      `;

      assert.deepStrictEqual(executed, [[44, "OrchestrationEventTypeSequenceIndex"]]);
      assert.deepStrictEqual(
        indexColumns.map((column) => column.name),
        ["event_type", "sequence"],
      );
    }),
  );
});
