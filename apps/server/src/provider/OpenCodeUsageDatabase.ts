import * as NodeSqlite from "node:sqlite";

export interface OpenCodeUsageDatabaseRow {
  readonly id: string;
  readonly timeCreated: number;
  readonly data: string;
}

/**
 * Read modern OpenCode assistant messages from its local SQLite store.
 * The database is opened read-only and closed before returning, so this can
 * run while OpenCode owns the writer connection without mutating its state.
 */
export function readOpenCodeUsageDatabase(
  filename: string,
  cutoffMs: number,
): ReadonlyArray<OpenCodeUsageDatabaseRow> {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `
          SELECT id, time_created AS timeCreated, data
          FROM message
          WHERE time_created >= ?
            AND json_valid(data)
            AND json_extract(data, '$.role') = 'assistant'
        `,
      )
      .all(cutoffMs) as ReadonlyArray<Record<string, unknown>>;
    return rows.flatMap((row) =>
      typeof row.id === "string" &&
      typeof row.timeCreated === "number" &&
      Number.isFinite(row.timeCreated) &&
      typeof row.data === "string"
        ? [{ id: row.id, timeCreated: row.timeCreated, data: row.data }]
        : [],
    );
  } finally {
    database.close();
  }
}
