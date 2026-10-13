/** Read-only transcript detection; positive repairs retain exact snapshots. */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import type { SqliteTranscriptStorageRow } from "../config/sessions/session-accessor.sqlite-read.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  readSelectedTranscriptPayload,
  transcriptPayloadColumns,
  type SelectedTranscriptPayload,
} from "../config/sessions/transcript-payload.js";
import { engineTextByteSliceSql } from "../infra/database-engine/text-bytes.js";
import { prepareSqliteQueryIterator } from "../infra/kysely-sync.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";

type PayloadRow = SelectedTranscriptPayload & { seq: number };

type ReadOnlyTranscriptSnapshot =
  | {
      ok: true;
      rows: Array<{ eventJson: string; seq: number }>;
    }
  | { ok: false; error: unknown };

function resetReadIterator(iterator: Iterator<unknown> | undefined): void {
  // A throwing next() does not close its iterator; reset before the next session.
  try {
    iterator?.return?.();
  } catch {
    // Preserve the original read error if cleanup fails.
  }
}

export class ReadOnlySqliteTranscriptReader {
  private sessionKey?: StatementSync;
  private readonly readRows;
  private readonly readFirst;
  private readonly readStorageRows;

  // Compile lazily executed reads so old databases need only the columns used by each path.
  constructor(private readonly database: DatabaseSync) {
    const db = getSessionKysely(database);
    // Doctor also inspects pre-compression databases; identity TEXT still crosses in slices.
    const columns = tableHasColumn(database, "transcript_events", "event_zstd")
      ? transcriptPayloadColumns(database)
      : [
          engineTextByteSliceSql(database, sql.ref<string>("event_json"), 1, 64 * 1024).as(
            "event_data",
          ),
          sql<Uint8Array | null>`NULL`.as("event_zstd"), // kysely-allow-raw: legacy schema has no compressed payload.
          sql<number | null>`NULL`.as("event_utf8_bytes"), // kysely-allow-raw: legacy schema has no byte metadata.
          sql.ref<string>("session_id").as("payload_session_id"),
          sql.ref<number>("seq").as("payload_seq"),
        ];
    const query = db.selectFrom("transcript_events").select(columns).select("seq");
    this.readRows = prepareSqliteQueryIterator<string, PayloadRow>(database, (parameter) =>
      query
        .where(
          "session_id",
          "=",
          parameter((sessionId) => sessionId),
        )
        .orderBy("seq", "asc"),
    );
    this.readFirst = prepareSqliteQueryIterator<string, PayloadRow>(database, (parameter) =>
      query
        .where(
          "session_id",
          "=",
          parameter((sessionId) => sessionId),
        )
        .orderBy("seq", "asc")
        .limit(1),
    );
    this.readStorageRows = prepareSqliteQueryIterator<string, PayloadRow & { created_at: number }>(
      database,
      (parameter) =>
        query
          .select("created_at")
          .where(
            "session_id",
            "=",
            parameter((sessionId) => sessionId),
          )
          .orderBy("seq", "asc"),
    );
  }

  sessionIds(): string[] {
    if (!tableExists(this.database, "transcript_events")) {
      return [];
    }
    // Enumerate the schema-stable events table, not post-ship sessions columns.
    // Materialize IDs so enumeration cannot hold a read transaction across repairs.
    const rows = this.database
      .prepare("SELECT DISTINCT session_id FROM transcript_events ORDER BY session_id ASC")
      .all();
    return rows.flatMap((row) => (typeof row.session_id === "string" ? [row.session_id] : []));
  }

  repairSnapshot(
    sessionId: string,
    needsRepair: (event: unknown) => boolean,
    mayNeedRepair: (eventJson: string) => boolean,
  ): ReadOnlyTranscriptSnapshot {
    let iterator: Iterator<unknown> | undefined;
    try {
      // Unchanged histories retain one payload. Re-read positive candidates in full so
      // malformed siblings and exact-snapshot guards still govern the surgical repair.
      const detection = this.readRows(sessionId);
      iterator = detection;
      for (const row of detection) {
        if (typeof row.seq !== "number") {
          continue;
        }
        const eventJson = readSelectedTranscriptPayload(this.database, row);
        if (!mayNeedRepair(eventJson)) {
          continue;
        }
        let event: unknown;
        try {
          event = JSON.parse(eventJson);
        } catch {
          continue;
        }
        if (!needsRepair(event)) {
          continue;
        }
        const rows: Array<{ eventJson: string; seq: number }> = [];
        // Detection is still iterating: its nested exact snapshot needs a distinct statement.
        const snapshot = this.readRows(sessionId);
        iterator = snapshot;
        for (const candidate of snapshot) {
          if (typeof candidate.seq === "number") {
            rows.push({
              eventJson: readSelectedTranscriptPayload(this.database, candidate),
              seq: candidate.seq,
            });
          }
        }
        return { ok: true, rows };
      }
      return { ok: true, rows: [] };
    } catch (error) {
      resetReadIterator(iterator);
      return { ok: false, error };
    }
  }

  /** Reads exact row metadata for a guarded transcript replacement without opening a writer. */
  headerlessSnapshot(
    sessionId: string,
    acceptRow: (row: SqliteTranscriptStorageRow) => boolean,
  ):
    | { ok: true; rows: SqliteTranscriptStorageRow[]; sessionKey?: string }
    | { ok: false; error: unknown } {
    let iterator: Iterator<unknown> | undefined;
    try {
      // Headers can live at nonzero seq. A current header needs no whole-history read;
      // possible headerless repairs still take and validate the complete exact snapshot.
      for (const firstRow of this.readFirst(sessionId)) {
        const eventJson = readSelectedTranscriptPayload(this.database, firstRow);
        let first: unknown;
        try {
          first = JSON.parse(eventJson);
        } catch {
          return { ok: true, rows: [] };
        }
        if (!isRecord(first) || first.type === "session") {
          return { ok: true, rows: [] };
        }
      }
      this.sessionKey ??= this.database.prepare(
        "SELECT session_key FROM session_windows WHERE session_id = ? LIMIT 1",
      );
      const sessionKeyRow = this.sessionKey.get(sessionId);
      const storageRows: SqliteTranscriptStorageRow[] = [];
      const snapshot = this.readStorageRows(sessionId);
      iterator = snapshot;
      for (const row of snapshot) {
        if (typeof row.created_at !== "number" || typeof row.seq !== "number") {
          return {
            ok: false,
            error: new Error(`Invalid transcript row metadata for session ${sessionId}`),
          };
        }
        const storageRow = {
          createdAt: row.created_at,
          eventJson: readSelectedTranscriptPayload(this.database, row),
          seq: row.seq,
        };
        // Reject an ineligible prefix before retaining the rest of a large history.
        // Positive repairs still carry every exact row into writer revalidation.
        if (!acceptRow(storageRow)) {
          return { ok: true, rows: [] };
        }
        storageRows.push(storageRow);
      }
      return {
        ok: true,
        rows: storageRows,
        ...(typeof sessionKeyRow?.session_key === "string"
          ? { sessionKey: sessionKeyRow.session_key }
          : {}),
      };
    } catch (error) {
      resetReadIterator(iterator);
      return { ok: false, error };
    }
  }
}
