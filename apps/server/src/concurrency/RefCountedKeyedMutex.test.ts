import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { makeRefCountedKeyedMutex } from "./RefCountedKeyedMutex.ts";

it.effect("serializes borrowers for the same key without evicting queued waiters", () =>
  Effect.gen(function* () {
    const mutex = yield* makeRefCountedKeyedMutex<string>();
    const releaseFirst = yield* Deferred.make<void>();
    const releaseSecond = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const thirdEntered = yield* Deferred.make<void>();

    const first = yield* mutex
      .withLock("thread-1", Deferred.await(releaseFirst))
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;

    const second = yield* mutex
      .withLock(
        "thread-1",
        Deferred.succeed(secondEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSecond)),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;

    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Deferred.await(secondEntered);

    const third = yield* mutex
      .withLock("thread-1", Deferred.succeed(thirdEntered, undefined))
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.isFalse(yield* Deferred.isDone(thirdEntered));

    yield* Deferred.succeed(releaseSecond, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* Fiber.join(third);
    assert.isTrue(yield* Deferred.isDone(thirdEntered));
    assert.strictEqual(yield* mutex.activeKeyCount, 0);
  }),
);

it.effect("allows different keys to run concurrently", () =>
  Effect.gen(function* () {
    const mutex = yield* makeRefCountedKeyedMutex<string>();
    const release = yield* Deferred.make<void>();
    const entered = yield* Ref.make<ReadonlySet<string>>(new Set());
    const enter = (key: string) =>
      Ref.update(entered, (keys) => new Set(keys).add(key)).pipe(
        Effect.andThen(Deferred.await(release)),
      );

    const first = yield* mutex.withLock("thread-1", enter("thread-1")).pipe(Effect.forkScoped);
    const second = yield* mutex.withLock("thread-2", enter("thread-2")).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;

    assert.deepStrictEqual(yield* Ref.get(entered), new Set(["thread-1", "thread-2"]));
    assert.strictEqual(yield* mutex.activeKeyCount, 2);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.strictEqual(yield* mutex.activeKeyCount, 0);
  }),
);

it.effect("releases a borrower interrupted while waiting", () =>
  Effect.gen(function* () {
    const mutex = yield* makeRefCountedKeyedMutex<string>();
    const releaseHolder = yield* Deferred.make<void>();
    const holder = yield* mutex
      .withLock("thread-1", Deferred.await(releaseHolder))
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;

    const waiter = yield* mutex.withLock("thread-1", Effect.never).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.strictEqual(yield* mutex.activeKeyCount, 1);

    yield* Fiber.interrupt(waiter);
    assert.strictEqual(yield* mutex.activeKeyCount, 1);

    yield* Deferred.succeed(releaseHolder, undefined);
    yield* Fiber.join(holder);
    assert.strictEqual(yield* mutex.activeKeyCount, 0);
  }),
);

it.effect("evicts the key after guarded work fails or defects", () =>
  Effect.gen(function* () {
    const mutex = yield* makeRefCountedKeyedMutex<string>();
    yield* mutex.withLock("thread-1", Effect.fail("typed failure")).pipe(Effect.exit);
    assert.strictEqual(yield* mutex.activeKeyCount, 0);

    yield* mutex.withLock("thread-1", Effect.die("simulated defect")).pipe(Effect.exit);
    assert.strictEqual(yield* mutex.activeKeyCount, 0);

    const result = yield* mutex.withLock("thread-1", Effect.succeed("recovered"));
    assert.strictEqual(result, "recovered");
    assert.strictEqual(yield* mutex.activeKeyCount, 0);
  }),
);

it.effect("evicts independently released last borrowers without losing a live entry", () =>
  Effect.gen(function* () {
    const mutex = yield* makeRefCountedKeyedMutex<string>();
    const release = yield* Deferred.make<void>();
    const first = yield* mutex
      .withLock("thread-1", Deferred.await(release))
      .pipe(Effect.forkScoped);
    const second = yield* mutex
      .withLock("thread-2", Deferred.await(release))
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.strictEqual(yield* mutex.activeKeyCount, 2);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first).pipe(Effect.zip(Fiber.join(second), { concurrent: true }));
    assert.strictEqual(yield* mutex.activeKeyCount, 0);

    yield* mutex.withLock("thread-1", Effect.void);
    assert.strictEqual(yield* mutex.activeKeyCount, 0);
  }),
);

it.effect("does not retain thousands of transient keys", () =>
  Effect.gen(function* () {
    const mutex = yield* makeRefCountedKeyedMutex<string>();
    const keyCount = 5_000;

    yield* Effect.forEach(
      Array.from({ length: keyCount }, (_, index) => `thread-${index}`),
      (key) => mutex.withLock(key, Effect.void),
      { concurrency: 64, discard: true },
    );

    assert.strictEqual(yield* mutex.activeKeyCount, 0);
  }),
);
