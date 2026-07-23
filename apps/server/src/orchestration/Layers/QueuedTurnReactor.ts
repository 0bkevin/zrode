import { CommandId, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { QueuedTurnReactor, type QueuedTurnReactorShape } from "../Services/QueuedTurnReactor.ts";

type QueueReactorEvent = Extract<
  OrchestrationEvent,
  {
    readonly type:
      | "thread.turn-start-requested"
      | "thread.turn-enqueued"
      | "thread.queued-turn-cancelled"
      | "thread.turn-quiesced"
      | "thread.session-set"
      | "thread.deleted";
  }
>;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const eventStore = yield* OrchestrationEventStore;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  // A start remains blocked until the checkpoint reactor emits quiescence.
  // Rebuilding this set from the durable event log makes restarts predictable.
  const blockedThreadIds = new Set<string>();
  // `null` means a newer turn was requested but its provider turn id has not
  // arrived yet. In that window no older quiescence marker may release work.
  const lastStartedTurnIdByThreadId = new Map<string, string | null>();
  const lastLifecycleSequenceByThreadId = new Map<string, number>();
  let bootstrapped = false;

  const applyLifecycleEvent = (
    event: Extract<
      QueueReactorEvent,
      {
        readonly type:
          | "thread.turn-start-requested"
          | "thread.turn-quiesced"
          | "thread.session-set"
          | "thread.deleted";
      }
    >,
  ): boolean => {
    const threadId = event.payload.threadId;
    if (event.sequence < (lastLifecycleSequenceByThreadId.get(threadId) ?? -1)) {
      return false;
    }
    lastLifecycleSequenceByThreadId.set(threadId, event.sequence);
    switch (event.type) {
      case "thread.turn-start-requested":
        blockedThreadIds.add(threadId);
        lastStartedTurnIdByThreadId.set(threadId, null);
        break;
      case "thread.session-set":
        if (event.payload.session.status === "running" && event.payload.session.activeTurnId) {
          blockedThreadIds.add(threadId);
          lastStartedTurnIdByThreadId.set(threadId, event.payload.session.activeTurnId);
        } else if (
          lastStartedTurnIdByThreadId.get(threadId) === null &&
          (event.payload.session.status === "error" ||
            event.payload.session.status === "interrupted" ||
            event.payload.session.status === "stopped")
        ) {
          // The provider failed or was stopped before it assigned a turn id.
          // No checkpoint work exists for that failed start, so queued work can
          // advance without waiting for a turn-scoped quiescence event.
          blockedThreadIds.delete(threadId);
          lastStartedTurnIdByThreadId.delete(threadId);
        }
        break;
      case "thread.turn-quiesced": {
        const lastStartedTurnId = lastStartedTurnIdByThreadId.get(threadId);
        if (
          lastStartedTurnId === null ||
          (lastStartedTurnId && lastStartedTurnId !== event.payload.turnId)
        ) {
          return false;
        }
        blockedThreadIds.delete(threadId);
        break;
      }
      case "thread.deleted":
        blockedThreadIds.delete(threadId);
        lastStartedTurnIdByThreadId.delete(threadId);
        break;
    }
    return true;
  };

  const dispatchHead = Effect.fn("QueuedTurnReactor.dispatchHead")(function* (threadId: ThreadId) {
    if (blockedThreadIds.has(threadId)) {
      return;
    }

    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    const queuedTurn = thread?.queuedTurns[0];
    if (!thread || !queuedTurn) {
      return;
    }
    if (thread.session?.status === "starting" || thread.session?.status === "running") {
      return;
    }

    // Reserve the thread before dispatch. The resulting turn-start event keeps
    // it reserved until the durable quiescence event arrives.
    blockedThreadIds.add(threadId);
    const commandId = CommandId.make(`server:queued-turn-dispatch:${yield* crypto.randomUUIDv4}`);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* orchestrationEngine
      .dispatch({
        type: "thread.queued-turn.dispatch",
        commandId,
        threadId,
        messageId: queuedTurn.messageId,
        createdAt,
      })
      .pipe(
        Effect.tapError(() => Effect.sync(() => blockedThreadIds.delete(threadId))),
        Effect.asVoid,
      );
  });

  const processEvent = Effect.fn("QueuedTurnReactor.processEvent")(function* (
    event: QueueReactorEvent,
  ) {
    switch (event.type) {
      case "thread.turn-start-requested":
        applyLifecycleEvent(event);
        return;
      case "thread.turn-quiesced":
        if (applyLifecycleEvent(event) && bootstrapped) {
          yield* dispatchHead(event.payload.threadId);
        }
        return;
      case "thread.session-set":
        {
          const pendingProviderStart =
            lastStartedTurnIdByThreadId.get(event.payload.threadId) === null;
          applyLifecycleEvent(event);
          if (
            pendingProviderStart &&
            bootstrapped &&
            (event.payload.session.status === "error" ||
              event.payload.session.status === "interrupted" ||
              event.payload.session.status === "stopped")
          ) {
            yield* dispatchHead(event.payload.threadId);
          }
        }
        return;
      case "thread.turn-enqueued":
      case "thread.queued-turn-cancelled":
        if (bootstrapped) {
          yield* dispatchHead(event.payload.threadId);
        }
        return;
      case "thread.deleted":
        applyLifecycleEvent(event);
        return;
    }
  });

  const processEventSafely = (event: QueueReactorEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("queued turn reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);
  const enqueueRelevantEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.turn-start-requested":
      case "thread.turn-enqueued":
      case "thread.queued-turn-cancelled":
      case "thread.turn-quiesced":
      case "thread.session-set":
      case "thread.deleted":
        return worker.enqueue(event);
      default:
        return Effect.void;
    }
  };

  const start: QueuedTurnReactorShape["start"] = Effect.fn("start")(function* () {
    // Subscribe before replaying. Live events are queued but cannot dispatch
    // until replay has rebuilt the durable blocked-thread set.
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, enqueueRelevantEvent),
    );

    yield* Stream.runForEach(
      eventStore.readFromSequence(0, Number.MAX_SAFE_INTEGER, [
        "thread.turn-start-requested",
        "thread.turn-quiesced",
        "thread.session-set",
        "thread.deleted",
      ]),
      (event) => {
        switch (event.type) {
          case "thread.turn-start-requested":
          case "thread.turn-quiesced":
          case "thread.session-set":
          case "thread.deleted":
            applyLifecycleEvent(event);
            break;
        }
        return Effect.void;
      },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn reactor failed to rebuild durable state", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    bootstrapped = true;
    const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn reactor failed to read startup snapshot", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
    if (snapshot !== null) {
      yield* Effect.forEach(
        snapshot.threads.filter((thread) => thread.queuedTurns.length > 0),
        (thread) => dispatchHead(thread.id).pipe(Effect.catchCause(() => Effect.void)),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    }
  });

  return {
    start,
    drain: worker.drain,
  } satisfies QueuedTurnReactorShape;
});

export const QueuedTurnReactorLive = Layer.effect(QueuedTurnReactor, make);
