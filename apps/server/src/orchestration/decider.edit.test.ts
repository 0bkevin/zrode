import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = asProjectId("project-edit");
const THREAD_ID = asThreadId("thread-edit");
const USER_MESSAGE_ID = asMessageId("message-user-1");
const ASSISTANT_MESSAGE_ID = asMessageId("message-assistant-1");
const TURN_ID = asTurnId("turn-1");

function editCommand(
  overrides?: Partial<Extract<OrchestrationCommand, { type: "thread.last-user-message.edit" }>>,
): Extract<OrchestrationCommand, { type: "thread.last-user-message.edit" }> {
  return {
    type: "thread.last-user-message.edit",
    commandId: asCommandId("cmd-message-edit"),
    threadId: THREAD_ID,
    messageId: USER_MESSAGE_ID,
    text: " edited prompt ",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    titleSeed: "edited prompt",
    createdAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function baseEventFields<K extends "project" | "thread">(
  sequence: number,
  aggregateKind: K,
  aggregateId: K extends "project" ? ProjectId : ThreadId,
) {
  return {
    sequence,
    eventId: asEventId(`evt-edit-${sequence}`),
    aggregateKind,
    aggregateId,
    occurredAt: NOW,
    commandId: asCommandId(`cmd-edit-${sequence}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-edit-${sequence}`),
    metadata: {},
  };
}

function seedReadModel(options?: {
  readonly includeCheckpoint?: boolean;
  readonly includeLaterUserMessage?: boolean;
  readonly userHasAttachment?: boolean;
  readonly sessionStatus?: "ready" | "running";
}) {
  return Effect.gen(function* () {
    const initial = createEmptyReadModel(NOW);
    const withProject = yield* projectEvent(initial, {
      ...baseEventFields(1, "project", PROJECT_ID),
      type: "project.created",
      payload: {
        projectId: PROJECT_ID,
        title: "Edit Project",
        workspaceRoot: "/tmp/edit",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const withThread = yield* projectEvent(withProject, {
      ...baseEventFields(2, "thread", THREAD_ID),
      type: "thread.created",
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Edit Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const withUserMessage = yield* projectEvent(withThread, {
      ...baseEventFields(3, "thread", THREAD_ID),
      type: "thread.message-sent",
      payload: {
        threadId: THREAD_ID,
        messageId: USER_MESSAGE_ID,
        role: "user",
        text: "original prompt",
        attachments:
          options?.userHasAttachment === true
            ? [
                {
                  type: "image" as const,
                  id: "image-1",
                  name: "image.png",
                  mimeType: "image/png",
                  sizeBytes: 100,
                },
              ]
            : [],
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const withAssistantMessage = yield* projectEvent(withUserMessage, {
      ...baseEventFields(4, "thread", THREAD_ID),
      type: "thread.message-sent",
      payload: {
        threadId: THREAD_ID,
        messageId: ASSISTANT_MESSAGE_ID,
        role: "assistant",
        text: "assistant output",
        turnId: TURN_ID,
        streaming: false,
        createdAt: "2026-01-01T00:00:10.000Z",
        updatedAt: "2026-01-01T00:00:10.000Z",
      },
    });

    const withCheckpoint =
      options?.includeCheckpoint === false
        ? withAssistantMessage
        : yield* projectEvent(withAssistantMessage, {
            ...baseEventFields(5, "thread", THREAD_ID),
            type: "thread.turn-diff-completed",
            payload: {
              threadId: THREAD_ID,
              turnId: TURN_ID,
              checkpointTurnCount: 1,
              checkpointRef: checkpointRefForThreadTurn(THREAD_ID, 1),
              status: "ready",
              files: [],
              assistantMessageId: ASSISTANT_MESSAGE_ID,
              completedAt: "2026-01-01T00:00:11.000Z",
            },
          });

    const withLaterUser =
      options?.includeLaterUserMessage === true
        ? yield* projectEvent(withCheckpoint, {
            ...baseEventFields(6, "thread", THREAD_ID),
            type: "thread.message-sent",
            payload: {
              threadId: THREAD_ID,
              messageId: asMessageId("message-user-2"),
              role: "user",
              text: "later prompt",
              attachments: [],
              turnId: null,
              streaming: false,
              createdAt: "2026-01-01T00:00:12.000Z",
              updatedAt: "2026-01-01T00:00:12.000Z",
            },
          })
        : withCheckpoint;

    if (!options?.sessionStatus) {
      return withLaterUser;
    }

    return yield* projectEvent(withLaterUser, {
      ...baseEventFields(7, "thread", THREAD_ID),
      type: "thread.session-set",
      payload: {
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus,
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: options.sessionStatus === "running" ? TURN_ID : null,
          lastError: null,
          updatedAt: NOW,
        },
      },
    });
  });
}

it.layer(NodeServices.layer)("decider last user message edit", (it) => {
  it.effect("emits edit-requested for a valid latest user message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel();
      const decided = yield* decideOrchestrationCommand({
        command: editCommand(),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.last-user-message-edit-requested");
      if (events[0]?.type !== "thread.last-user-message-edit-requested") {
        return;
      }
      expect(events[0].payload).toMatchObject({
        threadId: THREAD_ID,
        messageId: USER_MESSAGE_ID,
        text: "edited prompt",
        targetTurnCount: 0,
        checkpointTurnId: TURN_ID,
        checkpointTurnCount: 1,
        expectedCurrentTurnCount: 1,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        titleSeed: "edited prompt",
      });
    }),
  );

  it.effect("rejects older user messages", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({ includeLaterUserMessage: true });
      const error = yield* decideOrchestrationCommand({
        command: editCommand(),
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("Only the latest user message");
      }
    }),
  );

  it.effect("rejects attachment messages", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({ userHasAttachment: true });
      const error = yield* decideOrchestrationCommand({
        command: editCommand(),
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("has attachments");
      }
    }),
  );

  it.effect("rejects running sessions", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({ sessionStatus: "running" });
      const error = yield* decideOrchestrationCommand({
        command: editCommand(),
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("already has an active turn");
      }
    }),
  );

  it.effect("rejects messages without a checkpointed assistant turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({ includeCheckpoint: false });
      const error = yield* decideOrchestrationCommand({
        command: editCommand(),
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("does not have a checkpointed assistant turn");
      }
    }),
  );
});
