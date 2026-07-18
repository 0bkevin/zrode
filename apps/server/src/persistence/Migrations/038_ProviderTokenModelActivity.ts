import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE provider_token_entries ADD COLUMN model TEXT`;
  yield* sql`
    ALTER TABLE provider_token_entries
    ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE provider_token_entries
    ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE provider_token_entries
    ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE provider_token_entries
    ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`ALTER TABLE provider_token_entries ADD COLUMN recorded_cost_usd REAL`;

  // Force one incremental re-read so rows created by migration 035 gain the
  // model and billing-category detail now available from their source logs.
  // Token rows themselves remain intact and the scanner upserts each stable
  // entry key, so an interrupted refresh cannot lose historical totals.
  yield* sql`DELETE FROM provider_token_files`;
});
