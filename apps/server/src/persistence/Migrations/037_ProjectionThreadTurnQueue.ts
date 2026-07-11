import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_turn_queue (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      title_seed TEXT,
      source_proposed_plan_json TEXT,
      queued_at TEXT NOT NULL,
      enqueued_sequence INTEGER NOT NULL UNIQUE
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_turn_queue_thread_sequence
    ON projection_thread_turn_queue(thread_id, enqueued_sequence)
  `;
});
