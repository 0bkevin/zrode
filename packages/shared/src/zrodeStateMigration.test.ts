// @effect-diagnostics nodeBuiltinImport:off - Migration tests exercise the native Node SQLite/filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  inspectZrodeStateMigration,
  migrateZrodeState,
  recordFreshZrodeStateDecision,
  ZRODE_MIGRATION_RECEIPT_FILE_NAME,
  ZRODE_MIGRATION_STAGING_MARKER_FILE_NAME,
  ZrodeStateMigrationBusyStateError,
  ZrodeStateMigrationCompatibilityError,
  ZrodeStateMigrationDestinationConflictError,
  ZrodeStateMigrationError,
  ZrodeStateMigrationInsufficientSpaceError,
  ZrodeStateMigrationSourceChangedError,
} from "./zrodeStateMigration.ts";
import { ZRODE_DATABASE_MIGRATION_NAMES_BY_ID } from "./zrodeDatabaseMigrations.ts";

const AVAILABLE_BYTES = 10 * 1024 * 1024 * 1024;
const NOW = "2026-07-23T18:00:00.000Z";

interface FixtureOptions {
  readonly queuedTurnCount?: number;
  readonly pendingApprovalCount?: number;
  readonly largePayloadBytes?: number;
}

function createLegacyState(baseDir: string, options: FixtureOptions = {}): void {
  const stateDir = NodePath.join(baseDir, "userdata");
  NodeFS.mkdirSync(NodePath.join(stateDir, "attachments"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(stateDir, "secrets"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(stateDir, "settings.json"), '{"setting":true}\n');
  NodeFS.writeFileSync(NodePath.join(stateDir, "client-settings.json"), '{"theme":"dark"}\n');
  NodeFS.writeFileSync(NodePath.join(stateDir, "keybindings.json"), '{"key":"value"}\n');
  NodeFS.writeFileSync(NodePath.join(stateDir, "attachments", "image.txt"), "attachment");
  NodeFS.writeFileSync(NodePath.join(stateDir, "connection-catalog.json"), "do-not-copy");
  NodeFS.writeFileSync(NodePath.join(stateDir, "environment-id"), "legacy-environment");
  NodeFS.writeFileSync(NodePath.join(stateDir, "server-runtime.json"), '{"pid":123}');
  NodeFS.writeFileSync(NodePath.join(stateDir, "cloud-auth-token.json"), "legacy-cloud-token");
  NodeFS.writeFileSync(NodePath.join(stateDir, "secrets", "server-signing-key.bin"), "secret");

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
      INSERT INTO orchestration_events (
        sequence,
        event_id,
        aggregate_kind,
        stream_id,
        stream_version,
        event_type,
        occurred_at,
        command_id,
        causation_event_id,
        correlation_id,
        actor_kind,
        payload_json,
        metadata_json
      ) VALUES
      (
        1,
        'event-1',
        'project',
        'project-1',
        1,
        'project.created',
        '2026-07-23T17:00:00.000Z',
        'command-1',
        NULL,
        'command-1',
        'client',
        '{"projectId":"project-1","title":"Project","workspaceRoot":"/tmp/project","defaultModelSelection":null,"scripts":[],"createdAt":"2026-07-23T17:00:00.000Z"}',
        '{}'
      ),
      (
        2,
        'event-2',
        'project',
        'project-1',
        2,
        'project.meta-updated',
        '2026-07-23T17:01:00.000Z',
        'command-2',
        'event-1',
        'command-2',
        'client',
        '{"projectId":"project-1","title":"Project updated","updatedAt":"2026-07-23T17:01:00.000Z"}',
        '{}'
      );

      CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY);
      INSERT INTO projection_projects VALUES ('project-1');

      CREATE TABLE projection_threads (
        thread_id TEXT PRIMARY KEY,
        settled_override TEXT,
        settled_at TEXT,
        handoff_source_json TEXT
      );
      INSERT INTO projection_threads (thread_id) VALUES ('thread-1');

      CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY);
      INSERT INTO projection_thread_messages VALUES ('message-1'), ('message-2');

      CREATE TABLE projection_thread_turn_queue (message_id TEXT PRIMARY KEY);
      CREATE TABLE projection_pending_approvals (request_id TEXT PRIMARY KEY);

      CREATE TABLE provider_session_runtime (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO provider_session_runtime VALUES ('thread-1', 'running');

      CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY);
      INSERT INTO auth_pairing_links VALUES ('pairing-1');

      CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY);
      INSERT INTO auth_sessions VALUES ('session-1');

      CREATE TABLE churn (id INTEGER PRIMARY KEY, payload BLOB);
    `);
    const insertMigration = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    for (const [migrationId, name] of Object.entries(ZRODE_DATABASE_MIGRATION_NAMES_BY_ID)) {
      if (Number(migrationId) <= 44) {
        insertMigration.run(Number(migrationId), name);
      }
    }
    for (let index = 0; index < (options.queuedTurnCount ?? 0); index += 1) {
      database
        .prepare("INSERT INTO projection_thread_turn_queue VALUES (?)")
        .run(`queued-${index}`);
    }
    for (let index = 0; index < (options.pendingApprovalCount ?? 0); index += 1) {
      database
        .prepare("INSERT INTO projection_pending_approvals VALUES (?)")
        .run(`approval-${index}`);
    }
    if ((options.largePayloadBytes ?? 0) > 0) {
      database
        .prepare("INSERT INTO churn(payload) VALUES (zeroblob(?))")
        .run(options.largePayloadBytes!);
    }
  } finally {
    database.close();
  }
}

function withTempRoots<A, E, R>(
  run: (roots: {
    readonly root: string;
    readonly sourceBaseDir: string;
    readonly destinationBaseDir: string;
  }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zrode-state-migration-"));
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

function readCount(databasePath: string, tableName: string): number {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`SELECT COUNT(*) AS value FROM "${tableName}"`).get() as {
      readonly value: number;
    };
    return row.value;
  } finally {
    database.close();
  }
}

function readText(databasePath: string, sql: string): string {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(sql).get();
    const value = row === undefined ? undefined : Object.values(row)[0];
    if (typeof value !== "string") {
      throw new Error(`Expected a text value for query: ${sql}`);
    }
    return value;
  } finally {
    database.close();
  }
}

function hasColumn(databasePath: string, tableName: string, columnName: string): boolean {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`PRAGMA table_info("${tableName}")`).all() as unknown as Array<{
      readonly name: string;
    }>;
    return rows.some((row) => row.name === columnName);
  } finally {
    database.close();
  }
}

describe("Zrode state migration", () => {
  it.effect("imports history atomically while forking machine identity", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);

        const receipt = yield* Effect.suspend(() =>
          migrateZrodeState({
            sourceBaseDir,
            destinationBaseDir,
            appVersion: "0.0.28",
            now: () => NOW,
            availableBytesOverride: AVAILABLE_BYTES,
          }),
        );

        assert.equal(receipt.decision, "imported");
        assert.equal(receipt.sourceDatabase?.eventCount, 2);
        assert.equal(receipt.destinationDatabase?.eventCount, 2);
        assert.isFalse(NodeFS.existsSync(`${destinationBaseDir}.migrating`));
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(destinationBaseDir, "userdata", "state.sqlite")),
        );
        assert.equal(
          NodeFS.readFileSync(
            NodePath.join(destinationBaseDir, "userdata", "attachments", "image.txt"),
            "utf8",
          ),
          "attachment",
        );
        assert.isFalse(
          NodeFS.existsSync(
            NodePath.join(destinationBaseDir, "userdata", "connection-catalog.json"),
          ),
        );
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(destinationBaseDir, "userdata", "environment-id")),
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(destinationBaseDir, "userdata", "secrets")));
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(destinationBaseDir, "userdata", "cloud-auth-token.json")),
        );
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(destinationBaseDir, "userdata", "settings.json")),
        );
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(destinationBaseDir, "userdata", "client-settings.json")),
        );

        const destinationDatabase = NodePath.join(destinationBaseDir, "userdata", "state.sqlite");
        assert.equal(readCount(destinationDatabase, "orchestration_events"), 2);
        assert.equal(readCount(destinationDatabase, "auth_pairing_links"), 0);
        assert.equal(readCount(destinationDatabase, "auth_sessions"), 0);
        assert.equal(readCount(destinationDatabase, "provider_session_runtime"), 0);

        const sourceDatabase = NodePath.join(sourceBaseDir, "userdata", "state.sqlite");
        assert.equal(readCount(sourceDatabase, "auth_sessions"), 1);
        assert.equal(readCount(sourceDatabase, "provider_session_runtime"), 1);
        assert.isTrue(
          NodeFS.existsSync(
            NodePath.join(sourceBaseDir, "userdata", "secrets", "server-signing-key.bin"),
          ),
        );

        const persistedReceipt = NodeFS.readFileSync(
          NodePath.join(destinationBaseDir, "userdata", ZRODE_MIGRATION_RECEIPT_FILE_NAME),
          "utf8",
        );
        assert.include(persistedReceipt, `"completedAt": "${NOW}"`);
      }),
    ),
  );

  it.effect(
    "translates the known T3 migration fork and preserves original events in an audit table",
    () =>
      withTempRoots(
        Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
          createLegacyState(sourceBaseDir);
          const sourceDatabasePath = NodePath.join(sourceBaseDir, "userdata", "state.sqlite");
          const sourceDatabase = new NodeSqlite.DatabaseSync(sourceDatabasePath);
          try {
            sourceDatabase.exec("ALTER TABLE projection_threads DROP COLUMN handoff_source_json");
            sourceDatabase
              .prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = 33")
              .run("ProjectionThreadsSettled");
            sourceDatabase.exec(`
            INSERT INTO orchestration_events (
              sequence,
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json
            ) VALUES
            (
              3,
              'event-settled',
              'thread',
              'thread-1',
              1,
              'thread.settled',
              '2026-07-23T17:02:00.000Z',
              'command-3',
              NULL,
              'command-3',
              'client',
              '{"threadId":"thread-1","settledAt":"2026-07-23T17:02:00.000Z","updatedAt":"2026-07-23T17:02:00.000Z"}',
              '{}'
            ),
            (
              4,
              'event-unsettled',
              'thread',
              'thread-1',
              2,
              'thread.unsettled',
              '2026-07-23T17:03:00.000Z',
              'command-4',
              'event-settled',
              'command-4',
              'client',
              '{"threadId":"thread-1","reason":"user","updatedAt":"2026-07-23T17:03:00.000Z"}',
              '{}'
            )
          `);
          } finally {
            sourceDatabase.close();
          }

          const receipt = yield* Effect.suspend(() =>
            migrateZrodeState({
              sourceBaseDir,
              destinationBaseDir,
              appVersion: "0.0.28",
              now: () => NOW,
              availableBytesOverride: AVAILABLE_BYTES,
            }),
          );

          const destinationDatabasePath = NodePath.join(
            destinationBaseDir,
            "userdata",
            "state.sqlite",
          );
          assert.deepEqual(receipt.compatibilityActions, [
            "translated migration 33 from ProjectionThreadsSettled to ProjectionThreadsHandoffSource",
            "archived and translated 2 legacy T3 thread lifecycle events",
          ]);
          assert.equal(
            readText(
              destinationDatabasePath,
              "SELECT name FROM effect_sql_migrations WHERE migration_id = 33",
            ),
            "ProjectionThreadsHandoffSource",
          );
          assert.equal(
            readCount(destinationDatabasePath, "orchestration_import_compatibility_events"),
            2,
          );
          assert.equal(
            readText(
              destinationDatabasePath,
              "SELECT GROUP_CONCAT(DISTINCT event_type) FROM orchestration_events WHERE sequence >= 3",
            ),
            "thread.title-generation-requested",
          );
          assert.isTrue(
            hasColumn(destinationDatabasePath, "projection_threads", "handoff_source_json"),
          );

          assert.equal(
            readText(
              sourceDatabasePath,
              "SELECT name FROM effect_sql_migrations WHERE migration_id = 33",
            ),
            "ProjectionThreadsSettled",
          );
          assert.isFalse(
            hasColumn(sourceDatabasePath, "projection_threads", "handoff_source_json"),
          );
          assert.equal(
            readText(
              sourceDatabasePath,
              "SELECT event_type FROM orchestration_events WHERE sequence = 3",
            ),
            "thread.settled",
          );
        }),
      ),
  );

  it.effect("refuses an unknown event type before cutover and leaves the source unchanged", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);
        const sourceDatabasePath = NodePath.join(sourceBaseDir, "userdata", "state.sqlite");
        const sourceDatabase = new NodeSqlite.DatabaseSync(sourceDatabasePath);
        try {
          sourceDatabase.exec(
            "UPDATE orchestration_events SET event_type = 'thread.future-state' WHERE sequence = 2",
          );
        } finally {
          sourceDatabase.close();
        }

        const error = yield* Effect.suspend(() =>
          Effect.flip(
            migrateZrodeState({
              sourceBaseDir,
              destinationBaseDir,
              appVersion: "0.0.28",
              availableBytesOverride: AVAILABLE_BYTES,
            }),
          ),
        );

        assert.instanceOf(error, ZrodeStateMigrationCompatibilityError);
        assert.deepEqual(error.unsupportedEventTypes, ["thread.future-state"]);
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
        assert.equal(
          readText(
            sourceDatabasePath,
            "SELECT event_type FROM orchestration_events WHERE sequence = 2",
          ),
          "thread.future-state",
        );
      }),
    ),
  );

  it.effect("refuses an unknown migration-name collision before cutover", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);
        const sourceDatabasePath = NodePath.join(sourceBaseDir, "userdata", "state.sqlite");
        const sourceDatabase = new NodeSqlite.DatabaseSync(sourceDatabasePath);
        try {
          sourceDatabase
            .prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = 33")
            .run("ProjectionThreadsUnknownFork");
        } finally {
          sourceDatabase.close();
        }

        const error = yield* Effect.suspend(() =>
          Effect.flip(
            migrateZrodeState({
              sourceBaseDir,
              destinationBaseDir,
              appVersion: "0.0.28",
              availableBytesOverride: AVAILABLE_BYTES,
            }),
          ),
        );

        assert.instanceOf(error, ZrodeStateMigrationCompatibilityError);
        assert.deepEqual(error.migrationConflicts, [
          {
            migrationId: 33,
            expectedName: "ProjectionThreadsHandoffSource",
            actualName: "ProjectionThreadsUnknownFork",
          },
        ]);
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
        assert.equal(
          readText(
            sourceDatabasePath,
            "SELECT name FROM effect_sql_migrations WHERE migration_id = 33",
          ),
          "ProjectionThreadsUnknownFork",
        );
      }),
    ),
  );

  it.effect("refuses a Zrode migration ledger that claims an absent forked schema", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);
        const sourceDatabasePath = NodePath.join(sourceBaseDir, "userdata", "state.sqlite");
        const sourceDatabase = new NodeSqlite.DatabaseSync(sourceDatabasePath);
        try {
          sourceDatabase.exec("ALTER TABLE projection_threads DROP COLUMN handoff_source_json");
        } finally {
          sourceDatabase.close();
        }

        const error = yield* Effect.suspend(() =>
          Effect.flip(
            migrateZrodeState({
              sourceBaseDir,
              destinationBaseDir,
              appVersion: "0.0.28",
              availableBytesOverride: AVAILABLE_BYTES,
            }),
          ),
        );

        assert.instanceOf(error, ZrodeStateMigrationCompatibilityError);
        assert.deepEqual(error.migrationConflicts, [
          {
            migrationId: 33,
            expectedName: "ProjectionThreadsHandoffSource",
            actualName: "ProjectionThreadsHandoffSource without handoff_source_json",
          },
        ]);
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
        assert.isFalse(hasColumn(sourceDatabasePath, "projection_threads", "handoff_source_json"));
      }),
    ),
  );

  it.effect("cleans an owned interrupted staging directory before retrying", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);
        const stagingBaseDir = `${destinationBaseDir}.migrating`;
        NodeFS.mkdirSync(stagingBaseDir);
        NodeFS.writeFileSync(NodePath.join(stagingBaseDir, "partial.sqlite"), "partial");
        NodeFS.writeFileSync(
          NodePath.join(stagingBaseDir, ZRODE_MIGRATION_STAGING_MARKER_FILE_NAME),
          `{"version":1,"sourceBaseDir":"${sourceBaseDir}","destinationBaseDir":"${destinationBaseDir}"}`,
        );

        yield* Effect.suspend(() =>
          migrateZrodeState({
            sourceBaseDir,
            destinationBaseDir,
            appVersion: "0.0.28",
            now: () => NOW,
            availableBytesOverride: AVAILABLE_BYTES,
          }),
        );

        assert.isFalse(NodeFS.existsSync(NodePath.join(destinationBaseDir, "partial.sqlite")));
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(destinationBaseDir, "userdata", "state.sqlite")),
        );
      }),
    ),
  );

  it.effect("refuses to remove an unowned staging path", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);
        NodeFS.mkdirSync(`${destinationBaseDir}.migrating`);
        NodeFS.writeFileSync(
          NodePath.join(`${destinationBaseDir}.migrating`, "unrelated.txt"),
          "keep",
        );

        const error = yield* Effect.suspend(() =>
          Effect.flip(
            migrateZrodeState({
              sourceBaseDir,
              destinationBaseDir,
              appVersion: "0.0.28",
              availableBytesOverride: AVAILABLE_BYTES,
            }),
          ),
        );
        assert.instanceOf(error, ZrodeStateMigrationError);
        assert.equal(error.operation, "prepare-staging");
        assert.equal(
          NodeFS.readFileSync(
            NodePath.join(`${destinationBaseDir}.migrating`, "unrelated.txt"),
            "utf8",
          ),
          "keep",
        );
      }),
    ),
  );

  it.effect("fails before copying when free space is insufficient", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);

        const error = yield* Effect.suspend(() =>
          Effect.flip(
            migrateZrodeState({
              sourceBaseDir,
              destinationBaseDir,
              appVersion: "0.0.28",
              availableBytesOverride: 1,
            }),
          ),
        );

        assert.instanceOf(error, ZrodeStateMigrationInsufficientSpaceError);
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
        assert.isFalse(NodeFS.existsSync(`${destinationBaseDir}.migrating`));
      }),
    ),
  );

  it.effect("refuses to duplicate queued work or pending approvals", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir, { queuedTurnCount: 1, pendingApprovalCount: 1 });

        const error = yield* Effect.suspend(() =>
          Effect.flip(
            migrateZrodeState({
              sourceBaseDir,
              destinationBaseDir,
              appVersion: "0.0.28",
              availableBytesOverride: AVAILABLE_BYTES,
            }),
          ),
        );

        assert.instanceOf(error, ZrodeStateMigrationBusyStateError);
        assert.equal(error.queuedTurnCount, 1);
        assert.equal(error.pendingApprovalCount, 1);
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
      }),
    ),
  );

  it.effect("aborts when another connection changes the source during backup", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir, { largePayloadBytes: 16 * 1024 * 1024 });
        const sourceDatabasePath = NodePath.join(sourceBaseDir, "userdata", "state.sqlite");
        const writer = new NodeSqlite.DatabaseSync(sourceDatabasePath);
        let changed = false;
        try {
          const error = yield* Effect.suspend(() =>
            Effect.flip(
              migrateZrodeState({
                sourceBaseDir,
                destinationBaseDir,
                appVersion: "0.0.28",
                availableBytesOverride: AVAILABLE_BYTES,
                onProgress: (progress) => {
                  if (progress.phase === "backup-database" && !changed) {
                    changed = true;
                    writer.exec("INSERT INTO churn(payload) VALUES ('changed')");
                  }
                },
              }),
            ),
          );
          assert.instanceOf(error, ZrodeStateMigrationSourceChangedError);
        } finally {
          writer.close();
        }
        assert.isTrue(changed);
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
      }),
    ),
  );

  it.effect("records an explicit fresh-state decision without copying legacy data", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);

        const receipt = yield* Effect.suspend(() =>
          recordFreshZrodeStateDecision({
            sourceBaseDir,
            destinationBaseDir,
            appVersion: "0.0.28",
            now: () => NOW,
          }),
        );
        assert.equal(receipt.decision, "start-fresh");
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(destinationBaseDir, "userdata", "state.sqlite")),
        );

        const inspection = yield* Effect.suspend(() =>
          inspectZrodeStateMigration({ sourceBaseDir, destinationBaseDir }),
        );
        assert.equal(inspection.status, "not-needed");
        if (inspection.status === "not-needed") {
          assert.equal(inspection.reason, "decision-recorded");
        }
      }),
    ),
  );

  it.effect("refuses an existing unrecognized destination", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);
        yield* Effect.promise(() => NodeFSP.mkdir(destinationBaseDir));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(destinationBaseDir, "keep.txt"), "keep"),
        );

        const inspection = yield* Effect.suspend(() =>
          inspectZrodeStateMigration({ sourceBaseDir, destinationBaseDir }),
        );
        assert.equal(inspection.status, "destination-conflict");

        const error = yield* Effect.suspend(() =>
          Effect.flip(
            recordFreshZrodeStateDecision({
              sourceBaseDir,
              destinationBaseDir,
              appVersion: "0.0.28",
            }),
          ),
        );
        assert.instanceOf(error, ZrodeStateMigrationDestinationConflictError);
        assert.equal(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(destinationBaseDir, "keep.txt"), "utf8"),
          ),
          "keep",
        );
      }),
    ),
  );

  it.effect("rejects a corrupt source without creating destination state", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        NodeFS.mkdirSync(NodePath.join(sourceBaseDir, "userdata"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(sourceBaseDir, "userdata", "state.sqlite"),
          "not sqlite",
        );

        const error = yield* Effect.suspend(() =>
          Effect.flip(inspectZrodeStateMigration({ sourceBaseDir, destinationBaseDir })),
        );
        assert.instanceOf(error, ZrodeStateMigrationError);
        assert.equal(error.operation, "inspect-database");
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
      }),
    ),
  );

  it.effect("can explicitly start fresh when the legacy database is corrupt", () =>
    withTempRoots(
      Effect.fn(function* ({ sourceBaseDir, destinationBaseDir }) {
        NodeFS.mkdirSync(NodePath.join(sourceBaseDir, "userdata"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(sourceBaseDir, "userdata", "state.sqlite"),
          "not sqlite",
        );

        const receipt = yield* Effect.suspend(() =>
          recordFreshZrodeStateDecision({
            sourceBaseDir,
            destinationBaseDir,
            appVersion: "0.0.28",
            now: () => NOW,
          }),
        );

        assert.equal(receipt.decision, "start-fresh");
        assert.isTrue(NodeFS.existsSync(destinationBaseDir));
      }),
    ),
  );

  it.effect("refuses symbolic links in copied durable state", () =>
    withTempRoots(
      Effect.fn(function* ({ root, sourceBaseDir, destinationBaseDir }) {
        createLegacyState(sourceBaseDir);
        const externalPath = NodePath.join(root, "external-secret.txt");
        NodeFS.writeFileSync(externalPath, "secret");
        NodeFS.symlinkSync(
          externalPath,
          NodePath.join(sourceBaseDir, "userdata", "attachments", "linked-secret.txt"),
        );

        const error = yield* Effect.suspend(() =>
          Effect.flip(
            migrateZrodeState({
              sourceBaseDir,
              destinationBaseDir,
              appVersion: "0.0.28",
              availableBytesOverride: AVAILABLE_BYTES,
            }),
          ),
        );

        assert.instanceOf(error, ZrodeStateMigrationError);
        assert.equal(error.operation, "copy-durable-files");
        assert.isFalse(NodeFS.existsSync(destinationBaseDir));
      }),
    ),
  );
});
