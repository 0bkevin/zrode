import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_ArchiveRetiredTitleGenerationEvents", (it) => {
  it.effect("archives retired work requests without changing the active stream", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'retired-title-request',
            'thread',
            'thread-1',
            1,
            'thread.title-generation-requested',
            '2026-06-02T20:23:37.717Z',
            'server',
            '{"threadId":"thread-1","message":"hello","titleSeed":"hello","createdAt":"2026-06-02T20:23:37.717Z"}',
            '{}'
          ),
          (
            'active-thread-created',
            'thread',
            'thread-2',
            1,
            'thread.created',
            '2026-06-02T20:23:38.000Z',
            'client',
            '{}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 46 });

      const active = yield* sql<{
        readonly eventId: string;
        readonly eventType: string;
      }>`
        SELECT event_id AS "eventId", event_type AS "eventType"
        FROM orchestration_events
        ORDER BY sequence
      `;
      assert.deepEqual(active, [
        {
          eventId: "retired-title-request",
          eventType: "thread.title-generation-requested",
        },
        {
          eventId: "active-thread-created",
          eventType: "thread.created",
        },
      ]);

      const retired = yield* sql<{
        readonly eventId: string;
        readonly eventType: string;
        readonly payload: string;
        readonly reason: string;
      }>`
        SELECT
          event_id AS "eventId",
          event_type AS "eventType",
          payload_json AS "payload",
          retired_reason AS "reason"
        FROM orchestration_retired_events
      `;
      assert.equal(retired.length, 1);
      assert.equal(retired[0]?.eventId, "retired-title-request");
      assert.equal(retired[0]?.eventType, "thread.title-generation-requested");
      assert.include(retired[0]?.payload ?? "", '"titleSeed":"hello"');
      assert.equal(retired[0]?.reason, "retired internal title-generation work request");
    }),
  );
});
