import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

type QueuedTurn = OrchestrationReadModel["threads"][number]["queuedTurns"][number];
type QueuedTurnSubmissionCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.queued-turn.dispatch" | "thread.queued-turn.steer" }
>;

const planQueuedTurnSubmission = Effect.fnUntraced(function* (input: {
  readonly command: QueuedTurnSubmissionCommand;
  readonly queued: QueuedTurn;
  readonly destination:
    | { readonly type: "start" }
    | { readonly type: "steer"; readonly expectedTurnId: TurnId };
}) {
  const { command, queued } = input;
  const dequeuedEvent: PlannedOrchestrationEvent = {
    ...(yield* withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    })),
    type: "thread.queued-turn-dequeued",
    payload: {
      threadId: command.threadId,
      messageId: queued.messageId,
      dequeuedAt: command.createdAt,
    },
  };
  const userMessageEvent: PlannedOrchestrationEvent = {
    ...(yield* withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    })),
    causationEventId: dequeuedEvent.eventId,
    type: "thread.message-sent",
    payload: {
      threadId: command.threadId,
      messageId: queued.messageId,
      role: "user",
      text: queued.text,
      attachments: queued.attachments,
      turnId: null,
      streaming: false,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    },
  };
  const requestEvent: PlannedOrchestrationEvent =
    input.destination.type === "steer"
      ? {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          causationEventId: userMessageEvent.eventId,
          type: "thread.turn-steer-requested",
          payload: {
            threadId: command.threadId,
            messageId: queued.messageId,
            expectedTurnId: input.destination.expectedTurnId,
            modelSelection: queued.modelSelection,
            runtimeMode: queued.runtimeMode,
            interactionMode: queued.interactionMode,
            createdAt: command.createdAt,
          },
        }
      : {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          causationEventId: userMessageEvent.eventId,
          type: "thread.turn-start-requested",
          payload: {
            threadId: command.threadId,
            messageId: queued.messageId,
            modelSelection: queued.modelSelection,
            ...(queued.titleSeed !== undefined ? { titleSeed: queued.titleSeed } : {}),
            runtimeMode: queued.runtimeMode,
            interactionMode: queued.interactionMode,
            ...(queued.sourceProposedPlan !== undefined
              ? { sourceProposedPlan: queued.sourceProposedPlan }
              : {}),
            createdAt: command.createdAt,
          },
        };
  return [dequeuedEvent, userMessageEvent, requestEvent] as const;
});

const PROVIDER_TURN_RETRY_REQUESTED_ACTIVITY_KIND = "provider.turn.retry.requested";

type SourceProposedPlanReference = NonNullable<
  Extract<OrchestrationCommand, { type: "thread.turn.start" }>["sourceProposedPlan"]
>;

const validateSourceProposedPlan = Effect.fnUntraced(function* (input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly targetThread: OrchestrationReadModel["threads"][number];
  readonly sourceProposedPlan: SourceProposedPlanReference | undefined;
}) {
  const sourceThread = input.sourceProposedPlan
    ? yield* requireThread({
        readModel: input.readModel,
        command: input.command,
        threadId: input.sourceProposedPlan.threadId,
      })
    : null;
  const sourcePlan =
    input.sourceProposedPlan && sourceThread
      ? sourceThread.proposedPlans.find((entry) => entry.id === input.sourceProposedPlan?.planId)
      : null;
  if (input.sourceProposedPlan && !sourcePlan) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: `Proposed plan '${input.sourceProposedPlan.planId}' does not exist on thread '${input.sourceProposedPlan.threadId}'.`,
    });
  }
  if (sourceThread && sourceThread.projectId !== input.targetThread.projectId) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: `Proposed plan '${input.sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
    });
  }
  return input.sourceProposedPlan;
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

type TurnStartRetryMetadata = Omit<
  Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>["payload"],
  "threadId" | "messageId" | "createdAt"
>;

type TurnStartRetryState =
  | {
      readonly type: "retryable-failure";
      readonly payload: Record<string, unknown>;
    }
  | {
      readonly type: "retry-requested";
    };

function compareRetryActivityOrder(
  left: OrchestrationReadModel["threads"][number]["activities"][number],
  right: OrchestrationReadModel["threads"][number]["activities"][number],
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    (left.sequence ?? -1) - (right.sequence ?? -1) ||
    left.id.localeCompare(right.id)
  );
}

function resolveLatestTurnStartRetryStateForMessage(
  thread: OrchestrationReadModel["threads"][number],
  messageId: string,
): TurnStartRetryState | null {
  const activities = thread.activities
    .filter(
      (activity) =>
        activity.kind === "provider.turn.start.failed" ||
        activity.kind === PROVIDER_TURN_RETRY_REQUESTED_ACTIVITY_KIND,
    )
    .toSorted(compareRetryActivityOrder);
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    const payload = isRecord(activity.payload) ? activity.payload : null;
    if (payload?.messageId === messageId) {
      return activity.kind === "provider.turn.start.failed" && payload.retryable === true
        ? { type: "retryable-failure", payload }
        : { type: "retry-requested" };
    }
  }
  return null;
}

function isRuntimeMode(value: unknown): value is TurnStartRetryMetadata["runtimeMode"] {
  return value === "approval-required" || value === "auto-accept-edits" || value === "full-access";
}

function isInteractionMode(value: unknown): value is TurnStartRetryMetadata["interactionMode"] {
  return value === "default" || value === "plan";
}

function resolveStoredTurnStartRetryMetadata(
  payload: Record<string, unknown>,
): TurnStartRetryMetadata | null {
  const turnStart = isRecord(payload.turnStart) ? payload.turnStart : null;
  if (!turnStart) {
    return null;
  }
  if (!isRuntimeMode(turnStart.runtimeMode) || !isInteractionMode(turnStart.interactionMode)) {
    return null;
  }
  return {
    ...(turnStart.modelSelection !== undefined ? { modelSelection: turnStart.modelSelection } : {}),
    ...(typeof turnStart.titleSeed === "string" ? { titleSeed: turnStart.titleSeed } : {}),
    runtimeMode: turnStart.runtimeMode,
    interactionMode: turnStart.interactionMode,
    ...(isRecord(turnStart.sourceProposedPlan)
      ? { sourceProposedPlan: turnStart.sourceProposedPlan }
      : {}),
  } as TurnStartRetryMetadata;
}

function findCheckpointAfterUserMessageForEdit(
  thread: OrchestrationReadModel["threads"][number],
  userMessageIndex: number,
): OrchestrationReadModel["threads"][number]["checkpoints"][number] | null {
  const assistantTurnIds = new Set<string>();
  for (let index = userMessageIndex + 1; index < thread.messages.length; index += 1) {
    const message = thread.messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      break;
    }
    if (message.role === "assistant" && message.turnId !== null) {
      assistantTurnIds.add(message.turnId);
    }
  }

  return (
    thread.checkpoints
      .filter((checkpoint) => assistantTurnIds.has(checkpoint.turnId))
      .toSorted(
        (left, right) =>
          left.checkpointTurnCount - right.checkpointTurnCount ||
          left.completedAt.localeCompare(right.completedAt),
      )[0] ?? null
  );
}

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      const createdEvent = {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      } satisfies PlannedOrchestrationEvent;

      const importProviders = [...new Set(command.sessionHistoryImportProviders ?? [])];

      if (command.importSessionHistory !== true || importProviders.length === 0) {
        return createdEvent;
      }

      return [
        createdEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "project.session-history-import-requested",
          payload: {
            projectId: command.projectId,
            workspaceRoot: command.workspaceRoot,
            providers: importProviders,
            requestedAt: command.createdAt,
          },
        },
      ];
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      const handoffSource = command.handoffSource;
      if (handoffSource !== undefined) {
        const sourceThread = yield* requireThread({
          readModel,
          command,
          threadId: handoffSource.threadId,
        });
        if (sourceThread.deletedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Handoff source thread '${handoffSource.threadId}' has been deleted.`,
          });
        }
        if (sourceThread.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Handoff source thread '${handoffSource.threadId}' belongs to project '${sourceThread.projectId}', not '${command.projectId}'.`,
          });
        }
      }
      const threadCreatedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread" as const,
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created" as const,
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...(handoffSource !== undefined ? { handoffSource } : {}),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      if (handoffSource === undefined) {
        return threadCreatedEvent;
      }
      const sourceActivityBase = yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: handoffSource.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      });
      return [
        threadCreatedEvent,
        {
          ...sourceActivityBase,
          type: "thread.activity-appended" as const,
          payload: {
            threadId: handoffSource.threadId,
            activity: {
              id: sourceActivityBase.eventId,
              tone: "info" as const,
              kind: "handoff.target-created",
              summary: `Handed off to '${command.title}'.`,
              payload: {
                targetThreadId: command.threadId,
                method: handoffSource.method,
              },
              turnId: null,
              createdAt: command.createdAt,
            },
          },
        },
      ];
    }

    case "thread.history.import": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      const threadCreatedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread" as const,
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            adapterKey: `history-import:${command.provider}`,
          },
        })),
        type: "thread.created" as const,
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      } satisfies PlannedOrchestrationEvent;

      const messageEvents: PlannedOrchestrationEvent[] = [];
      for (const message of command.messages) {
        messageEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread" as const,
            aggregateId: command.threadId,
            occurredAt: message.createdAt,
            commandId: command.commandId,
            metadata: {
              adapterKey: `history-import:${command.provider}`,
            },
          })),
          type: "thread.message-sent" as const,
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            turnId: null,
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          },
        } satisfies PlannedOrchestrationEvent);
      }

      return [threadCreatedEvent, ...messageEvents];
    }

    case "project.session-history-import.complete": {
      // Bookkeeping event recorded even when the project was deleted
      // mid-import so the request is never replayed again.
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.session-history-import-completed",
        payload: {
          projectId: command.projectId,
          requestEventId: command.requestEventId,
          completedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.queuedTurns.length > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has queued turns that must be dispatched first.`,
        });
      }
      const sourceProposedPlan = yield* validateSourceProposedPlan({
        readModel,
        command,
        targetThread,
        sourceProposedPlan: command.sourceProposedPlan,
      });
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.steer": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        targetThread.session?.status !== "running" ||
        targetThread.session.activeTurnId !== command.expectedTurnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Turn '${command.expectedTurnId}' is no longer active on thread '${command.threadId}'.`,
        });
      }

      const userMessageEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const steerRequestedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-steer-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          expectedTurnId: command.expectedTurnId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, steerRequestedEvent];
    }

    case "thread.turn.enqueue": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        targetThread.messages.some((message) => message.id === command.message.messageId) ||
        targetThread.queuedTurns.some((queued) => queued.messageId === command.message.messageId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.message.messageId}' already exists on thread '${command.threadId}'.`,
        });
      }
      const sourceProposedPlan = yield* validateSourceProposedPlan({
        readModel,
        command,
        targetThread,
        sourceProposedPlan: command.sourceProposedPlan,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-enqueued",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          text: command.message.text,
          attachments: command.message.attachments,
          modelSelection: command.modelSelection ?? targetThread.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          queuedAt: command.createdAt,
        },
      };
    }

    case "thread.queued-turn.cancel": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (!targetThread.queuedTurns.some((queued) => queued.messageId === command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued message '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.queued-turn-cancelled",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          cancelledAt: command.createdAt,
        },
      };
    }

    case "thread.queued-turn.steer": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        targetThread.session?.status !== "running" ||
        targetThread.session.activeTurnId !== command.expectedTurnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Turn '${command.expectedTurnId}' is no longer active on thread '${command.threadId}'.`,
        });
      }
      const queued = targetThread.queuedTurns.find(
        (entry) => entry.messageId === command.messageId,
      );
      if (!queued) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued message '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }

      return yield* planQueuedTurnSubmission({
        command,
        queued,
        destination: { type: "steer", expectedTurnId: command.expectedTurnId },
      });
    }

    case "thread.turn.retry": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      if (
        targetThread.session?.status === "starting" ||
        targetThread.session?.status === "running"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has an active turn.`,
        });
      }

      const messageIndex = targetThread.messages.findIndex(
        (message) => message.id === command.messageId,
      );
      const message = messageIndex >= 0 ? targetThread.messages[messageIndex] : undefined;
      if (!message || message.role !== "user") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User message '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }

      const latestUserMessage = targetThread.messages.findLast((entry) => entry.role === "user");
      if (latestUserMessage?.id !== command.messageId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Only the latest user message on thread '${command.threadId}' can be retried.`,
        });
      }

      const hasLaterAssistantOutput = targetThread.messages
        .slice(messageIndex + 1)
        .some((entry) => entry.role === "assistant");
      if (hasLaterAssistantOutput) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User message '${command.messageId}' already has assistant output and cannot be retried.`,
        });
      }

      const retryState = resolveLatestTurnStartRetryStateForMessage(
        targetThread,
        command.messageId,
      );
      if (retryState?.type !== "retryable-failure") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User message '${command.messageId}' does not have a retryable turn-start failure.`,
        });
      }

      const retryMetadata = resolveStoredTurnStartRetryMetadata(retryState.payload) ?? {
        modelSelection: targetThread.modelSelection,
        runtimeMode: targetThread.runtimeMode,
        interactionMode: targetThread.interactionMode,
      };

      const retryRequestedBase = yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      });
      const retryRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...retryRequestedBase,
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            id: retryRequestedBase.eventId,
            tone: "info",
            kind: PROVIDER_TURN_RETRY_REQUESTED_ACTIVITY_KIND,
            summary: "Retry requested",
            payload: {
              messageId: command.messageId,
              commandId: command.commandId,
            },
            turnId: null,
            createdAt: command.createdAt,
          },
        },
      };

      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: retryRequestedEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          ...(retryMetadata.modelSelection !== undefined
            ? { modelSelection: retryMetadata.modelSelection }
            : {}),
          ...(retryMetadata.titleSeed !== undefined ? { titleSeed: retryMetadata.titleSeed } : {}),
          runtimeMode: retryMetadata.runtimeMode,
          interactionMode: retryMetadata.interactionMode,
          ...(retryMetadata.sourceProposedPlan !== undefined
            ? { sourceProposedPlan: retryMetadata.sourceProposedPlan }
            : {}),
          createdAt: command.createdAt,
        },
      };
      return [retryRequestedEvent, turnStartRequestedEvent];
    }

    case "thread.last-user-message.edit": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      if (
        targetThread.session?.status === "starting" ||
        targetThread.session?.status === "running"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has an active turn.`,
        });
      }

      const editedText = command.text.trim();
      if (editedText.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Edited message text cannot be empty.",
        });
      }

      const messageIndex = targetThread.messages.findIndex(
        (message) => message.id === command.messageId,
      );
      const message = messageIndex >= 0 ? targetThread.messages[messageIndex] : undefined;
      if (!message || message.role !== "user") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User message '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }

      const latestUserMessage = targetThread.messages.findLast((entry) => entry.role === "user");
      if (latestUserMessage?.id !== command.messageId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Only the latest user message on thread '${command.threadId}' can be edited.`,
        });
      }

      if ((message.attachments?.length ?? 0) > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User message '${command.messageId}' has attachments and cannot be edited.`,
        });
      }

      const checkpoint = findCheckpointAfterUserMessageForEdit(targetThread, messageIndex);
      if (!checkpoint) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User message '${command.messageId}' does not have a checkpointed assistant turn to replace.`,
        });
      }
      const targetTurnCount = Math.max(0, checkpoint.checkpointTurnCount - 1);
      const expectedCurrentTurnCount = targetThread.checkpoints.reduce(
        (maxTurnCount, entry) => Math.max(maxTurnCount, entry.checkpointTurnCount),
        0,
      );

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.last-user-message-edit-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          text: editedText,
          targetTurnCount,
          checkpointTurnId: checkpoint.turnId,
          checkpointTurnCount: checkpoint.checkpointTurnCount,
          expectedCurrentTurnCount,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    case "thread.queued-turn.dispatch": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queued = targetThread.queuedTurns[0];
      if (!queued || queued.messageId !== command.messageId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued message '${command.messageId}' is not the head of thread '${command.threadId}'.`,
        });
      }
      if (
        targetThread.session?.status === "starting" ||
        targetThread.session?.status === "running" ||
        targetThread.latestTurn?.state === "running"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' still has active work.`,
        });
      }

      return yield* planQueuedTurnSubmission({
        command,
        queued,
        destination: { type: "start" },
      });
    }

    case "thread.turn.quiesce": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-quiesced",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          quiescedAt: command.createdAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
