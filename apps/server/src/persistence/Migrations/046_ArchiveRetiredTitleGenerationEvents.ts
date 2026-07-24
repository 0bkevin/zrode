import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A short-lived Zrode build persisted `thread.title-generation-requested`
 * events. Those events were internal work requests: the resulting title is
 * already represented by `thread.meta-updated` and the thread projection.
 *
 * Keep an audit copy of the original rows. The compatibility event remains in
 * the active stream as a no-op so its sequence and stream-version high-water
 * marks are preserved. Current code must not emit this retired event type.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_retired_events (
      sequence INTEGER NOT NULL,
      event_id TEXT PRIMARY KEY,
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      retired_reason TEXT NOT NULL,
      retired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO orchestration_retired_events (
      sequence,
      event_id,
      aggregate_kind,
      stream_id,
      stream_version,
      event_type,
      occurred_at,
      command_id,
      causation_event_id,
      correlation_id,
      actor_kind,
      payload_json,
      metadata_json,
      retired_reason
    )
    SELECT
      sequence,
      event_id,
      aggregate_kind,
      stream_id,
      stream_version,
      event_type,
      occurred_at,
      command_id,
      causation_event_id,
      correlation_id,
      actor_kind,
      payload_json,
      metadata_json,
      'retired internal title-generation work request'
    FROM orchestration_events
    WHERE event_type = 'thread.title-generation-requested'
  `;
});
