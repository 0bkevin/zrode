import { CommandId, EventId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* sql`
        INSERT INTO orchestration_events (
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
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("paginates filtered replay without decoding unrelated event payloads", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

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
        VALUES (
          ${"evt-store-filtered-invalid"},
          ${"thread"},
          ${"thread-filtered-invalid"},
          ${0},
          ${"thread.message-sent"},
          ${now},
          ${"provider"},
          ${"{"},
          ${"{}"}
        )
      `;
      yield* sql`
        WITH RECURSIVE event_numbers(value) AS (
          VALUES (1)
          UNION ALL
          SELECT value + 1 FROM event_numbers WHERE value < 520
        )
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
        SELECT
          'evt-store-filtered-' || value,
          'project',
          'project-filtered',
          value,
          'project.deleted',
          ${now},
          'server',
          '{"projectId":"project-filtered","deletedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        FROM event_numbers
      `;

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(0, 510, ["project.deleted"]),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));

      assert.equal(replayed.length, 510);
      assert.equal(replayed[0]?.type, "project.deleted");
      assert.equal(replayed[509]!.sequence - replayed[0]!.sequence, 509);
    }),
  );

  it.effect(
    "filters thread activity kinds in SQL while preserving other selected event types",
    () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("thread-activity-filter");
        const turnId = TurnId.make("turn-activity-filter");

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
        VALUES (
          ${"evt-store-unrelated-invalid-activity"},
          ${"thread"},
          ${threadId},
          ${0},
          ${"thread.activity-appended"},
          ${now},
          ${"provider"},
          ${"{"},
          ${"{}"}
        )
      `;

        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-store-turn-completed-activity"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-store-turn-completed-activity"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-store-turn-completed"),
              tone: "info",
              kind: "turn.completed",
              summary: "Turn completed",
              payload: { state: "completed" },
              turnId,
              createdAt: now,
            },
          },
        });

        yield* eventStore.append({
          type: "thread.turn-quiesced",
          eventId: EventId.make("evt-store-turn-quiesced"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-store-turn-quiesced"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId,
            turnId,
            quiescedAt: now,
          },
        });

        yield* sql`
        WITH RECURSIVE event_numbers(value) AS (
          VALUES (1)
          UNION ALL
          SELECT value + 1 FROM event_numbers WHERE value < 520
        )
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
        SELECT
          'evt-store-paged-completion-' || value,
          'thread',
          ${threadId},
          value + 2,
          'thread.activity-appended',
          ${now},
          'provider',
          json_object(
            'threadId', ${threadId},
            'activity', json_object(
              'id', 'activity-store-paged-completion-' || value,
              'tone', 'info',
              'kind', 'turn.completed',
              'summary', 'Turn completed',
              'payload', json_object('state', 'completed'),
              'turnId', 'turn-store-paged-completion-' || value,
              'createdAt', ${now}
            )
          ),
          '{}'
        FROM event_numbers
      `;

        const replayed = yield* Stream.runCollect(
          eventStore.readFromSequence(
            0,
            Number.MAX_SAFE_INTEGER,
            ["thread.activity-appended", "thread.turn-quiesced"],
            ["turn.completed"],
          ),
        ).pipe(Effect.map((chunk) => Array.from(chunk)));

        assert.deepEqual(
          replayed.slice(0, 2).map((event) => event.type),
          ["thread.activity-appended", "thread.turn-quiesced"],
        );
        assert.equal(replayed.length, 522);
        assert.equal(
          replayed[0]?.type === "thread.activity-appended"
            ? replayed[0].payload.activity.kind
            : undefined,
          "turn.completed",
        );

        const withoutActivities = yield* Stream.runCollect(
          eventStore.readFromSequence(
            0,
            Number.MAX_SAFE_INTEGER,
            ["thread.activity-appended", "thread.turn-quiesced"],
            [],
          ),
        ).pipe(Effect.map((chunk) => Array.from(chunk)));
        assert.deepEqual(
          withoutActivities.map((event) => event.type),
          ["thread.turn-quiesced"],
        );
      }),
  );
});
