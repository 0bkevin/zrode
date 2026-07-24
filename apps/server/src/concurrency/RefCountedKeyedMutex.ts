import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

interface KeyedMutexEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly borrowers: number;
}

interface KeyedMutexLease {
  readonly semaphore: Semaphore.Semaphore;
}

export interface RefCountedKeyedMutex<K> {
  readonly withLock: <A, E, R>(key: K, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Number of keys currently borrowed by running or waiting effects.
   *
   * This is intentionally read-only and primarily useful for diagnostics and
   * tests; callers cannot observe or mutate individual lock entries.
   */
  readonly activeKeyCount: Effect.Effect<number>;
}

/**
 * Creates a keyed mutex whose entries live only while they have borrowers.
 *
 * A borrower is counted before it waits for the semaphore. Acquisition and
 * release are bracketed so failures, defects, and interruption while waiting
 * cannot leak a count. The identity check on release prevents an obsolete
 * lease from deleting a newer entry for the same key.
 */
export const makeRefCountedKeyedMutex = Effect.fn("makeRefCountedKeyedMutex")(function* <
  K,
>(): Effect.fn.Return<RefCountedKeyedMutex<K>> {
  const entriesRef = yield* Ref.make<ReadonlyMap<K, KeyedMutexEntry>>(new Map());

  const acquire = (key: K) =>
    Ref.modify(entriesRef, (entries) => {
      const existing = entries.get(key);
      const semaphore = existing?.semaphore ?? Semaphore.makeUnsafe(1);
      const next = new Map(entries);
      next.set(key, {
        semaphore,
        borrowers: (existing?.borrowers ?? 0) + 1,
      });
      return [{ semaphore } satisfies KeyedMutexLease, next] as const;
    });

  const release = (key: K, lease: KeyedMutexLease) =>
    Ref.update(entriesRef, (entries) => {
      const current = entries.get(key);
      if (current === undefined || current.semaphore !== lease.semaphore) {
        return entries;
      }

      const next = new Map(entries);
      if (current.borrowers === 1) {
        next.delete(key);
      } else {
        next.set(key, {
          semaphore: current.semaphore,
          borrowers: current.borrowers - 1,
        });
      }
      return next;
    });

  const withLock: RefCountedKeyedMutex<K>["withLock"] = (key, effect) =>
    Effect.acquireUseRelease(
      acquire(key),
      (lease) => lease.semaphore.withPermit(effect),
      (lease) => release(key, lease),
    );

  return {
    withLock,
    activeKeyCount: Ref.get(entriesRef).pipe(Effect.map((entries) => entries.size)),
  };
});
