import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationQueuedTurn,
  ProviderInteractionMode,
  RuntimeMode,
  SourceProposedPlanReference,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionQueuedTurn = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  titleSeed: Schema.optional(Schema.String),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  queuedAt: IsoDateTime,
  enqueuedSequence: NonNegativeInt,
});
export type ProjectionQueuedTurn = typeof ProjectionQueuedTurn.Type;

export const ProjectionQueuedTurnDbRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
  modelSelection: Schema.fromJsonString(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  titleSeed: Schema.NullOr(Schema.String),
  sourceProposedPlan: Schema.NullOr(Schema.fromJsonString(SourceProposedPlanReference)),
  queuedAt: IsoDateTime,
  enqueuedSequence: NonNegativeInt,
});

export const ListProjectionQueuedTurnsInput = Schema.Struct({ threadId: ThreadId });
export const DeleteProjectionQueuedTurnInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export const DeleteProjectionQueuedTurnsByThreadInput = Schema.Struct({ threadId: ThreadId });

export interface ProjectionQueuedTurnRepositoryShape {
  readonly upsert: (
    queuedTurn: ProjectionQueuedTurn,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionQueuedTurn>,
    ProjectionRepositoryError
  >;
  readonly listByThreadId: (
    input: typeof ListProjectionQueuedTurnsInput.Type,
  ) => Effect.Effect<ReadonlyArray<ProjectionQueuedTurn>, ProjectionRepositoryError>;
  readonly delete: (
    input: typeof DeleteProjectionQueuedTurnInput.Type,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: typeof DeleteProjectionQueuedTurnsByThreadInput.Type,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionQueuedTurnRepository extends Context.Service<
  ProjectionQueuedTurnRepository,
  ProjectionQueuedTurnRepositoryShape
>()("t3/persistence/Services/ProjectionQueuedTurns/ProjectionQueuedTurnRepository") {}

export function toOrchestrationQueuedTurn(row: ProjectionQueuedTurn): OrchestrationQueuedTurn {
  const { threadId: _threadId, ...queuedTurn } = row;
  return queuedTurn;
}
