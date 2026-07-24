import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("ProviderTokenFileCursors migration", (it) => {
  it.effect("adds lossless parser checkpoints without invalidating existing fingerprints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`
        INSERT INTO provider_token_files (path, mtime_ms, size_bytes)
        VALUES ('rollout.jsonl', 10, 20)
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 47 });
      const rows = yield* sql<{
        readonly path: string;
        readonly mtime_ms: number;
        readonly size_bytes: number;
        readonly parse_offset_bytes: number;
        readonly parse_state_json: string | null;
        readonly file_identity: string | null;
      }>`
        SELECT
          path,
          mtime_ms,
          size_bytes,
          parse_offset_bytes,
          parse_state_json,
          file_identity
        FROM provider_token_files
      `;

      assert.deepStrictEqual(executed, [[47, "ProviderTokenFileCursors"]]);
      assert.deepStrictEqual(rows, [
        {
          path: "rollout.jsonl",
          mtime_ms: 10,
          size_bytes: 20,
          parse_offset_bytes: 0,
          parse_state_json: null,
          file_identity: null,
        },
      ]);
    }),
  );
});
