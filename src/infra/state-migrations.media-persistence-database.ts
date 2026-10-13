// Bounded media scans inside the Doctor migration owner's transaction.
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  readSelectedTranscriptPayload,
  transcriptPayloadColumns,
} from "../config/sessions/transcript-payload.js";
import {
  canonicalizePersistedUserMessageMedia,
  hasMeaningfulRetiredMediaCarrier,
} from "../media/media-facts.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { engineTextByteSliceSql } from "./database-engine/text-bytes.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  parseTranscriptEvent,
  transformTranscriptEvent,
} from "./state-migrations.media-persistence-transform.js";

const MEDIA_MIGRATION_ROW_BATCH_SIZE = 64;

type MediaMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_windows" | "trajectory_runtime_events" | "transcript_events"
>;

function forEachMediaEventBatch(params: {
  database: DatabaseSync;
  table: "trajectory_runtime_events" | "transcript_events";
  legacyTextStorage?: boolean;
  visit: (rows: Array<{ event_json: string; seq: number; session_id: string }>) => "stop" | void;
}): void {
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(params.database);
  const payloadColumns = params.legacyTextStorage
    ? [
        engineTextByteSliceSql(params.database, sql.ref<string>("event_json"), 1, 64 * 1024).as(
          "event_data",
        ),
        sql<Uint8Array | null>`NULL`.as("event_zstd"), // kysely-allow-raw: pre22 schema stores only identity TEXT.
        sql<number | null>`NULL`.as("event_utf8_bytes"), // kysely-allow-raw: pre22 schema has no payload byte metadata.
        sql.ref<string>("session_id").as("payload_session_id"),
        sql.ref<number>("seq").as("payload_seq"),
      ]
    : transcriptPayloadColumns(params.database);
  let cursor: { seq: number; sessionId: string } | undefined;
  while (true) {
    let query = db
      .selectFrom(params.table)
      .select(["session_id", "seq"])
      .orderBy("session_id", "asc")
      .orderBy("seq", "asc")
      .limit(MEDIA_MIGRATION_ROW_BATCH_SIZE);
    const after = cursor;
    if (after) {
      // Keep SQLite on a composite primary-key seek. Expanding this tuple into
      // OR branches restarts the index scan for every page.
      query = query.where((expression) =>
        expression(
          expression.refTuple("session_id", "seq"),
          ">",
          expression.tuple(after.sessionId, after.seq),
        ),
      );
    }
    const rows =
      params.table === "transcript_events"
        ? executeSqliteQuerySync(params.database, query.select(payloadColumns)).rows.map((row) => ({
            session_id: row.session_id,
            seq: row.seq,
            event_json: readSelectedTranscriptPayload(params.database, row),
          }))
        : executeSqliteQuerySync(
            params.database,
            query.select(
              // kysely-allow-raw: trajectory events retain required identity TEXT.
              sql.ref<string>("event_json").as("event_json"),
            ),
          ).rows;
    const last = rows.at(-1);
    if (!last) {
      return;
    }
    if (params.visit(rows) === "stop") {
      return;
    }
    cursor = { seq: last.seq, sessionId: last.session_id };
  }
}

export function scanTranscriptRows(params: {
  database: DatabaseSync;
  pathname: string;
  writer?: OpenClawAgentDatabase;
  legacyTextStorage: boolean;
  onChangedSession?: (sessionId: string) => void;
}): number {
  const { database, pathname, writer } = params;
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  let lastChangedSessionId: string | undefined;
  let changedSessions = 0;
  forEachMediaEventBatch({
    database,
    table: "transcript_events",
    legacyTextStorage: params.legacyTextStorage,
    visit: (rows): "stop" | void => {
      const sessionIds = [...new Set(rows.map((row) => row.session_id))];
      const sessionKeys = new Map(
        executeSqliteQuerySync(
          database,
          db
            .selectFrom("session_windows")
            .select(["session_id", "session_key"])
            .where("session_id", "in", sessionIds),
        ).rows.map((row) => [row.session_id, row.session_key]),
      );
      for (const sessionId of sessionIds) {
        if (!sessionKeys.has(sessionId)) {
          throw new Error(`${pathname}:${sessionId} has transcript rows without a session window`);
        }
      }
      const rewritesBySession = new Map<
        string,
        Array<{ event: TranscriptEvent; expectedEventJson: string; seq: number }>
      >();
      for (const row of rows) {
        const owner = `${pathname}:${row.session_id}:${row.seq}`;
        const event = parseTranscriptEvent(row.event_json, owner);
        const transformed = transformTranscriptEvent(event);
        if (!transformed.changed) {
          continue;
        }
        if (lastChangedSessionId !== row.session_id) {
          lastChangedSessionId = row.session_id;
          changedSessions += 1;
          params.onChangedSession?.(row.session_id);
        }
        // Detection only selects the repair path; that transaction validates every row.
        if (!writer) {
          return "stop";
        }
        const rewrites = rewritesBySession.get(row.session_id) ?? [];
        rewrites.push({
          event: transformed.event,
          expectedEventJson: row.event_json,
          seq: row.seq,
        });
        rewritesBySession.set(row.session_id, rewrites);
      }
      if (writer) {
        for (const [sessionId, rewrites] of rewritesBySession) {
          const sessionKey = sessionKeys.get(sessionId);
          if (!sessionKey) {
            throw new Error(
              `${pathname}:${sessionId} has transcript rows without a session window`,
            );
          }
          rewriteSqliteTranscriptEventRowsInTransaction(
            writer,
            { agentId: writer.agentId, path: pathname, sessionId, sessionKey },
            rewrites,
            { legacyTextStorage: params.legacyTextStorage },
          );
        }
      }
    },
  });
  return changedSessions;
}

function rewriteTrajectoryEventJson(eventJson: string, owner: string): string {
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch (error) {
    throw new Error(`${owner} contains invalid trajectory JSON: ${String(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(event) || !isRecord(event.data) || !Array.isArray(event.data.messagesSnapshot)) {
    return eventJson;
  }
  let changed = false;
  const messagesSnapshot = event.data.messagesSnapshot.map((message) => {
    if (!isRecord(message) || !hasMeaningfulRetiredMediaCarrier(message)) {
      return message;
    }
    const canonical = canonicalizePersistedUserMessageMedia(message);
    changed ||= canonical.changed;
    return canonical.message;
  });
  return changed
    ? JSON.stringify({ ...event, data: { ...event.data, messagesSnapshot } })
    : eventJson;
}

export function scanTrajectoryRows(params: {
  database: DatabaseSync;
  pathname: string;
  rewrite: boolean;
}): number {
  const { database, pathname, rewrite } = params;
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  let changedRows = 0;
  forEachMediaEventBatch({
    database,
    table: "trajectory_runtime_events",
    visit: (rows): "stop" | void => {
      for (const row of rows) {
        const rewrittenEventJson = rewriteTrajectoryEventJson(
          row.event_json,
          `${pathname}:${row.session_id}:${row.seq}`,
        );
        if (rewrittenEventJson === row.event_json) {
          continue;
        }
        changedRows += 1;
        if (!rewrite) {
          return "stop";
        }
        executeSqliteQuerySync(
          database,
          db
            .updateTable("trajectory_runtime_events")
            .set({ event_json: rewrittenEventJson })
            .where("session_id", "=", row.session_id)
            .where("seq", "=", row.seq),
        );
      }
    },
  });
  return changedRows;
}
