import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-10T12:00:00.000Z";
const LATER = "2026-07-10T12:01:00.000Z";
const PROJECT_ID = ProjectId.make("project-queue");
const THREAD_ID = ThreadId.make("thread-queue");
const ACTIVE_TURN_ID = TurnId.make("turn-active");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

function readModel(input?: {
  readonly queuedTurns?: OrchestrationReadModel["threads"][number]["queuedTurns"];
  readonly running?: boolean;
}): OrchestrationReadModel {
  const running = input?.running ?? true;
  return {
    snapshotSequence: 4,
    updatedAt: NOW,
    projects: [
      {
        id: PROJECT_ID,
        title: "Queue project",
        workspaceRoot: "/tmp/queue-project",
        defaultModelSelection: MODEL_SELECTION,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Queue thread",
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        handoffSource: null,
        latestTurn: {
          turnId: ACTIVE_TURN_ID,
          state: running ? "running" : "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: running ? null : LATER,
          assistantMessageId: null,
        },
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        queuedTurns: input?.queuedTurns ?? [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: running ? "running" : "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: running ? ACTIVE_TURN_ID : null,
          lastError: null,
          updatedAt: running ? NOW : LATER,
        },
      },
    ],
  };
}

it.layer(NodeServices.layer)("queued turn decider", (it) => {
  it.effect("records a queued turn without appending it to the conversation", () =>
    Effect.gen(function* () {
      const command = {
        type: "thread.turn.enqueue",
        commandId: CommandId.make("command-enqueue"),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.make("message-queued"),
          role: "user",
          text: "Run this after the current task",
          attachments: [],
        },
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: LATER,
      } satisfies Extract<OrchestrationCommand, { type: "thread.turn.enqueue" }>;

      const decided = yield* decideOrchestrationCommand({ command, readModel: readModel() });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event?.type !== "thread.turn-enqueued") return;
      expect(event.payload).toMatchObject({
        threadId: THREAD_ID,
        messageId: MessageId.make("message-queued"),
        text: "Run this after the current task",
        queuedAt: LATER,
      });
    }),
  );

  it.effect("steers only the expected active turn", () =>
    Effect.gen(function* () {
      const command = {
        type: "thread.turn.steer",
        commandId: CommandId.make("command-steer"),
        threadId: THREAD_ID,
        expectedTurnId: ACTIVE_TURN_ID,
        message: {
          messageId: MessageId.make("message-steer"),
          role: "user",
          text: "Use the existing helper",
          attachments: [],
        },
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: LATER,
      } satisfies Extract<OrchestrationCommand, { type: "thread.turn.steer" }>;

      const decided = yield* decideOrchestrationCommand({ command, readModel: readModel() });
      expect(Array.isArray(decided)).toBe(true);
      if (!Array.isArray(decided)) return;
      expect(decided.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-steer-requested",
      ]);
      const steerEvent = decided[1];
      if (steerEvent?.type !== "thread.turn-steer-requested") return;
      expect(steerEvent.payload.expectedTurnId).toBe(ACTIVE_TURN_ID);

      const staleError = yield* decideOrchestrationCommand({
        command: { ...command, expectedTurnId: TurnId.make("turn-stale") },
        readModel: readModel(),
      }).pipe(Effect.flip);
      expect(staleError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("promotes any queued message into the active turn as a steer", () =>
    Effect.gen(function* () {
      const firstMessageId = MessageId.make("message-first");
      const steeredMessageId = MessageId.make("message-steered-from-queue");
      const queuedTurns = [
        {
          messageId: firstMessageId,
          text: "Keep this queued",
          attachments: [],
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          queuedAt: NOW,
          enqueuedSequence: 3,
        },
        {
          messageId: steeredMessageId,
          text: "Use this after the current tool call",
          attachments: [],
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          queuedAt: LATER,
          enqueuedSequence: 4,
        },
      ];
      const command = {
        type: "thread.queued-turn.steer",
        commandId: CommandId.make("command-steer-queued"),
        threadId: THREAD_ID,
        messageId: steeredMessageId,
        expectedTurnId: ACTIVE_TURN_ID,
        createdAt: LATER,
      } satisfies Extract<OrchestrationCommand, { type: "thread.queued-turn.steer" }>;

      const decided = yield* decideOrchestrationCommand({
        command,
        readModel: readModel({ queuedTurns }),
      });
      expect(Array.isArray(decided)).toBe(true);
      if (!Array.isArray(decided)) return;
      expect(decided.map((event) => event.type)).toEqual([
        "thread.queued-turn-dequeued",
        "thread.message-sent",
        "thread.turn-steer-requested",
      ]);
      const dequeued = decided[0];
      const sent = decided[1];
      const steer = decided[2];
      if (
        dequeued?.type !== "thread.queued-turn-dequeued" ||
        sent?.type !== "thread.message-sent" ||
        steer?.type !== "thread.turn-steer-requested"
      ) {
        return;
      }
      expect(dequeued.payload.messageId).toBe(steeredMessageId);
      expect(sent.payload).toMatchObject({
        messageId: steeredMessageId,
        text: "Use this after the current tool call",
      });
      expect(steer.payload).toMatchObject({
        messageId: steeredMessageId,
        expectedTurnId: ACTIVE_TURN_ID,
      });
      expect(sent.causationEventId).toBe(dequeued.eventId);
      expect(steer.causationEventId).toBe(sent.eventId);

      const staleError = yield* decideOrchestrationCommand({
        command: { ...command, expectedTurnId: TurnId.make("turn-stale") },
        readModel: readModel({ queuedTurns }),
      }).pipe(Effect.flip);
      expect(staleError._tag).toBe("OrchestrationCommandInvariantError");

      const missingError = yield* decideOrchestrationCommand({
        command: { ...command, messageId: MessageId.make("message-missing") },
        readModel: readModel({ queuedTurns }),
      }).pipe(Effect.flip);
      expect(missingError._tag).toBe("OrchestrationCommandInvariantError");

      const inactiveError = yield* decideOrchestrationCommand({
        command,
        readModel: readModel({ queuedTurns, running: false }),
      }).pipe(Effect.flip);
      expect(inactiveError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("dequeues only the FIFO head after work is settled", () =>
    Effect.gen(function* () {
      const queuedAt = "2026-07-10T11:59:00.000Z";
      const messageId = MessageId.make("message-head");
      const command = {
        type: "thread.queued-turn.dispatch",
        commandId: CommandId.make("command-dispatch"),
        threadId: THREAD_ID,
        messageId,
        createdAt: LATER,
      } satisfies Extract<OrchestrationCommand, { type: "thread.queued-turn.dispatch" }>;
      const queuedTurns = [
        {
          messageId,
          text: "Next task",
          attachments: [],
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          titleSeed: "Next task title",
          queuedAt,
          enqueuedSequence: 3,
        },
      ];

      const decided = yield* decideOrchestrationCommand({
        command,
        readModel: readModel({ queuedTurns, running: false }),
      });
      expect(Array.isArray(decided)).toBe(true);
      if (!Array.isArray(decided)) return;
      expect(decided.map((event) => event.type)).toEqual([
        "thread.queued-turn-dequeued",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const messageEvent = decided[1];
      const startEvent = decided[2];
      if (messageEvent?.type !== "thread.message-sent") return;
      expect(messageEvent.payload.createdAt).toBe(LATER);
      expect(messageEvent.payload.createdAt).not.toBe(queuedAt);
      if (startEvent?.type !== "thread.turn-start-requested") return;
      expect(startEvent.payload).toMatchObject({
        messageId,
        modelSelection: MODEL_SELECTION,
        titleSeed: "Next task title",
      });
      expect(messageEvent.causationEventId).toBe(decided[0]?.eventId);
      expect(startEvent.causationEventId).toBe(messageEvent.eventId);
    }),
  );
});
