import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeDrainableWorker, makePartitionedDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makePartitionedDrainableWorker", () => {
  it.live("lets another key progress while a noisy key is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstAStarted = yield* Deferred.make<void>();
        const releaseFirstA = yield* Deferred.make<void>();
        const bProcessed = yield* Deferred.make<void>();
        const processed: string[] = [];

        const worker = yield* makePartitionedDrainableWorker<string, string>({
          concurrency: 2,
          key: (item) => item.slice(0, 1),
          process: (item) =>
            Effect.gen(function* () {
              if (item === "a1") {
                yield* Deferred.succeed(firstAStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirstA);
              }
              processed.push(item);
              if (item === "b1") {
                yield* Deferred.succeed(bProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("a1");
        yield* Deferred.await(firstAStarted);
        yield* worker.enqueue("a2");
        yield* worker.enqueue("b1");

        yield* Deferred.await(bProcessed);
        expect(processed).toEqual(["b1"]);

        yield* Deferred.succeed(releaseFirstA, undefined);
        yield* worker.drain;
        expect(processed).toEqual(["b1", "a1", "a2"]);
      }),
    ),
  );

  it.live("preserves FIFO order per key under sustained interleaved load", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed = new Map<string, number[]>();
        let active = 0;
        let maxActive = 0;
        const threeStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const worker = yield* makePartitionedDrainableWorker<
          { readonly key: string; readonly index: number },
          string
        >({
          concurrency: 3,
          key: (item) => item.key,
          process: (item) =>
            Effect.gen(function* () {
              active += 1;
              maxActive = Math.max(maxActive, active);
              if (active === 3) {
                yield* Deferred.succeed(threeStarted, undefined).pipe(Effect.orDie);
              }
              yield* Deferred.await(release);
              const entries = processed.get(item.key) ?? [];
              entries.push(item.index);
              processed.set(item.key, entries);
              active -= 1;
            }),
        });

        for (let index = 0; index < 100; index += 1) {
          yield* worker.enqueue({ key: `key-${index % 5}`, index: Math.floor(index / 5) });
        }
        yield* Deferred.await(threeStarted);
        expect(maxActive).toBe(3);
        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;

        const expected = Array.from({ length: 20 }, (_, index) => index);
        for (let keyIndex = 0; keyIndex < 5; keyIndex += 1) {
          expect(processed.get(`key-${keyIndex}`)).toEqual(expected);
        }
        expect(maxActive).toBeLessThanOrEqual(3);
      }),
    ),
  );

  it.live("continues the same partition after an item fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const worker = yield* makePartitionedDrainableWorker<string, string, string>({
          concurrency: 1,
          key: () => "same-key",
          process: (item) => {
            processed.push(item);
            return item === "failed" ? Effect.fail("expected failure") : Effect.void;
          },
        });

        yield* worker.enqueue("failed");
        yield* worker.enqueue("after-failure");
        yield* worker.drain;

        expect(processed).toEqual(["failed", "after-failure"]);
      }),
    ),
  );
});
