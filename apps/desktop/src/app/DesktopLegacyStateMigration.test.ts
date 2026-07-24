// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated native SQLite fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ZRODE_DATABASE_MIGRATION_NAMES_BY_ID } from "@t3tools/shared/zrodeDatabaseMigrations";

import type * as Electron from "electron";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyStateMigration from "./DesktopLegacyStateMigration.ts";

function createLegacyDatabase(baseDir: string): void {
  const stateDir = NodePath.join(baseDir, "userdata");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "state.sqlite"));
  try {
    database.exec(`
      CREATE TABLE effect_sql_migrations (
        migration_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE orchestration_events (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        command_id TEXT,
        causation_event_id TEXT,
        correlation_id TEXT,
        actor_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      INSERT INTO orchestration_events VALUES (
        1,
        'event-1',
        'thread',
        'thread-1',
        1,
        'thread.created',
        '2026-07-23T18:00:00.000Z',
        'command-1',
        NULL,
        'command-1',
        'client',
        '{}',
        '{}'
      );
      CREATE TABLE projection_threads (
        thread_id TEXT PRIMARY KEY,
        handoff_source_json TEXT
      );
      INSERT INTO projection_threads (thread_id) VALUES ('thread-1');
      CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY);
      INSERT INTO projection_thread_messages VALUES ('message-1');
      CREATE TABLE projection_thread_turn_queue (message_id TEXT PRIMARY KEY);
      CREATE TABLE projection_pending_approvals (request_id TEXT PRIMARY KEY);
      CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL);
      INSERT INTO provider_session_runtime VALUES ('thread-1', 'running');
    `);
    const insertMigration = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    for (const [migrationId, name] of Object.entries(ZRODE_DATABASE_MIGRATION_NAMES_BY_ID)) {
      if (Number(migrationId) <= 45) {
        insertMigration.run(Number(migrationId), name);
      }
    }
  } finally {
    database.close();
  }
}

function withTempRoots<A, E, R>(
  run: (input: {
    readonly root: string;
    readonly sourceBaseDir: string;
    readonly destinationBaseDir: string;
  }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zrode-desktop-migration-"));
      return {
        root,
        sourceBaseDir: NodePath.join(root, ".t3"),
        destinationBaseDir: NodePath.join(root, ".zrode"),
      };
    }),
    run,
    ({ root }) =>
      Effect.sync(() => {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }),
  );
}

function makeEnvironment(
  sourceBaseDir: string,
  destinationBaseDir: string,
  overrides: Partial<DesktopEnvironment.DesktopEnvironment["Service"]> = {},
) {
  return DesktopEnvironment.DesktopEnvironment.of({
    legacyBaseDir: sourceBaseDir,
    baseDir: destinationBaseDir,
    appVersion: "0.0.28",
    isDevelopment: false,
    isPackaged: true,
    usesDefaultBaseDir: true,
    ...overrides,
  } as DesktopEnvironment.DesktopEnvironment["Service"]);
}

function makeWindowService(created: { count: number }) {
  const browserWindow = {
    loadURL: () => Promise.resolve(),
    show: () => undefined,
    setProgressBar: () => undefined,
    setTitle: () => undefined,
    isDestroyed: () => false,
    destroy: () => undefined,
  } as unknown as Electron.BrowserWindow;
  return ElectronWindow.ElectronWindow.of({
    create: () =>
      Effect.sync(() => {
        created.count += 1;
        return browserWindow;
      }),
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(Option.none()),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  });
}

function runMigrationService(input: {
  readonly environment: DesktopEnvironment.DesktopEnvironment["Service"];
  readonly responses: number[];
  readonly dialogTitles: string[];
  readonly createdWindows: { count: number };
}) {
  const dialog = ElectronDialog.ElectronDialog.of({
    pickFolder: () => Effect.succeed(Option.none()),
    confirm: () => Effect.succeed(false),
    showErrorBox: () => Effect.void,
    showMessageBox: (options) =>
      Effect.sync(() => {
        input.dialogTitles.push(options.title ?? "");
        return {
          response: input.responses.shift() ?? 0,
          checkboxChecked: false,
        };
      }),
  });
  const layer = DesktopLegacyStateMigration.layer.pipe(
    Layer.provideMerge(Layer.succeed(DesktopEnvironment.DesktopEnvironment, input.environment)),
    Layer.provideMerge(Layer.succeed(ElectronDialog.ElectronDialog, dialog)),
    Layer.provideMerge(
      Layer.succeed(ElectronWindow.ElectronWindow, makeWindowService(input.createdWindows)),
    ),
  );
  return DesktopLegacyStateMigration.DesktopLegacyStateMigration.pipe(
    Effect.flatMap((migration) => migration.run),
    Effect.provide(layer),
  );
}

describe("DesktopLegacyStateMigration", () => {
  it.effect("does nothing when there is no legacy database", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        const dialogTitles: string[] = [];
        const createdWindows = { count: 0 };
        const result = yield* runMigrationService({
          environment: makeEnvironment(sourceBaseDir, destinationBaseDir),
          responses: [],
          dialogTitles,
          createdWindows,
        });

        assert.isTrue(result);
        assert.deepEqual(dialogTitles, []);
        assert.equal(createdWindows.count, 0);
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
      }),
    ),
  );

  it.effect("records an explicit start-fresh decision without opening a copy window", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyDatabase(sourceBaseDir);
        const dialogTitles: string[] = [];
        const createdWindows = { count: 0 };
        const result = yield* runMigrationService({
          environment: makeEnvironment(sourceBaseDir, destinationBaseDir),
          responses: [1],
          dialogTitles,
          createdWindows,
        });

        assert.isTrue(result);
        assert.deepEqual(dialogTitles, ["Separate Zrode from T3 Code"]);
        assert.equal(createdWindows.count, 0);
        assert.isTrue(
          NodeFS.existsSync(
            NodePath.join(destinationBaseDir, "userdata", "legacy-state-migration.json"),
          ),
        );
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(destinationBaseDir, "userdata", "state.sqlite")),
        );
      }),
    ),
  );

  it.effect("imports history, resets runtime ownership, and shows progress", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyDatabase(sourceBaseDir);
        const dialogTitles: string[] = [];
        const createdWindows = { count: 0 };
        const result = yield* runMigrationService({
          environment: makeEnvironment(sourceBaseDir, destinationBaseDir),
          responses: [0, 0],
          dialogTitles,
          createdWindows,
        });

        assert.isTrue(result);
        assert.deepEqual(dialogTitles, ["Separate Zrode from T3 Code", "Zrode history imported"]);
        assert.equal(createdWindows.count, 1);
        const database = new NodeSqlite.DatabaseSync(
          NodePath.join(destinationBaseDir, "userdata", "state.sqlite"),
          { readOnly: true },
        );
        try {
          const runtimeCount = database
            .prepare("SELECT COUNT(*) AS value FROM provider_session_runtime")
            .get() as { readonly value: number };
          assert.equal(runtimeCount.value, 0);
        } finally {
          database.close();
        }
      }),
    ),
  );

  it.effect("does not auto-migrate an explicitly configured ZRODE_HOME", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyDatabase(sourceBaseDir);
        const dialogTitles: string[] = [];
        const createdWindows = { count: 0 };
        const result = yield* runMigrationService({
          environment: makeEnvironment(sourceBaseDir, destinationBaseDir, {
            usesDefaultBaseDir: false,
          }),
          responses: [],
          dialogTitles,
          createdWindows,
        });

        assert.isTrue(result);
        assert.deepEqual(dialogTitles, []);
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
      }),
    ),
  );
});
