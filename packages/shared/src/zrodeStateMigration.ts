// @effect-diagnostics nodeBuiltinImport:off - This is the shared Node boundary for native SQLite backup and filesystem cutover.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { OrchestrationEventType } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ZRODE_DATABASE_MIGRATION_NAMES_BY_ID } from "./zrodeDatabaseMigrations.ts";

const GIBIBYTE = 1024 * 1024 * 1024;
const MINIMUM_FREE_SPACE_MARGIN_BYTES = 512 * 1024 * 1024;
const FREE_SPACE_MARGIN_RATIO = 0.1;
const BACKUP_PAGE_BATCH_SIZE = 1_024;

export const ZRODE_MIGRATION_RECEIPT_FILE_NAME = "legacy-state-migration.json";
export const ZRODE_MIGRATION_STAGING_MARKER_FILE_NAME = ".zrode-state-migration-staging.json";
export const ZRODE_STATE_DATABASE_RELATIVE_PATH = NodePath.join("userdata", "state.sqlite");

const DURABLE_STATE_FILE_NAMES = [
  "client-settings.json",
  "desktop-settings.json",
  "keybindings.json",
] as const;
const DURABLE_STATE_DIRECTORY_NAMES = ["attachments"] as const;
const RESET_DATABASE_TABLES = [
  "auth_pairing_links",
  "auth_sessions",
  "provider_session_runtime",
] as const;

export type ZrodeStateMigrationPhase =
  | "preflight"
  | "backup-database"
  | "copy-durable-files"
  | "reset-machine-identity"
  | "validate"
  | "cutover";

export interface ZrodeStateMigrationProgress {
  readonly phase: ZrodeStateMigrationPhase;
  readonly completed: number;
  readonly total: number;
}

export interface ZrodeStateDatabaseSummary {
  readonly migrationId: number;
  readonly eventCount: number;
  readonly maxEventSequence: number;
  readonly projectCount: number;
  readonly threadCount: number;
  readonly messageCount: number;
  readonly queuedTurnCount: number;
  readonly pendingApprovalCount: number;
  readonly runningProviderSessionCount: number;
}

export interface ZrodeStateMigrationReceipt {
  readonly version: 1;
  readonly decision: "imported" | "start-fresh";
  readonly sourceBaseDir: string;
  readonly destinationBaseDir: string;
  readonly completedAt: string;
  readonly appVersion: string;
  readonly sourceDatabase?: ZrodeStateDatabaseSummary | undefined;
  readonly destinationDatabase?: ZrodeStateDatabaseSummary | undefined;
  readonly copiedFiles: ReadonlyArray<string>;
  readonly identityReset: ReadonlyArray<string>;
  readonly compatibilityActions?: ReadonlyArray<string> | undefined;
}

export type ZrodeStateMigrationInspection =
  | {
      readonly status: "pending";
      readonly sourceBaseDir: string;
      readonly destinationBaseDir: string;
      readonly sourceDatabasePath: string;
      readonly sourceDatabaseSizeBytes: number;
      readonly sourceDatabase: ZrodeStateDatabaseSummary;
    }
  | {
      readonly status: "not-needed";
      readonly reason: "source-missing" | "destination-initialized" | "decision-recorded";
      readonly receipt?: ZrodeStateMigrationReceipt;
    }
  | {
      readonly status: "destination-conflict";
      readonly destinationBaseDir: string;
    };

const ZrodeStateDatabaseSummarySchema = Schema.Struct({
  migrationId: Schema.Number,
  eventCount: Schema.Number,
  maxEventSequence: Schema.Number,
  projectCount: Schema.Number,
  threadCount: Schema.Number,
  messageCount: Schema.Number,
  queuedTurnCount: Schema.Number,
  pendingApprovalCount: Schema.Number,
  runningProviderSessionCount: Schema.Number,
});

const ZrodeStateMigrationReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  decision: Schema.Literals(["imported", "start-fresh"]),
  sourceBaseDir: Schema.String,
  destinationBaseDir: Schema.String,
  completedAt: Schema.String,
  appVersion: Schema.String,
  sourceDatabase: Schema.optional(ZrodeStateDatabaseSummarySchema),
  destinationDatabase: Schema.optional(ZrodeStateDatabaseSummarySchema),
  copiedFiles: Schema.Array(Schema.String),
  identityReset: Schema.Array(Schema.String),
  compatibilityActions: Schema.optional(Schema.Array(Schema.String)),
});

const ZrodeStateMigrationStagingMarkerSchema = Schema.Struct({
  version: Schema.Literal(1),
  sourceBaseDir: Schema.String,
  destinationBaseDir: Schema.String,
});
const decodeMigrationReceipt = Schema.decodeUnknownSync(ZrodeStateMigrationReceiptSchema);
const decodeMigrationStagingMarker = Schema.decodeUnknownSync(
  ZrodeStateMigrationStagingMarkerSchema,
);

export const ZrodeStateMigrationOperation = Schema.Literals([
  "inspect-source",
  "inspect-destination",
  "inspect-database",
  "inspect-free-space",
  "prepare-staging",
  "backup-database",
  "source-changed",
  "copy-durable-files",
  "reset-machine-identity",
  "validate-compatibility",
  "validate-database",
  "write-receipt",
  "cutover",
]);
export type ZrodeStateMigrationOperation = typeof ZrodeStateMigrationOperation.Type;

export class ZrodeStateMigrationError extends Schema.TaggedErrorClass<ZrodeStateMigrationError>()(
  "ZrodeStateMigrationError",
  {
    operation: ZrodeStateMigrationOperation,
    sourcePath: Schema.String,
    destinationPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Zrode state migration failed during ${this.operation}.`;
  }
}

export class ZrodeStateMigrationInsufficientSpaceError extends Schema.TaggedErrorClass<ZrodeStateMigrationInsufficientSpaceError>()(
  "ZrodeStateMigrationInsufficientSpaceError",
  {
    destinationBaseDir: Schema.String,
    requiredBytes: Schema.Number,
    availableBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Zrode needs ${formatBytes(this.requiredBytes)} of free space to import the existing state, but only ${formatBytes(this.availableBytes)} is available.`;
  }
}

export class ZrodeStateMigrationSourceChangedError extends Schema.TaggedErrorClass<ZrodeStateMigrationSourceChangedError>()(
  "ZrodeStateMigrationSourceChangedError",
  {
    sourceDatabasePath: Schema.String,
  },
) {
  override get message(): string {
    return "The shared T3 Code database changed during import. Close T3 Code completely, then retry.";
  }
}

export class ZrodeStateMigrationBusyStateError extends Schema.TaggedErrorClass<ZrodeStateMigrationBusyStateError>()(
  "ZrodeStateMigrationBusyStateError",
  {
    queuedTurnCount: Schema.Number,
    pendingApprovalCount: Schema.Number,
  },
) {
  override get message(): string {
    return "The shared state still contains queued turns or pending approvals. Finish or cancel them in T3 Code before importing.";
  }
}

export class ZrodeStateMigrationDestinationConflictError extends Schema.TaggedErrorClass<ZrodeStateMigrationDestinationConflictError>()(
  "ZrodeStateMigrationDestinationConflictError",
  {
    destinationBaseDir: Schema.String,
  },
) {
  override get message(): string {
    return `Zrode cannot import into ${this.destinationBaseDir} because that directory already contains unrecognized data.`;
  }
}

const ZrodeStateMigrationLedgerConflict = Schema.Struct({
  migrationId: Schema.Number,
  expectedName: Schema.NullOr(Schema.String),
  actualName: Schema.String,
});
type ZrodeStateMigrationLedgerConflict = typeof ZrodeStateMigrationLedgerConflict.Type;

export class ZrodeStateMigrationCompatibilityError extends Schema.TaggedErrorClass<ZrodeStateMigrationCompatibilityError>()(
  "ZrodeStateMigrationCompatibilityError",
  {
    migrationConflicts: Schema.Array(ZrodeStateMigrationLedgerConflict),
    unsupportedEventTypes: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const details: string[] = [];
    if (this.migrationConflicts.length > 0) {
      details.push(
        `migration ledger conflicts: ${this.migrationConflicts
          .map(
            ({ migrationId, expectedName, actualName }) =>
              `${migrationId} (${actualName}; expected ${expectedName ?? "no Zrode migration"})`,
          )
          .join(", ")}`,
      );
    }
    if (this.unsupportedEventTypes.length > 0) {
      details.push(`unsupported events: ${this.unsupportedEventTypes.join(", ")}`);
    }
    return `Zrode cannot safely import this T3 Code database (${details.join("; ")}). The source database was not changed.`;
  }
}
const isZrodeStateMigrationCompatibilityError = Schema.is(ZrodeStateMigrationCompatibilityError);

export type ZrodeStateMigrationFailure =
  | ZrodeStateMigrationError
  | ZrodeStateMigrationInsufficientSpaceError
  | ZrodeStateMigrationSourceChangedError
  | ZrodeStateMigrationBusyStateError
  | ZrodeStateMigrationDestinationConflictError
  | ZrodeStateMigrationCompatibilityError;

export interface ZrodeStateMigrationInput {
  readonly sourceBaseDir: string;
  readonly destinationBaseDir: string;
  readonly appVersion: string;
  readonly now?: () => string;
  readonly onProgress?: (progress: ZrodeStateMigrationProgress) => void;
  readonly availableBytesOverride?: number;
}

type SqliteCountRow = { readonly value: number | bigint | null };
type SqliteQuickCheckRow = { readonly quick_check: string };
type SqliteMigrationLedgerRow = {
  readonly migrationId: number | bigint;
  readonly name: string;
};
type SqliteEventTypeRow = { readonly eventType: string };
type SqliteTableColumnRow = { readonly name: string };

class SourceChangedDuringBackup extends Error {}

const LEGACY_T3_MIGRATION_33_NAME = "ProjectionThreadsSettled";
const TRANSLATABLE_T3_EVENT_TYPES = new Set(["thread.settled", "thread.unsettled"]);
const ZRODE_SUPPORTED_EVENT_TYPES = new Set<string>(OrchestrationEventType.literals);

function formatBytes(bytes: number): string {
  if (bytes >= GIBIBYTE) {
    return `${(bytes / GIBIBYTE).toFixed(1)} GiB`;
  }
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

function stateDirectory(baseDir: string): string {
  return NodePath.join(baseDir, "userdata");
}

function databasePath(baseDir: string): string {
  return NodePath.join(baseDir, ZRODE_STATE_DATABASE_RELATIVE_PATH);
}

function receiptPath(baseDir: string): string {
  return NodePath.join(stateDirectory(baseDir), ZRODE_MIGRATION_RECEIPT_FILE_NAME);
}

function stagingBaseDirectory(destinationBaseDir: string): string {
  return `${destinationBaseDir}.migrating`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

async function readReceipt(baseDir: string): Promise<ZrodeStateMigrationReceipt | undefined> {
  const path = receiptPath(baseDir);
  if (!(await pathExists(path))) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
  return decodeMigrationReceipt(parsed);
}

function tableExists(database: NodeSqlite.DatabaseSync, tableName: string): boolean {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) !== undefined
  );
}

function readCount(database: NodeSqlite.DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as SqliteCountRow | undefined;
  const value = row?.value ?? 0;
  return typeof value === "bigint" ? Number(value) : value;
}

function readTableCount(database: NodeSqlite.DatabaseSync, tableName: string): number {
  return tableExists(database, tableName)
    ? readCount(database, `SELECT COUNT(*) AS value FROM "${tableName}"`)
    : 0;
}

function inspectOpenDatabase(
  database: NodeSqlite.DatabaseSync,
  options: { readonly quickCheck: boolean },
): ZrodeStateDatabaseSummary {
  if (!tableExists(database, "orchestration_events")) {
    throw new Error("The source database does not contain orchestration_events.");
  }
  if (options.quickCheck) {
    const quickCheck = database
      .prepare("PRAGMA quick_check")
      .all() as unknown as Array<SqliteQuickCheckRow>;
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
      throw new Error(`SQLite quick_check failed: ${JSON.stringify(quickCheck)}`);
    }
  }
  return {
    migrationId: tableExists(database, "effect_sql_migrations")
      ? readCount(
          database,
          "SELECT COALESCE(MAX(migration_id), 0) AS value FROM effect_sql_migrations",
        )
      : 0,
    eventCount: readTableCount(database, "orchestration_events"),
    maxEventSequence: readCount(
      database,
      "SELECT COALESCE(MAX(sequence), 0) AS value FROM orchestration_events",
    ),
    projectCount: readTableCount(database, "projection_projects"),
    threadCount: readTableCount(database, "projection_threads"),
    messageCount: readTableCount(database, "projection_thread_messages"),
    queuedTurnCount: readTableCount(database, "projection_thread_turn_queue"),
    pendingApprovalCount: readTableCount(database, "projection_pending_approvals"),
    runningProviderSessionCount: tableExists(database, "provider_session_runtime")
      ? readCount(
          database,
          "SELECT COUNT(*) AS value FROM provider_session_runtime WHERE status <> 'stopped'",
        )
      : 0,
  };
}

async function inspectDatabase(
  path: string,
  options: { readonly quickCheck?: boolean } = {},
): Promise<ZrodeStateDatabaseSummary> {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return inspectOpenDatabase(database, { quickCheck: options.quickCheck === true });
  } finally {
    database.close();
  }
}

function readDataVersion(database: NodeSqlite.DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get();
  if (row === undefined) {
    throw new Error("SQLite did not return PRAGMA data_version.");
  }
  const value = Object.values(row)[0];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("SQLite returned an invalid PRAGMA data_version.");
  }
  return Number(value);
}

async function pathSize(path: string): Promise<number> {
  if (!(await pathExists(path))) {
    return 0;
  }
  const info = await NodeFSP.lstat(path);
  if (info.isSymbolicLink()) {
    return 0;
  }
  if (!info.isDirectory()) {
    return info.size;
  }
  const entries = await NodeFSP.readdir(path, { withFileTypes: true });
  let size = 0;
  for (const entry of entries) {
    size += await pathSize(NodePath.join(path, entry.name));
  }
  return size;
}

async function durableStateSize(sourceBaseDir: string): Promise<number> {
  const sourceStateDir = stateDirectory(sourceBaseDir);
  let size = 0;
  for (const fileName of DURABLE_STATE_FILE_NAMES) {
    size += await pathSize(NodePath.join(sourceStateDir, fileName));
  }
  for (const directoryName of DURABLE_STATE_DIRECTORY_NAMES) {
    size += await pathSize(NodePath.join(sourceStateDir, directoryName));
  }
  return size;
}

async function assertSafeDurablePath(path: string): Promise<void> {
  const info = await NodeFSP.lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to import symbolic link ${path}.`);
  }
  if (!info.isDirectory()) {
    if (!info.isFile()) {
      throw new Error(`Refusing to import non-regular file ${path}.`);
    }
    return;
  }
  for (const entry of await NodeFSP.readdir(path)) {
    await assertSafeDurablePath(NodePath.join(path, entry));
  }
}

async function availableBytes(path: string): Promise<number> {
  const stats = await NodeFSP.statfs(path, { bigint: true });
  return Number(stats.bavail * stats.bsize);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function prepareStagingDirectory(input: {
  readonly stagingBaseDir: string;
  readonly sourceBaseDir: string;
  readonly destinationBaseDir: string;
}): Promise<void> {
  if (await pathExists(input.stagingBaseDir)) {
    const info = await NodeFSP.lstat(input.stagingBaseDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("The migration staging path is not an owned directory.");
    }
    const markerPath = NodePath.join(
      input.stagingBaseDir,
      ZRODE_MIGRATION_STAGING_MARKER_FILE_NAME,
    );
    const marker: unknown = JSON.parse(await NodeFSP.readFile(markerPath, "utf8"));
    const decoded = decodeMigrationStagingMarker(marker);
    if (
      decoded.sourceBaseDir !== input.sourceBaseDir ||
      decoded.destinationBaseDir !== input.destinationBaseDir
    ) {
      throw new Error("The migration staging marker does not match this migration.");
    }
    await NodeFSP.rm(input.stagingBaseDir, { recursive: true });
  }

  await NodeFSP.mkdir(input.stagingBaseDir, { recursive: false });
  await writeJson(NodePath.join(input.stagingBaseDir, ZRODE_MIGRATION_STAGING_MARKER_FILE_NAME), {
    version: 1,
    sourceBaseDir: input.sourceBaseDir,
    destinationBaseDir: input.destinationBaseDir,
  });
}

async function copyDurableState(input: {
  readonly sourceBaseDir: string;
  readonly stagingBaseDir: string;
}): Promise<ReadonlyArray<string>> {
  const sourceStateDir = stateDirectory(input.sourceBaseDir);
  const destinationStateDir = stateDirectory(input.stagingBaseDir);
  await NodeFSP.mkdir(destinationStateDir, { recursive: true });
  const copied: string[] = [];

  for (const fileName of DURABLE_STATE_FILE_NAMES) {
    const source = NodePath.join(sourceStateDir, fileName);
    if (!(await pathExists(source))) {
      continue;
    }
    await assertSafeDurablePath(source);
    await NodeFSP.copyFile(source, NodePath.join(destinationStateDir, fileName));
    copied.push(NodePath.join("userdata", fileName));
  }

  for (const directoryName of DURABLE_STATE_DIRECTORY_NAMES) {
    const source = NodePath.join(sourceStateDir, directoryName);
    if (!(await pathExists(source))) {
      continue;
    }
    await assertSafeDurablePath(source);
    await NodeFSP.cp(source, NodePath.join(destinationStateDir, directoryName), {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    copied.push(NodePath.join("userdata", directoryName));
  }

  return copied;
}

async function backupDatabase(input: {
  readonly sourceDatabasePath: string;
  readonly destinationDatabasePath: string;
  readonly onProgress?: (progress: ZrodeStateMigrationProgress) => void;
}): Promise<void> {
  const sourceDatabase = new NodeSqlite.DatabaseSync(input.sourceDatabasePath, { readOnly: true });
  let previousRemainingPages = Number.POSITIVE_INFINITY;
  try {
    const initialDataVersion = readDataVersion(sourceDatabase);
    await NodeSqlite.backup(sourceDatabase, input.destinationDatabasePath, {
      rate: BACKUP_PAGE_BATCH_SIZE,
      progress: ({ remainingPages, totalPages }) => {
        if (remainingPages > previousRemainingPages) {
          throw new SourceChangedDuringBackup();
        }
        previousRemainingPages = remainingPages;
        input.onProgress?.({
          phase: "backup-database",
          completed: Math.max(0, totalPages - remainingPages),
          total: totalPages,
        });
      },
    });
    const finalDataVersion = readDataVersion(sourceDatabase);
    if (initialDataVersion !== finalDataVersion) {
      throw new SourceChangedDuringBackup();
    }
  } finally {
    sourceDatabase.close();
  }
}

async function resetMachineIdentity(path: string): Promise<void> {
  const database = new NodeSqlite.DatabaseSync(path);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const tableName of RESET_DATABASE_TABLES) {
        if (tableExists(database, tableName)) {
          database.exec(`DELETE FROM "${tableName}"`);
        }
      }
      database.exec("COMMIT");
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  await NodeFSP.rm(`${path}-wal`, { force: true });
  await NodeFSP.rm(`${path}-shm`, { force: true });
}

function tableColumnNames(
  database: NodeSqlite.DatabaseSync,
  tableName: string,
): ReadonlySet<string> {
  if (!tableExists(database, tableName)) {
    return new Set();
  }
  const rows = database
    .prepare(`PRAGMA table_info("${tableName}")`)
    .all() as unknown as Array<SqliteTableColumnRow>;
  return new Set(rows.map((row) => row.name));
}

async function validateAndTranslateStagedDatabase(path: string): Promise<ReadonlyArray<string>> {
  const database = new NodeSqlite.DatabaseSync(path);
  const compatibilityActions: string[] = [];
  try {
    const migrationConflicts: ZrodeStateMigrationLedgerConflict[] = [];
    const migrationRows = tableExists(database, "effect_sql_migrations")
      ? (database
          .prepare(
            `SELECT migration_id AS "migrationId", name
             FROM effect_sql_migrations
             ORDER BY migration_id ASC`,
          )
          .all() as unknown as Array<SqliteMigrationLedgerRow>)
      : [];
    const migrationById = new Map(
      migrationRows.map((row) => [Number(row.migrationId), row.name] as const),
    );
    const latestMigrationId =
      migrationRows.length === 0
        ? 0
        : Math.max(...migrationRows.map((row) => Number(row.migrationId)));
    const expectedMigrations = Object.entries(ZRODE_DATABASE_MIGRATION_NAMES_BY_ID).map(
      ([migrationId, name]) => [Number(migrationId), name] as const,
    );

    if (migrationRows.length === 0) {
      migrationConflicts.push({
        migrationId: 0,
        expectedName: null,
        actualName: "<missing migration ledger>",
      });
    } else {
      for (const [migrationId, expectedName] of expectedMigrations) {
        if (migrationId > latestMigrationId) {
          continue;
        }
        const actualName = migrationById.get(migrationId);
        if (actualName === undefined) {
          migrationConflicts.push({
            migrationId,
            expectedName,
            actualName: "<missing>",
          });
          continue;
        }
        if (
          actualName !== expectedName &&
          !(migrationId === 33 && actualName === LEGACY_T3_MIGRATION_33_NAME)
        ) {
          migrationConflicts.push({ migrationId, expectedName, actualName });
        }
      }
      for (const row of migrationRows) {
        const migrationId = Number(row.migrationId);
        if (!(migrationId in ZRODE_DATABASE_MIGRATION_NAMES_BY_ID) && migrationId !== 36) {
          migrationConflicts.push({
            migrationId,
            expectedName: null,
            actualName: row.name,
          });
        }
      }
    }

    const eventColumns = tableColumnNames(database, "orchestration_events");
    const unsupportedEventTypes: string[] = [];
    if (!eventColumns.has("event_type")) {
      unsupportedEventTypes.push("<missing orchestration_events.event_type>");
    } else {
      const eventTypes = database
        .prepare(
          `SELECT DISTINCT event_type AS "eventType"
           FROM orchestration_events
           ORDER BY event_type ASC`,
        )
        .all() as unknown as Array<SqliteEventTypeRow>;
      unsupportedEventTypes.push(
        ...eventTypes
          .map((row) => row.eventType)
          .filter(
            (eventType) =>
              !ZRODE_SUPPORTED_EVENT_TYPES.has(eventType) &&
              !TRANSLATABLE_T3_EVENT_TYPES.has(eventType),
          ),
      );
    }

    const hasLegacyT3Migration = migrationById.get(33) === LEGACY_T3_MIGRATION_33_NAME;
    const projectionThreadColumns = tableColumnNames(database, "projection_threads");
    if (
      migrationById.get(33) === ZRODE_DATABASE_MIGRATION_NAMES_BY_ID[33] &&
      !projectionThreadColumns.has("handoff_source_json")
    ) {
      migrationConflicts.push({
        migrationId: 33,
        expectedName: ZRODE_DATABASE_MIGRATION_NAMES_BY_ID[33],
        actualName: `${ZRODE_DATABASE_MIGRATION_NAMES_BY_ID[33]} without handoff_source_json`,
      });
    }
    if (
      hasLegacyT3Migration &&
      (!projectionThreadColumns.has("settled_override") ||
        !projectionThreadColumns.has("settled_at"))
    ) {
      migrationConflicts.push({
        migrationId: 33,
        expectedName: ZRODE_DATABASE_MIGRATION_NAMES_BY_ID[33],
        actualName: `${LEGACY_T3_MIGRATION_33_NAME} without settled projection columns`,
      });
    }

    if (migrationConflicts.length > 0 || unsupportedEventTypes.length > 0) {
      throw new ZrodeStateMigrationCompatibilityError({
        migrationConflicts,
        unsupportedEventTypes,
      });
    }

    const legacyEventCount = eventColumns.has("event_type")
      ? readCount(
          database,
          `SELECT COUNT(*) AS value
           FROM orchestration_events
           WHERE event_type IN ('thread.settled', 'thread.unsettled')`,
        )
      : 0;
    if (hasLegacyT3Migration || legacyEventCount > 0) {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (legacyEventCount > 0) {
          database.exec(`
            CREATE TABLE IF NOT EXISTS orchestration_import_compatibility_events (
              sequence INTEGER NOT NULL,
              event_id TEXT PRIMARY KEY,
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
              metadata_json TEXT NOT NULL,
              compatibility_reason TEXT NOT NULL,
              translated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
          `);
          database.exec(`
            INSERT OR IGNORE INTO orchestration_import_compatibility_events (
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
              metadata_json,
              compatibility_reason
            )
            SELECT
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
              metadata_json,
              'T3 Code settled lifecycle event translated to a Zrode replay no-op'
            FROM orchestration_events
            WHERE event_type IN ('thread.settled', 'thread.unsettled')
          `);
          database.exec(`
            UPDATE orchestration_events
            SET
              event_type = 'thread.title-generation-requested',
              payload_json = json_object(
                'threadId', stream_id,
                'message', 'Imported legacy T3 Code thread lifecycle marker.',
                'titleSeed', 'Imported T3 lifecycle marker',
                'createdAt', occurred_at
              )
            WHERE event_type IN ('thread.settled', 'thread.unsettled')
          `);
        }

        if (hasLegacyT3Migration) {
          if (!tableColumnNames(database, "projection_threads").has("handoff_source_json")) {
            database.exec("ALTER TABLE projection_threads ADD COLUMN handoff_source_json TEXT");
          }
          database
            .prepare(
              `UPDATE effect_sql_migrations
               SET name = ?
               WHERE migration_id = 33 AND name = ?`,
            )
            .run(ZRODE_DATABASE_MIGRATION_NAMES_BY_ID[33], LEGACY_T3_MIGRATION_33_NAME);
        }
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
      if (hasLegacyT3Migration) {
        compatibilityActions.push(
          `translated migration 33 from ${LEGACY_T3_MIGRATION_33_NAME} to ${ZRODE_DATABASE_MIGRATION_NAMES_BY_ID[33]}`,
        );
      }
      if (legacyEventCount > 0) {
        compatibilityActions.push(
          `archived and translated ${legacyEventCount} legacy T3 thread lifecycle event${legacyEventCount === 1 ? "" : "s"}`,
        );
      }
    }

    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  await NodeFSP.rm(`${path}-wal`, { force: true });
  await NodeFSP.rm(`${path}-shm`, { force: true });
  return compatibilityActions;
}

function assertMatchingDatabaseHistory(
  source: ZrodeStateDatabaseSummary,
  destination: ZrodeStateDatabaseSummary,
): void {
  const keys = [
    "migrationId",
    "eventCount",
    "maxEventSequence",
    "projectCount",
    "threadCount",
    "messageCount",
    "queuedTurnCount",
    "pendingApprovalCount",
  ] as const;
  for (const key of keys) {
    if (source[key] !== destination[key]) {
      throw new Error(
        `Database validation mismatch for ${key}: source=${source[key]}, destination=${destination[key]}.`,
      );
    }
  }
  if (destination.runningProviderSessionCount !== 0) {
    throw new Error("The migrated database still owns provider runtime sessions.");
  }
}

function migrationError(
  operation: ZrodeStateMigrationOperation,
  sourcePath: string,
  destinationPath: string,
  cause: unknown,
): ZrodeStateMigrationError {
  return new ZrodeStateMigrationError({
    operation,
    sourcePath,
    destinationPath,
    cause,
  });
}

export const inspectZrodeStateMigration = Effect.fn("inspectZrodeStateMigration")(
  function* (input: {
    readonly sourceBaseDir: string;
    readonly destinationBaseDir: string;
  }): Effect.fn.Return<ZrodeStateMigrationInspection, ZrodeStateMigrationFailure> {
    const sourceDatabasePath = databasePath(input.sourceBaseDir);
    const destinationDatabasePath = databasePath(input.destinationBaseDir);

    const destinationDatabaseExists = yield* Effect.tryPromise({
      try: () => pathExists(destinationDatabasePath),
      catch: (cause) =>
        migrationError("inspect-destination", sourceDatabasePath, destinationDatabasePath, cause),
    });
    if (destinationDatabaseExists) {
      return {
        status: "not-needed",
        reason: "destination-initialized",
      };
    }

    const existingReceipt = yield* Effect.tryPromise({
      try: () => readReceipt(input.destinationBaseDir),
      catch: (cause) =>
        migrationError("inspect-destination", sourceDatabasePath, destinationDatabasePath, cause),
    });
    if (existingReceipt !== undefined) {
      return {
        status: "not-needed",
        reason: "decision-recorded",
        receipt: existingReceipt,
      };
    }

    const destinationExists = yield* Effect.tryPromise({
      try: () => pathExists(input.destinationBaseDir),
      catch: (cause) =>
        migrationError("inspect-destination", sourceDatabasePath, destinationDatabasePath, cause),
    });
    if (destinationExists) {
      return {
        status: "destination-conflict",
        destinationBaseDir: input.destinationBaseDir,
      };
    }

    const sourceExists = yield* Effect.tryPromise({
      try: () => pathExists(sourceDatabasePath),
      catch: (cause) =>
        migrationError("inspect-source", sourceDatabasePath, destinationDatabasePath, cause),
    });
    if (!sourceExists) {
      return {
        status: "not-needed",
        reason: "source-missing",
      };
    }

    const sourceDatabase = yield* Effect.tryPromise({
      try: () => inspectDatabase(sourceDatabasePath),
      catch: (cause) =>
        migrationError("inspect-database", sourceDatabasePath, destinationDatabasePath, cause),
    });
    const sourceDatabaseInfo = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(sourceDatabasePath),
      catch: (cause) =>
        migrationError("inspect-source", sourceDatabasePath, destinationDatabasePath, cause),
    });
    return {
      status: "pending",
      sourceBaseDir: input.sourceBaseDir,
      destinationBaseDir: input.destinationBaseDir,
      sourceDatabasePath,
      sourceDatabaseSizeBytes: sourceDatabaseInfo.size,
      sourceDatabase,
    };
  },
);

export const migrateZrodeState = Effect.fn("migrateZrodeState")(function* (
  input: ZrodeStateMigrationInput,
): Effect.fn.Return<ZrodeStateMigrationReceipt, ZrodeStateMigrationFailure> {
  const sourceDatabasePath = databasePath(input.sourceBaseDir);
  const destinationDatabasePath = databasePath(input.destinationBaseDir);
  const stagingBaseDir = stagingBaseDirectory(input.destinationBaseDir);
  const stagingDatabasePath = databasePath(stagingBaseDir);
  input.onProgress?.({ phase: "preflight", completed: 0, total: 1 });

  const inspection = yield* inspectZrodeStateMigration(input);
  if (inspection.status === "destination-conflict") {
    return yield* new ZrodeStateMigrationDestinationConflictError({
      destinationBaseDir: inspection.destinationBaseDir,
    });
  }
  if (inspection.status !== "pending") {
    return yield* migrationError(
      "inspect-source",
      sourceDatabasePath,
      destinationDatabasePath,
      new Error(`Migration is not pending: ${inspection.reason}.`),
    );
  }
  if (
    inspection.sourceDatabase.queuedTurnCount > 0 ||
    inspection.sourceDatabase.pendingApprovalCount > 0
  ) {
    return yield* new ZrodeStateMigrationBusyStateError({
      queuedTurnCount: inspection.sourceDatabase.queuedTurnCount,
      pendingApprovalCount: inspection.sourceDatabase.pendingApprovalCount,
    });
  }
  yield* Effect.tryPromise({
    try: () => inspectDatabase(sourceDatabasePath, { quickCheck: true }),
    catch: (cause) =>
      migrationError("inspect-database", sourceDatabasePath, destinationDatabasePath, cause),
  });

  const durableBytes = yield* Effect.tryPromise({
    try: () => durableStateSize(input.sourceBaseDir),
    catch: (cause) =>
      migrationError("inspect-free-space", sourceDatabasePath, destinationDatabasePath, cause),
  });
  const payloadBytes = inspection.sourceDatabaseSizeBytes + durableBytes;
  const marginBytes = Math.max(
    MINIMUM_FREE_SPACE_MARGIN_BYTES,
    Math.ceil(payloadBytes * FREE_SPACE_MARGIN_RATIO),
  );
  const requiredBytes = payloadBytes + marginBytes;
  const available = yield* Effect.tryPromise({
    try: () =>
      input.availableBytesOverride === undefined
        ? availableBytes(NodePath.dirname(input.destinationBaseDir))
        : Promise.resolve(input.availableBytesOverride),
    catch: (cause) =>
      migrationError("inspect-free-space", sourceDatabasePath, destinationDatabasePath, cause),
  });
  if (available < requiredBytes) {
    return yield* new ZrodeStateMigrationInsufficientSpaceError({
      destinationBaseDir: input.destinationBaseDir,
      requiredBytes,
      availableBytes: available,
    });
  }

  yield* Effect.tryPromise({
    try: () =>
      prepareStagingDirectory({
        stagingBaseDir,
        sourceBaseDir: input.sourceBaseDir,
        destinationBaseDir: input.destinationBaseDir,
      }),
    catch: (cause) =>
      migrationError("prepare-staging", sourceDatabasePath, stagingDatabasePath, cause),
  });
  yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(NodePath.dirname(stagingDatabasePath), { recursive: true });
      await backupDatabase({
        sourceDatabasePath,
        destinationDatabasePath: stagingDatabasePath,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      });
    },
    catch: (cause) =>
      cause instanceof SourceChangedDuringBackup
        ? new ZrodeStateMigrationSourceChangedError({ sourceDatabasePath })
        : migrationError("backup-database", sourceDatabasePath, stagingDatabasePath, cause),
  });

  input.onProgress?.({ phase: "copy-durable-files", completed: 0, total: 1 });
  const copiedFiles = yield* Effect.tryPromise({
    try: () =>
      copyDurableState({
        sourceBaseDir: input.sourceBaseDir,
        stagingBaseDir,
      }),
    catch: (cause) =>
      migrationError("copy-durable-files", sourceDatabasePath, stagingBaseDir, cause),
  });

  input.onProgress?.({ phase: "reset-machine-identity", completed: 0, total: 1 });
  yield* Effect.tryPromise({
    try: () => resetMachineIdentity(stagingDatabasePath),
    catch: (cause) =>
      migrationError("reset-machine-identity", sourceDatabasePath, stagingDatabasePath, cause),
  });

  input.onProgress?.({ phase: "validate", completed: 0, total: 1 });
  const sourceAfterBackup = yield* Effect.tryPromise({
    try: () => inspectDatabase(sourceDatabasePath),
    catch: (cause) =>
      migrationError("validate-database", sourceDatabasePath, stagingDatabasePath, cause),
  });
  if (
    sourceAfterBackup.eventCount !== inspection.sourceDatabase.eventCount ||
    sourceAfterBackup.maxEventSequence !== inspection.sourceDatabase.maxEventSequence
  ) {
    return yield* new ZrodeStateMigrationSourceChangedError({ sourceDatabasePath });
  }
  const destinationBeforeCompatibility = yield* Effect.tryPromise({
    try: () => inspectDatabase(stagingDatabasePath, { quickCheck: true }),
    catch: (cause) =>
      migrationError("validate-database", sourceDatabasePath, stagingDatabasePath, cause),
  });
  yield* Effect.try({
    try: () =>
      assertMatchingDatabaseHistory(inspection.sourceDatabase, destinationBeforeCompatibility),
    catch: (cause) =>
      migrationError("validate-database", sourceDatabasePath, stagingDatabasePath, cause),
  });
  const compatibilityActions = yield* Effect.tryPromise({
    try: () => validateAndTranslateStagedDatabase(stagingDatabasePath),
    catch: (cause) =>
      isZrodeStateMigrationCompatibilityError(cause)
        ? cause
        : migrationError("validate-compatibility", sourceDatabasePath, stagingDatabasePath, cause),
  });
  const destinationDatabase = yield* Effect.tryPromise({
    try: () => inspectDatabase(stagingDatabasePath, { quickCheck: true }),
    catch: (cause) =>
      migrationError("validate-database", sourceDatabasePath, stagingDatabasePath, cause),
  });
  yield* Effect.try({
    try: () => assertMatchingDatabaseHistory(inspection.sourceDatabase, destinationDatabase),
    catch: (cause) =>
      migrationError("validate-database", sourceDatabasePath, stagingDatabasePath, cause),
  });

  const completedAt =
    input.now === undefined ? DateTime.formatIso(yield* DateTime.now) : input.now();
  const receipt: ZrodeStateMigrationReceipt = {
    version: 1,
    decision: "imported",
    sourceBaseDir: input.sourceBaseDir,
    destinationBaseDir: input.destinationBaseDir,
    completedAt,
    appVersion: input.appVersion,
    sourceDatabase: inspection.sourceDatabase,
    destinationDatabase,
    copiedFiles: [ZRODE_STATE_DATABASE_RELATIVE_PATH, ...copiedFiles],
    identityReset: [
      ...RESET_DATABASE_TABLES,
      "connection-catalog",
      "environment-id",
      "server-runtime",
      "signing-secrets",
      "cloud-auth",
    ],
    compatibilityActions,
  };
  yield* Effect.tryPromise({
    try: () => writeJson(receiptPath(stagingBaseDir), receipt),
    catch: (cause) => migrationError("write-receipt", sourceDatabasePath, stagingBaseDir, cause),
  });
  yield* Effect.tryPromise({
    try: () => NodeFSP.rm(NodePath.join(stagingBaseDir, ZRODE_MIGRATION_STAGING_MARKER_FILE_NAME)),
    catch: (cause) => migrationError("write-receipt", sourceDatabasePath, stagingBaseDir, cause),
  });

  input.onProgress?.({ phase: "cutover", completed: 0, total: 1 });
  yield* Effect.tryPromise({
    try: () => NodeFSP.rename(stagingBaseDir, input.destinationBaseDir),
    catch: (cause) =>
      migrationError("cutover", sourceDatabasePath, input.destinationBaseDir, cause),
  });
  input.onProgress?.({ phase: "cutover", completed: 1, total: 1 });
  return receipt;
});

export const recordFreshZrodeStateDecision = Effect.fn("recordFreshZrodeStateDecision")(function* (
  input: Omit<ZrodeStateMigrationInput, "onProgress" | "availableBytesOverride">,
): Effect.fn.Return<ZrodeStateMigrationReceipt, ZrodeStateMigrationFailure> {
  const sourceDatabasePath = databasePath(input.sourceBaseDir);
  const destinationDatabasePath = databasePath(input.destinationBaseDir);

  const destinationExists = yield* Effect.tryPromise({
    try: () => pathExists(input.destinationBaseDir),
    catch: (cause) =>
      migrationError("inspect-destination", sourceDatabasePath, destinationDatabasePath, cause),
  });
  if (destinationExists) {
    return yield* new ZrodeStateMigrationDestinationConflictError({
      destinationBaseDir: input.destinationBaseDir,
    });
  }

  const sourceExists = yield* Effect.tryPromise({
    try: () => pathExists(sourceDatabasePath),
    catch: (cause) =>
      migrationError("inspect-source", sourceDatabasePath, destinationDatabasePath, cause),
  });
  if (!sourceExists) {
    return yield* migrationError(
      "inspect-source",
      sourceDatabasePath,
      destinationDatabasePath,
      new Error("A fresh-state decision is not pending because the legacy database is absent."),
    );
  }

  const stagingBaseDir = stagingBaseDirectory(input.destinationBaseDir);
  yield* Effect.tryPromise({
    try: () =>
      prepareStagingDirectory({
        stagingBaseDir,
        sourceBaseDir: input.sourceBaseDir,
        destinationBaseDir: input.destinationBaseDir,
      }),
    catch: (cause) => migrationError("prepare-staging", sourceDatabasePath, stagingBaseDir, cause),
  });
  const completedAt =
    input.now === undefined ? DateTime.formatIso(yield* DateTime.now) : input.now();
  const receipt: ZrodeStateMigrationReceipt = {
    version: 1,
    decision: "start-fresh",
    sourceBaseDir: input.sourceBaseDir,
    destinationBaseDir: input.destinationBaseDir,
    completedAt,
    appVersion: input.appVersion,
    copiedFiles: [],
    identityReset: [
      "connection-catalog",
      "environment-id",
      "server-runtime",
      "signing-secrets",
      "cloud-auth",
    ],
  };
  yield* Effect.tryPromise({
    try: () => writeJson(receiptPath(stagingBaseDir), receipt),
    catch: (cause) => migrationError("write-receipt", sourceDatabasePath, stagingBaseDir, cause),
  });
  yield* Effect.tryPromise({
    try: () => NodeFSP.rm(NodePath.join(stagingBaseDir, ZRODE_MIGRATION_STAGING_MARKER_FILE_NAME)),
    catch: (cause) => migrationError("write-receipt", sourceDatabasePath, stagingBaseDir, cause),
  });
  yield* Effect.tryPromise({
    try: () => NodeFSP.rename(stagingBaseDir, input.destinationBaseDir),
    catch: (cause) =>
      migrationError("cutover", sourceDatabasePath, input.destinationBaseDir, cause),
  });
  return receipt;
});
