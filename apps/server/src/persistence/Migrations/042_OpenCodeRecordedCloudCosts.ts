import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * OpenCode's positive per-message cost was previously discarded for direct
 * cloud providers such as Vertex, Azure, and Bedrock. Rebuild those derived
 * rows from the source database with the corrected accounting rule.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM provider_token_entries WHERE provider = 'opencode'`;
  yield* sql`DELETE FROM provider_token_files`;
});
