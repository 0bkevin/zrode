import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionQueuedTurnInput,
  DeleteProjectionQueuedTurnsByThreadInput,
  ListProjectionQueuedTurnsInput,
  ProjectionQueuedTurn,
  ProjectionQueuedTurnDbRow,
  ProjectionQueuedTurnRepository,
  type ProjectionQueuedTurnRepositoryShape,
} from "../Services/ProjectionQueuedTurns.ts";

const makeProjectionQueuedTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionQueuedTurn,
    execute: (row) => {
      const attachments = JSON.stringify(row.attachments);
      const modelSelection = JSON.stringify(row.modelSelection);
      const sourceProposedPlan =
        row.sourceProposedPlan === undefined ? null : JSON.stringify(row.sourceProposedPlan);
      return sql`
      INSERT INTO projection_thread_turn_queue (
        message_id,
        thread_id,
        text,
        attachments_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        title_seed,
        source_proposed_plan_json,
        queued_at,
        enqueued_sequence
      ) VALUES (
        ${row.messageId},
        ${row.threadId},
        ${row.text},
        ${attachments},
        ${modelSelection},
        ${row.runtimeMode},
        ${row.interactionMode},
        ${row.titleSeed ?? null},
        ${sourceProposedPlan},
        ${row.queuedAt},
        ${row.enqueuedSequence}
      )
      ON CONFLICT (message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        text = excluded.text,
        attachments_json = excluded.attachments_json,
        model_selection_json = excluded.model_selection_json,
        runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode,
        title_seed = excluded.title_seed,
        source_proposed_plan_json = excluded.source_proposed_plan_json,
        queued_at = excluded.queued_at,
        enqueued_sequence = excluded.enqueued_sequence
      `;
    },
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionQueuedTurnDbRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        message_id AS "messageId",
        text,
        attachments_json AS "attachments",
        model_selection_json AS "modelSelection",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        title_seed AS "titleSeed",
        source_proposed_plan_json AS "sourceProposedPlan",
        queued_at AS "queuedAt",
        enqueued_sequence AS "enqueuedSequence"
      FROM projection_thread_turn_queue
      ORDER BY enqueued_sequence ASC
    `,
  });

  const listRowsByThread = SqlSchema.findAll({
    Request: ListProjectionQueuedTurnsInput,
    Result: ProjectionQueuedTurnDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        message_id AS "messageId",
        text,
        attachments_json AS "attachments",
        model_selection_json AS "modelSelection",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        title_seed AS "titleSeed",
        source_proposed_plan_json AS "sourceProposedPlan",
        queued_at AS "queuedAt",
        enqueued_sequence AS "enqueuedSequence"
      FROM projection_thread_turn_queue
      WHERE thread_id = ${threadId}
      ORDER BY enqueued_sequence ASC
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteProjectionQueuedTurnInput,
    execute: ({ threadId, messageId }) => sql`
      DELETE FROM projection_thread_turn_queue
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `,
  });

  const deleteRowsByThread = SqlSchema.void({
    Request: DeleteProjectionQueuedTurnsByThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_turn_queue WHERE thread_id = ${threadId}
    `,
  });

  const mapError = toPersistenceSqlError("ProjectionQueuedTurnRepository.query");
  const toProjectionQueuedTurn = (
    row: Schema.Schema.Type<typeof ProjectionQueuedTurnDbRow>,
  ): ProjectionQueuedTurn => ({
    threadId: row.threadId,
    messageId: row.messageId,
    text: row.text,
    attachments: row.attachments,
    modelSelection: row.modelSelection,
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    ...(row.titleSeed !== null ? { titleSeed: row.titleSeed } : {}),
    ...(row.sourceProposedPlan !== null ? { sourceProposedPlan: row.sourceProposedPlan } : {}),
    queuedAt: row.queuedAt,
    enqueuedSequence: row.enqueuedSequence,
  });
  return {
    upsert: (row) => upsertRow(row).pipe(Effect.mapError(mapError)),
    listAll: () =>
      listAllRows(undefined).pipe(
        Effect.map((rows) => rows.map(toProjectionQueuedTurn)),
        Effect.mapError(mapError),
      ),
    listByThreadId: (input) =>
      listRowsByThread(input).pipe(
        Effect.map((rows) => rows.map(toProjectionQueuedTurn)),
        Effect.mapError(mapError),
      ),
    delete: (input) => deleteRow(input).pipe(Effect.mapError(mapError)),
    deleteByThreadId: (input) => deleteRowsByThread(input).pipe(Effect.mapError(mapError)),
  } satisfies ProjectionQueuedTurnRepositoryShape;
});

export const ProjectionQueuedTurnRepositoryLive = Layer.effect(
  ProjectionQueuedTurnRepository,
  makeProjectionQueuedTurnRepository,
);
