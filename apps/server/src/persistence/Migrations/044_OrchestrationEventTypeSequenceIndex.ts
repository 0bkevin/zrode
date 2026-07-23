import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Startup reactors replay a small subset of domain event types. Keep those
  // reads proportional to the relevant history instead of scanning large
  // streaming-message payloads on every server start.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_type_sequence
    ON orchestration_events(event_type, sequence)
  `;
});
