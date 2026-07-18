import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Rebuild OpenCode routing attribution and import native Copilot CLI history. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM provider_token_entries WHERE provider IN ('opencode', 'githubCopilot')`;
  yield* sql`DELETE FROM provider_token_files`;
});
