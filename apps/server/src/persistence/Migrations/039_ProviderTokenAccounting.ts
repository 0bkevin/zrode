import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE provider_token_entries
    ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE provider_token_entries
    ADD COLUMN is_fast INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE provider_token_entries
    ADD COLUMN dedup_priority INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE provider_token_entries
    ADD COLUMN uses_long_context INTEGER NOT NULL DEFAULT 0
  `;

  // Force a re-read so the scanner can replace legacy request/file-line keys
  // with replay-safe semantic keys. It removes legacy rows only for logs it
  // can actually re-read, preserving history whose source log was pruned.
  yield* sql`DELETE FROM provider_token_files`;
});
