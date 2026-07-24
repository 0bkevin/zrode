import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  ThreadSnapshotLoader,
  type ThreadSnapshotLoadResult,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  handoffSource: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  queuedTurns: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

type TestThreadInput = OrchestrationThreadStreamItem | Error;

function testSession(
  client: WsRpcProtocolClient,
  options?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(
      options?.completionMarker === true
        ? ({ threadResumeCompletionMarker: true } as never)
        : ({} as never),
    ),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationThread;
  readonly completionMarker?: boolean;
  readonly snapshotLoadResult?: ThreadSnapshotLoadResult;
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const snapshotLoadCount = yield* Ref.make(0);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make<boolean | undefined>(undefined);
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: {
      readonly afterSequence?: number;
      readonly requestCompletionMarker?: boolean;
    }) =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
          Effect.andThen(Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker)),
          Effect.map(() => streamFrom(inputs)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client, options)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              thread: options.cached,
            })
          : Option.none(),
      ),
    saveThread: (_environmentId, thread) =>
      Ref.update(savedThreads, (current) => [...current, thread]),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    clear: () => Effect.void,
  });
  const threadState = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(
      ThreadSnapshotLoader,
      ThreadSnapshotLoader.of({
        load: () =>
          Ref.update(snapshotLoadCount, (count) => count + 1).pipe(
            Effect.as(options?.snapshotLoadResult ?? { kind: "unavailable" as const }),
          ),
      }),
    ),
  );
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    snapshotLoadCount,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    lastSubscribeAfterSequence,
    lastRequestCompletionMarker,
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(testSession(client, options)),
    ),
  };
});

const snapshot = (
  thread: OrchestrationThread,
  snapshotSequence = 1,
): OrchestrationThreadStreamItem => ({
  kind: "snapshot",
  snapshot: {
    snapshotSequence,
    thread,
  },
});

const synchronized = (sequence = CACHED_SNAPSHOT_SEQUENCE): OrchestrationThreadStreamItem => ({
  kind: "synchronized",
  sequence,
});

const titleUpdated = (title: string, sequence = 2): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-title"),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title,
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  },
});

const deleted = (): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-deleted"),
    sequence: 3,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.deleted",
    payload: {
      threadId: THREAD_ID,
      deletedAt: "2026-04-01T02:00:00.000Z",
    },
  },
});

const streamingDelta = (text: string, sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-stream-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.message-sent",
    payload: {
      threadId: THREAD_ID,
      messageId: MessageId.make("assistant-1"),
      role: "assistant",
      text,
      turnId: null,
      streaming: true,
      createdAt: "2026-04-01T01:00:00.000Z",
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  },
});

const streamingCompleted = (sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-stream-completed-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T01:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.message-sent",
    payload: {
      threadId: THREAD_ID,
      messageId: MessageId.make("assistant-1"),
      role: "assistant",
      text: "",
      turnId: null,
      streaming: false,
      createdAt: "2026-04-01T01:00:00.000Z",
      updatedAt: "2026-04-01T01:00:01.000Z",
    },
  },
});

describe("EnvironmentThreads", () => {
  it.effect("publishes cached data before a live snapshot arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "cached" && Option.isSome(value.data),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("resumes from the persisted cursor and stays synchronizing through catch-up", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_THREAD,
        completionMarker: true,
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.lastRequestCompletionMarker)) === true) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Caught-up title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "synchronizing" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Caught-up title",
      );
      expect(catchingUp.status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Caught-up title",
      );
      expect(live.status).toBe("live");
    }),
  );

  it.effect("advances an unchanged thread cursor to the synchronized global sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_THREAD,
        completionMarker: true,
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      yield* Queue.offer(harness.inputs, synchronized(2_000));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) === 2) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(2_000);
    }),
  );

  it.effect("parks a terminal HTTP-missing thread without opening a retrying socket stream", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        completionMarker: true,
        snapshotLoadResult: { kind: "missing" },
      });
      const missing = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(missing.data)).toBe(true);
      expect(yield* Ref.get(harness.snapshotLoadCount)).toBe(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);

      yield* TestClock.adjust("2 seconds");
      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.snapshotLoadCount)).toBe(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.thread.title).toBe("Live title");
    }),
  );

  it.effect("coalesces streaming message deltas before publishing thread state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );

      yield* Queue.offer(harness.inputs, streamingDelta("hello ", 2));
      yield* Queue.offer(harness.inputs, streamingDelta("world", 3));
      // Let the subscription consume both inputs and arm its presentation
      // delay before advancing the virtual clock.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).messages).toEqual([]);

      yield* TestClock.adjust("40 millis");
      const streamed = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) && value.data.value.messages[0]?.text === "hello world",
      );
      expect(Option.getOrThrow(streamed.data).messages).toHaveLength(1);
    }),
  );

  it.effect("flushes pending text immediately when a streaming message completes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );

      yield* Queue.offer(harness.inputs, streamingDelta("complete text", 2));
      yield* Queue.offer(harness.inputs, streamingCompleted(3));
      const completed = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages[0]?.streaming === false,
      );
      expect(Option.getOrThrow(completed.data).messages[0]?.text).toBe("complete text");

      // A queued presentation signal from the delta must be harmless after
      // the immediate completion flush.
      yield* TestClock.adjust("80 millis");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).messages[0]?.text).toBe(
        "complete text",
      );
    }),
  );

  it.effect("discards pending pre-snapshot deltas instead of duplicating snapshot text", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );

      yield* Queue.offer(harness.inputs, streamingDelta("stale delta", 2));
      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_THREAD,
            messages: [
              {
                id: MessageId.make("assistant-1"),
                role: "assistant",
                text: "authoritative snapshot",
                turnId: null,
                streaming: false,
                createdAt: "2026-04-01T01:00:00.000Z",
                updatedAt: "2026-04-01T01:00:01.000Z",
              },
            ],
          },
          3,
        ),
      );

      const restored = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.messages[0]?.text === "authoritative snapshot",
      );
      yield* TestClock.adjust("80 millis");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(Option.getOrThrow(restored.data).messages[0]?.text).toBe("authoritative snapshot");
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).messages[0]?.text).toBe(
        "authoritative snapshot",
      );
    }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
    }),
  );

  it.effect("removes cached data when the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Recovered thread",
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Materialized thread",
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );
});
