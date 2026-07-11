import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { QueuedTurnReactor } from "../Services/QueuedTurnReactor.ts";
import { QueuedTurnReactorLive } from "./QueuedTurnReactor.ts";

const NOW = "2026-07-10T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-queued-reactor");
const TURN_ID = TurnId.make("turn-queued-reactor");
const MESSAGE_ID = MessageId.make("message-queued-reactor");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

const thread: OrchestrationReadModel["threads"][number] = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-queued-reactor"),
  title: "Queued reactor",
  modelSelection: MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  handoffSource: null,
  latestTurn: {
    turnId: TURN_ID,
    state: "completed",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    assistantMessageId: null,
  },
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  queuedTurns: [
    {
      messageId: MESSAGE_ID,
      text: "Run after quiescence",
      attachments: [],
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      queuedAt: NOW,
      enqueuedSequence: 3,
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: THREAD_ID,
    status: "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  },
};

const snapshot: OrchestrationReadModel = {
  snapshotSequence: 4,
  projects: [],
  threads: [thread],
  updatedAt: NOW,
};

function event(
  sequence: number,
  type:
    | "thread.turn-start-requested"
    | "thread.turn-quiesced"
    | "thread.session-set"
    | "thread.queued-turn-cancelled",
  turnId: TurnId = TURN_ID,
  sessionStatus: "running" | "error" = "running",
): OrchestrationEvent {
  const base = {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread" as const,
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-${sequence}`),
    metadata: {},
  };
  switch (type) {
    case "thread.turn-start-requested":
      return {
        ...base,
        type,
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.make("message-running"),
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
      };
    case "thread.turn-quiesced":
      return {
        ...base,
        type,
        payload: {
          threadId: THREAD_ID,
          turnId,
          quiescedAt: NOW,
        },
      };
    case "thread.session-set":
      return {
        ...base,
        type,
        payload: {
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: sessionStatus,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: sessionStatus === "running" ? turnId : null,
            lastError: sessionStatus === "error" ? "Provider start failed" : null,
            updatedAt: NOW,
          },
        },
      };
    case "thread.queued-turn-cancelled":
      return {
        ...base,
        type,
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.make("message-cancelled"),
          cancelledAt: NOW,
        },
      };
  }
}

function runReactor(
  replayedEvents: ReadonlyArray<OrchestrationEvent>,
  options?: {
    readonly liveEvents?: ReadonlyArray<OrchestrationEvent>;
    readonly startupSnapshot?: OrchestrationReadModel;
  },
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const dispatched: OrchestrationCommand[] = [];
      const liveEvents = yield* Queue.unbounded<OrchestrationEvent>();
      const layer = QueuedTurnReactorLive.pipe(
        Layer.provideMerge(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 5 };
              }),
            readEvents: () => Stream.empty,
            streamDomainEvents: Stream.fromQueue(liveEvents),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(OrchestrationEventStore)({
            append: () => Effect.die("not used"),
            readFromSequence: () => Stream.fromIterable(replayedEvents),
            readAll: () => Stream.fromIterable(replayedEvents),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(ProjectionSnapshotQuery)({
            getSnapshot: () => Effect.succeed(options?.startupSnapshot ?? snapshot),
            getThreadDetailById: () => Effect.succeed(Option.some(thread)),
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* QueuedTurnReactor;
        yield* reactor.start();
        for (const liveEvent of options?.liveEvents ?? []) {
          yield* Queue.offer(liveEvents, liveEvent);
        }
        yield* Effect.yieldNow;
        yield* reactor.drain;
      }).pipe(Effect.provide(layer));
      return dispatched;
    }),
  );
}

describe("QueuedTurnReactor", () => {
  it.effect("keeps queued work blocked when the latest start has not quiesced", () =>
    Effect.gen(function* () {
      const dispatched = yield* runReactor([event(1, "thread.turn-start-requested")]);
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("dispatches the FIFO head after durable quiescence", () =>
    Effect.gen(function* () {
      const dispatched = yield* runReactor([
        event(1, "thread.turn-start-requested"),
        event(2, "thread.session-set"),
        event(3, "thread.turn-quiesced"),
      ]);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.queued-turn.dispatch",
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
      });
    }),
  );

  it.effect("does not let an older quiescence release a newly requested turn", () =>
    Effect.gen(function* () {
      const oldTurnId = TurnId.make("turn-old");
      const dispatched = yield* runReactor([
        event(1, "thread.session-set", oldTurnId),
        event(2, "thread.turn-start-requested"),
        event(3, "thread.turn-quiesced", oldTurnId),
      ]);
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("releases queued work when provider startup fails before assigning a turn", () =>
    Effect.gen(function* () {
      const dispatched = yield* runReactor([
        event(1, "thread.turn-start-requested"),
        event(2, "thread.session-set", TURN_ID, "error"),
      ]);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.queued-turn.dispatch",
        messageId: MESSAGE_ID,
      });
    }),
  );

  it.effect("advances the next queued turn after a queued head is cancelled", () =>
    Effect.gen(function* () {
      const dispatched = yield* runReactor([], {
        startupSnapshot: {
          ...snapshot,
          threads: [{ ...thread, queuedTurns: [] }],
        },
        liveEvents: [event(5, "thread.queued-turn-cancelled")],
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.queued-turn.dispatch",
        messageId: MESSAGE_ID,
      });
    }),
  );
});
