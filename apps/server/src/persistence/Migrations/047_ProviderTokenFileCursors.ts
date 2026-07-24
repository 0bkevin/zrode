import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Persist byte-accurate JSONL parser checkpoints so append-only provider logs
 * can resume at their unconsumed tail instead of being parsed from byte zero.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE provider_token_files
    ADD COLUMN parse_offset_bytes INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE provider_token_files
    ADD COLUMN parse_state_json TEXT
  `;
  yield* sql`
    ALTER TABLE provider_token_files
    ADD COLUMN file_identity TEXT
  `;
});
