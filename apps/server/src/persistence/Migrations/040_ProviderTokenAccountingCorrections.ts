import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Codex output rows previously included reasoning twice and did not retain
 * cache writes. Those derived rows cannot be corrected without their source
 * rollouts, so invalidate them and the scan cache for a clean reconstruction.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM provider_token_entries WHERE provider = 'codex'`;
  yield* sql`DELETE FROM provider_token_files`;
});
