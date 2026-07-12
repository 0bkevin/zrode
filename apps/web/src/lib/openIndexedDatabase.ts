import * as Effect from "effect/Effect";

export const INDEXED_DATABASE_OPEN_BLOCKED_TIMEOUT_MS = 5_000;

export function openIndexedDatabase<E>(input: {
  readonly name: string;
  readonly version: number;
  readonly upgrade: (database: IDBDatabase) => void;
  readonly mapError: (cause: unknown) => E;
  readonly blockedTimeoutMs?: number;
}): Effect.Effect<IDBDatabase, E> {
  return Effect.callback<IDBDatabase, E>((resume) => {
    if (typeof indexedDB === "undefined") {
      resume(Effect.fail(input.mapError("IndexedDB is unavailable in this browser context.")));
      return;
    }

    const blockedTimeoutMs = input.blockedTimeoutMs ?? INDEXED_DATABASE_OPEN_BLOCKED_TIMEOUT_MS;
    const request = indexedDB.open(input.name, input.version);
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    const clearBlockedTimer = () => {
      if (blockedTimer === null) return;
      clearTimeout(blockedTimer);
      blockedTimer = null;
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      clearBlockedTimer();
      resume(Effect.fail(input.mapError(cause)));
    };

    request.addEventListener("upgradeneeded", () => {
      try {
        input.upgrade(request.result);
      } catch (cause) {
        // Swallowing an upgrade exception without aborting allows IndexedDB to
        // commit a partially-created schema at the new version. That leaves
        // subsequent opens unable to retry the migration. Abort first so the
        // browser rolls the versionchange transaction back atomically.
        try {
          request.transaction?.abort();
        } catch {
          // Preserve the original migration failure. The open request's error
          // event may race this callback, but fail() is intentionally idempotent.
        }
        fail(cause);
      }
    });
    request.addEventListener("error", () => {
      fail(request.error ?? "Unknown IndexedDB error");
    });
    request.addEventListener("blocked", () => {
      if (settled || blockedTimer !== null) return;
      blockedTimer = setTimeout(() => {
        fail(`IndexedDB upgrade remained blocked for ${blockedTimeoutMs}ms by another window.`);
      }, blockedTimeoutMs);
    });
    request.addEventListener("success", () => {
      clearBlockedTimer();
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.addEventListener("versionchange", () => database.close());
      resume(Effect.succeed(database));
    });

    return Effect.sync(() => {
      settled = true;
      clearBlockedTimer();
    });
  });
}
