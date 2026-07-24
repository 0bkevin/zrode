import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
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
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
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

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
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
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
  });
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);
  const pendingStreamingEvents = yield* Ref.make<ReadonlyArray<StreamingMessageEvent>>([]);
  const pendingStreamingSignal = yield* Queue.sliding<void>(1);
  const reductionPermit = Semaphore.makeUnsafe(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
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
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: waiting ? "synchronizing" : "live",
      error: Option.none(),
    });
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, { snapshotSequence, thread });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
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
      SubscriptionRef.update(state, (current) =>
        current.status === "deleted"
          ? current
          : {
              ...current,
              status: "synchronizing" as const,
              error: Option.none(),
            },
      ),
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
  const setDisconnected = Ref.set(awaitingCompletion, false).pipe(
    Effect.andThen(flushPendingStreamingEvents),
    Effect.andThen(
      SubscriptionRef.update(state, (current) => ({
        ...current,
        status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
      })),
    ),
  );
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(flushPendingStreamingEvents),
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
    if (item.kind === "synchronized") {
      yield* reductionPermit.withPermit(
        flushPendingStreamingEventsUnlocked().pipe(
          Effect.andThen(
            SubscriptionRef.update(lastSequence, (sequence) => Math.max(sequence, item.sequence)),
          ),
          Effect.andThen(Ref.set(awaitingCompletion, false)),
          Effect.andThen(
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(state);
              if (Option.isNone(current.data) || current.status === "deleted") {
                return;
              }
              yield* SubscriptionRef.set(state, {
                ...current,
                status: "live",
                error: Option.none(),
              });
              if (shouldPersistThread(current.data.value)) {
                yield* Queue.offer(persistence, {
                  snapshotSequence: yield* SubscriptionRef.get(lastSequence),
                  thread: current.data.value,
                });
              }
            }),
          ),
        ),
      );
      return;
    }

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

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter((reason) => reason === "application-active")),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        let current = yield* SubscriptionRef.get(state);
        if (current.status === "deleted") {
          return yield* Effect.never;
        }
        if (Option.isNone(current.data)) {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpSnapshot = yield* snapshotLoader.load(prepared, threadId);
          if (httpSnapshot.kind === "missing") {
            yield* setDeleted();
            return yield* Effect.never;
          }
          if (httpSnapshot.kind === "found") {
            yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.snapshot });
            current = yield* SubscriptionRef.get(state);
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }
        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  yield* Effect.addFinalizer(() =>
    flushPendingStreamingEvents.pipe(
      Effect.andThen(Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)])),
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread) ? persist({ snapshotSequence, thread }) : Effect.void,
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
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
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
export * from "./threadSnapshotHttp.ts";
export * from "./threadState.ts";
