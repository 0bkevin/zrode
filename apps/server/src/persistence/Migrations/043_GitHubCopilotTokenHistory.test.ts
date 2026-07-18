import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("GitHubCopilotTokenHistory migration", (it) => {
  it.effect("invalidates Copilot and OpenCode derived rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO provider_token_entries (provider, entry_key, sampled_epoch_ms, tokens)
        VALUES
          ('opencode', 'old-opencode', 1, 1),
          ('githubCopilot', 'old-copilot', 1, 1),
          ('claude', 'claude-entry', 1, 1)
      `;
      const executed = yield* runMigrations({ toMigrationInclusive: 43 });
      const entries = yield* sql<{ readonly provider: string }>`
        SELECT provider FROM provider_token_entries ORDER BY provider
      `;
      assert.deepStrictEqual(executed, [[43, "GitHubCopilotTokenHistory"]]);
      assert.deepStrictEqual(entries, [{ provider: "claude" }]);
    }),
  );
});
