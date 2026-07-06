import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per provider usage snapshot the server fetched. `sampled_at` is
  // the snapshot's own `updatedAt` (epoch ms), so re-serving a cached snapshot
  // dedupes via the primary key instead of writing a duplicate sample.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_usage_history (
      provider TEXT NOT NULL,
      sampled_at INTEGER NOT NULL,
      session_used_percent REAL,
      weekly_used_percent REAL,
      PRIMARY KEY (provider, sampled_at)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_usage_history_sampled_at
    ON provider_usage_history(sampled_at)
  `;
});
