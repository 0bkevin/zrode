import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe } from "../rpc/client.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

type StreamingMessageEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

function isStreamingMessageEvent(event: OrchestrationEvent): event is StreamingMessageEvent {
  return event.type === "thread.message-sent" && event.payload.streaming;
}

function appendStreamingMessageEvent(
  pending: ReadonlyArray<StreamingMessageEvent>,
  event: StreamingMessageEvent,
): ReadonlyArray<StreamingMessageEvent> {
  const previous = pending.at(-1);
  if (
    previous?.payload.messageId !== event.payload.messageId ||
    previous.payload.role !== event.payload.role ||
    previous.payload.turnId !== event.payload.turnId
  ) {
    return [...pending, event];
  }

  return [
    ...pending.slice(0, -1),
    {
      ...event,
      payload: {
        ...event.payload,
        text: `${previous.payload.text}${event.payload.text}`,
        createdAt: previous.payload.createdAt,
      },
    },
  ];
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThread>()),
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cached,
    status: statusWithoutLiveData(cached),
    error: Option.none(),
  });
  const lastSequence = yield* SubscriptionRef.make(0);
  const persistence = yield* Queue.sliding<OrchestrationThread>(1);
  const pendingStreamingEvents = yield* Ref.make<ReadonlyArray<StreamingMessageEvent>>([]);
  const pendingStreamingSignal = yield* Queue.sliding<void>(1);
  const reductionPermit = Semaphore.makeUnsafe(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    thread: OrchestrationThread,
  ) {
    yield* cache.saveThread(environmentId, thread).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
  ) {
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: "live",
      error: Option.none(),
    });
    yield* Queue.offer(persistence, thread);
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const flushPendingStreamingEventsUnlocked = Effect.fn(
    "EnvironmentThreadState.flushPendingStreamingEvents",
  )(function* () {
    const events = yield* Ref.getAndSet(pendingStreamingEvents, []);
    if (events.length === 0) {
      return;
    }

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      return;
    }

    let thread = current.data.value;
    let changed = false;
    for (const event of events) {
      const result = applyThreadDetailEvent(thread, event);
      if (result.kind === "updated") {
        thread = result.thread;
        changed = true;
      }
    }
    if (changed) {
      yield* setThread(thread);
    }
  });

  const flushPendingStreamingEvents = reductionPermit.withPermit(
    flushPendingStreamingEventsUnlocked(),
  );

  // Collapse token-sized events into one state publication per frame-sized
  // interval. The reducer still receives every byte in order, while React,
  // persistence, and derived timeline atoms avoid a render per provider token.
  yield* Queue.take(pendingStreamingSignal).pipe(
    Effect.delay("40 millis"),
    Effect.andThen(flushPendingStreamingEvents),
    Effect.forever,
    Effect.forkScoped,
  );

  const setSynchronizing = flushPendingStreamingEvents.pipe(
    Effect.andThen(
      SubscriptionRef.update(state, (current) => ({
        ...current,
        status: "synchronizing" as const,
        error: Option.none(),
      })),
    ),
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = flushPendingStreamingEvents.pipe(
    Effect.andThen(
      SubscriptionRef.update(state, (current) => ({
        ...current,
        status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
      })),
    ),
  );
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    flushPendingStreamingEvents.pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    if (item.kind === "snapshot") {
      yield* reductionPermit.withPermit(
        Ref.set(pendingStreamingEvents, []).pipe(
          Effect.andThen(SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence)),
          Effect.andThen(setThread(item.snapshot.thread)),
        ),
      );
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);

    if (isStreamingMessageEvent(item.event)) {
      const streamingEvent = item.event;
      yield* Ref.update(pendingStreamingEvents, (pending) =>
        appendStreamingMessageEvent(pending, streamingEvent),
      );
      yield* Queue.offer(pendingStreamingSignal, undefined);
      return;
    }

    yield* reductionPermit.withPermit(
      Effect.gen(function* () {
        yield* flushPendingStreamingEventsUnlocked();
        const current = yield* SubscriptionRef.get(state);
        if (Option.isNone(current.data)) {
          if (item.event.type === "thread.deleted") {
            yield* setDeleted();
          }
          return;
        }
        const result = applyThreadDetailEvent(current.data.value, item.event);
        if (result.kind === "updated") {
          yield* setThread(result.thread);
        } else if (result.kind === "deleted") {
          yield* setDeleted();
        }
      }),
    );
  });

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  yield* setSynchronizing;
  yield* subscribe(
    ORCHESTRATION_WS_METHODS.subscribeThread,
    { threadId },
    {
      onExpectedFailure: setStreamError,
      retryExpectedFailureAfter: "250 millis",
    },
  ).pipe(Stream.runForEach(applyItem), Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    flushPendingStreamingEvents.pipe(
      Effect.andThen(SubscriptionRef.get(state)),
      Effect.flatMap((current) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: persist,
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
