import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Crash recovery only needs durable turn-completion activities. Index the
  // JSON discriminator so startup never has to read or decode unrelated tool
  // payloads, which can account for gigabytes of historical event data.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_activity_kind_sequence
    ON orchestration_events(
      json_extract(payload_json, '$.activity.kind'),
      sequence
    )
    WHERE event_type = 'thread.activity-appended'
      AND json_valid(payload_json)
  `;
});
