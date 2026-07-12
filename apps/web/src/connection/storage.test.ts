import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import {
  DATABASE_OPEN_BLOCKED_TIMEOUT_MS,
  makeCatalogBackend,
  makeCatalogStore,
  openDatabase,
} from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openDatabase", () => {
  it.effect("closes an open connection when another window requests an upgrade", () =>
    Effect.gen(function* () {
      const requestListeners = new Map<string, () => void>();
      const databaseListeners = new Map<string, () => void>();
      const database = {
        objectStoreNames: { contains: vi.fn(() => true) },
        createObjectStore: vi.fn(),
        addEventListener: vi.fn((event: string, listener: () => void) => {
          databaseListeners.set(event, listener);
        }),
        close: vi.fn(),
      };
      vi.stubGlobal("indexedDB", {
        open: vi.fn(() => ({
          result: database,
          error: null,
          addEventListener: (event: string, listener: () => void) => {
            requestListeners.set(event, listener);
          },
        })),
      });

      const opened = yield* openDatabase().pipe(Effect.forkChild({ startImmediately: true }));
      requestListeners.get("success")?.();
      expect(yield* Fiber.join(opened)).toBe(database);
      databaseListeners.get("versionchange")?.();
      expect(database.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("fails a database open that remains blocked by another window", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const requestListeners = new Map<string, () => void>();
      const database = { close: vi.fn() };
      vi.stubGlobal("indexedDB", {
        open: vi.fn(() => ({
          result: database,
          error: null,
          addEventListener: (event: string, listener: () => void) => {
            requestListeners.set(event, listener);
          },
        })),
      });

      const opened = yield* openDatabase().pipe(Effect.forkChild({ startImmediately: true }));
      requestListeners.get("blocked")?.();
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(DATABASE_OPEN_BLOCKED_TIMEOUT_MS));
      const error = yield* Fiber.join(opened).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);

      requestListeners.get("success")?.();
      expect(database.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("aborts a failed schema upgrade so IndexedDB cannot commit a partial version", () =>
    Effect.gen(function* () {
      const requestListeners = new Map<string, () => void>();
      const transaction = { abort: vi.fn() };
      const upgradeFailure = new Error("createObjectStore failed");
      vi.stubGlobal("indexedDB", {
        open: vi.fn(() => ({
          result: {
            objectStoreNames: { contains: vi.fn(() => false) },
            createObjectStore: vi.fn(() => {
              throw upgradeFailure;
            }),
          },
          transaction,
          error: null,
          addEventListener: (event: string, listener: () => void) => {
            requestListeners.set(event, listener);
          },
        })),
      });

      const opened = yield* openDatabase().pipe(Effect.forkChild({ startImmediately: true }));
      requestListeners.get("upgradeneeded")?.();
      const error = yield* Fiber.join(opened).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(transaction.abort).toHaveBeenCalledOnce();
    }),
  );
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});
