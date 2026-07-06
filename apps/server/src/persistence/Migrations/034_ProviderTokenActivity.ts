import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Scan state per provider log file (Claude transcripts / Codex rollouts):
  // a file is re-parsed only when its mtime or size changes.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_token_files (
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL
    ) WITHOUT ROWID
  `;

  // One row per token-bearing log entry. `entry_key` is stable across
  // re-parses (Claude: message id + request id; Codex: rollout file name —
  // which embeds a UUID — + line number), so INSERT OR IGNORE dedupes
  // resumed/forked sessions that replay history. Rows outlive their source
  // file on purpose: the CLIs prune old logs, but the usage they recorded
  // still happened. Timestamps are raw epoch ms; calendar-day bucketing
  // happens at query time so a timezone change re-buckets consistently.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_token_entries (
      provider TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      sampled_epoch_ms INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      PRIMARY KEY (provider, entry_key)
    ) WITHOUT ROWID
  `;

  // The hot queries (day aggregation, retention pruning) filter on the raw
  // timestamp with no provider constraint, so the index leads with it.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_token_entries_sampled_at
    ON provider_token_entries(sampled_epoch_ms)
  `;
});
