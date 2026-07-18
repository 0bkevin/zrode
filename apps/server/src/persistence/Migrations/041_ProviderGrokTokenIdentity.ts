import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Grok entries used to be identified by their line number in unified.jsonl.
 * Truncation or in-place rotation can reuse those positions, so rebuild Grok
 * rows using the semantic event identity emitted by the corrected parser.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM provider_token_entries WHERE provider = 'grok'`;
  yield* sql`DELETE FROM provider_token_files`;
});
