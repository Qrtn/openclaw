import type { DatabaseSync } from "node:sqlite";
import { sql, type Expression, type RawBuilder } from "kysely";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";

/** Slice encoded bytes on the server; SQLite retains its physical text encoding. */
export function engineTextByteSliceSql(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<string | null>,
  offset: number | Expression<number>,
  length: number,
): RawBuilder<Uint8Array | null> {
  /* kysely-allow-raw: Each engine slices bytes rather than Unicode characters. */
  return isPostgresSqlConnection(db)
    ? sql<Uint8Array | null>`substring(convert_to(${value}, 'UTF8') FROM ${offset} FOR ${length})`
    : sql<Uint8Array | null>`CASE WHEN ${value} IS NULL THEN NULL
        ELSE coalesce(substr(CAST(${value} AS BLOB), ${offset}, ${length}), CAST('' AS BLOB)) END`;
}
