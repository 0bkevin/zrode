import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = asProjectId("project-retry");
const THREAD_ID = asThreadId("thread-retry");
const USER_MESSAGE_ID = asMessageId("message-user-1");

function retryCommand(
  overrides?: Partial<Extract<OrchestrationCommand, { type: "thread.turn.retry" }>>,
): Extract<OrchestrationCommand, { type: "thread.turn.retry" }> {
  return {
    type: "thread.turn.retry",
    commandId: asCommandId("cmd-turn-retry"),
    threadId: THREAD_ID,
    messageId: USER_MESSAGE_ID,
    createdAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function seedReadModel(options: {
  readonly retryableFailure: boolean;
  readonly turnStart?: Record<string, unknown>;
}) {
  return Effect.gen(function* () {
    const initial = createEmptyReadModel(NOW);
    const withProject = yield* projectEvent(initial, {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: asCommandId("cmd-project-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        title: "Retry Project",
        workspaceRoot: "/tmp/retry",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const withThread = yield* projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: asCommandId("cmd-thread-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Retry Thread",
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
      sequence: 3,
      eventId: asEventId("evt-message-user"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.message-sent",
      occurredAt: NOW,
      commandId: asCommandId("cmd-message-user"),
      causationEventId: null,
      correlationId: asCommandId("cmd-message-user"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        messageId: USER_MESSAGE_ID,
        role: "user",
        text: "retry this",
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    return yield* projectEvent(withUserMessage, {
      sequence: 4,
      eventId: asEventId("evt-provider-failure"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.activity-appended",
      occurredAt: NOW,
      commandId: asCommandId("cmd-provider-failure"),
      causationEventId: null,
      correlationId: asCommandId("cmd-provider-failure"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        activity: {
          id: asEventId("activity-provider-failure"),
          tone: "error",
          kind: "provider.turn.start.failed",
          summary: "Provider failed to start turn",
          payload: {
            detail: "Rate limit exceeded.",
            messageId: USER_MESSAGE_ID,
            retryable: options.retryableFailure,
            ...(options.turnStart !== undefined ? { turnStart: options.turnStart } : {}),
          },
          turnId: null,
          sequence: 4,
          createdAt: NOW,
        },
      },
    });
  });
}

it.layer(NodeServices.layer)("decider retry", (it) => {
  it.effect("retries a failed user message without appending a duplicate user message", () =>
    Effect.gen(function* () {
      const turnStart = {
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        titleSeed: "Implement plan",
        runtimeMode: "full-access",
        interactionMode: "plan",
        sourceProposedPlan: {
          threadId: asThreadId("thread-source"),
          planId: "plan-1",
        },
      };
      const readModel = yield* seedReadModel({ retryableFailure: true, turnStart });
      const decided = yield* decideOrchestrationCommand({
        command: retryCommand(),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events).toHaveLength(2);
      expect(events.some((event) => event.type === "thread.message-sent")).toBe(false);
      expect(events[0]?.type).toBe("thread.activity-appended");
      expect(events[1]?.type).toBe("thread.turn-start-requested");
      if (events[0]?.type !== "thread.activity-appended") {
        return;
      }
      expect(events[0].payload.activity).toMatchObject({
        tone: "info",
        kind: "provider.turn.retry.requested",
        payload: {
          messageId: USER_MESSAGE_ID,
          commandId: CommandId.make("cmd-turn-retry"),
        },
      });
      if (events[1]?.type !== "thread.turn-start-requested") {
        return;
      }
      expect(events[1].causationEventId).toBe(events[0].eventId);
      expect(events[1].payload).toMatchObject({
        threadId: THREAD_ID,
        messageId: USER_MESSAGE_ID,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        titleSeed: "Implement plan",
        runtimeMode: "full-access",
        interactionMode: "plan",
        sourceProposedPlan: {
          threadId: asThreadId("thread-source"),
          planId: "plan-1",
        },
        createdAt: "2026-01-01T00:01:00.000Z",
      });
    }),
  );

  it.effect("rejects a second retry after the first retry has reserved the attempt", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({ retryableFailure: true });
      const decided = yield* decideOrchestrationCommand({
        command: retryCommand(),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      let nextReadModel = readModel;
      let sequence = nextReadModel.snapshotSequence;
      for (const event of events) {
        sequence += 1;
        nextReadModel = yield* projectEvent(nextReadModel, {
          ...event,
          sequence,
        });
      }

      const error = yield* decideOrchestrationCommand({
        command: retryCommand({ commandId: CommandId.make("cmd-turn-retry-again") }),
        readModel: nextReadModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("does not have a retryable turn-start failure");
      }
    }),
  );

  it.effect("rejects retry when the turn-start failure is not retryable", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({ retryableFailure: false });
      const error = yield* decideOrchestrationCommand({
        command: retryCommand(),
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("does not have a retryable turn-start failure");
      }
    }),
  );
});
