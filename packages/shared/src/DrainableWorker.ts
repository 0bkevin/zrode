/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

export interface PartitionedDrainableWorker<A> {
  /** Enqueue work while preserving FIFO order with other items in its partition. */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /** Resolves after every item accepted before or during the drain has finished. */
  readonly drain: Effect.Effect<void>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

/**
 * Create a worker that is serial within each key but concurrent across keys.
 *
 * This is useful for multiplexed event streams: one noisy partition cannot
 * block unrelated partitions, while events belonging to the same partition
 * retain their source order. Concurrency is bounded so a burst spanning many
 * keys cannot create unbounded active work.
 */
export const makePartitionedDrainableWorker = <A, K, E = never>(options: {
  readonly concurrency: number;
  readonly key: (item: A) => K;
  readonly process: (item: A) => Effect.Effect<void, E>;
}): Effect.Effect<PartitionedDrainableWorker<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    type SchedulerMessage =
      | { readonly kind: "item"; readonly key: K; readonly item: A }
      | { readonly kind: "completed"; readonly key: K };

    const concurrency = Math.max(1, Math.floor(options.concurrency));
    const inputQueue = yield* Effect.acquireRelease(
      TxQueue.unbounded<Extract<SchedulerMessage, { kind: "item" }>>(),
      TxQueue.shutdown,
    );
    const completionQueue = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);
    const pendingByKey = new Map<K, Array<A>>();
    const readyKeys: Array<K> = [];
    const activeKeys = new Set<K>();

    const startReadyItems = Effect.fn("PartitionedDrainableWorker.startReadyItems")(function* () {
      while (activeKeys.size < concurrency && readyKeys.length > 0) {
        const key = readyKeys.shift()!;
        const pending = pendingByKey.get(key);
        if (!pending || pending.length === 0) {
          pendingByKey.delete(key);
          continue;
        }
        const item = pending.shift() as A;
        if (pending.length === 0) {
          pendingByKey.delete(key);
        }
        activeKeys.add(key);
        yield* options
          .process(item)
          .pipe(Effect.ensuring(TxQueue.offer(completionQueue, key)), Effect.forkChild);
      }
    });

    const takeSchedulerMessage = Effect.gen(function* () {
      const completedKey = yield* TxQueue.poll(completionQueue);
      return Option.isSome(completedKey)
        ? ({ kind: "completed", key: completedKey.value } as const)
        : yield* TxQueue.take(inputQueue);
    }).pipe(Effect.tx);

    yield* takeSchedulerMessage.pipe(
      Effect.tap((message) =>
        Effect.gen(function* () {
          if (message.kind === "item") {
            const pending = pendingByKey.get(message.key);
            if (pending) {
              pending.push(message.item);
            } else {
              pendingByKey.set(message.key, [message.item]);
              if (!activeKeys.has(message.key)) {
                readyKeys.push(message.key);
              }
            }
          } else {
            activeKeys.delete(message.key);
            yield* TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx);
            if (pendingByKey.has(message.key)) {
              // Rejoin at the back of the queue. This round-robin handoff is
              // what prevents a continuously hot key from starving its peers.
              readyKeys.push(message.key);
            }
          }
          yield* startReadyItems();
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueue: PartitionedDrainableWorker<A>["enqueue"] = (item) =>
      TxQueue.offer(inputQueue, { kind: "item", key: options.key(item), item }).pipe(
        Effect.tap(() => TxRef.update(outstanding, (count) => count + 1)),
        Effect.tx,
        Effect.asVoid,
      );

    const drain: PartitionedDrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    return { enqueue, drain } satisfies PartitionedDrainableWorker<A>;
  });
