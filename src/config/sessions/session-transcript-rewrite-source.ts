import type { DatabaseSync } from "node:sqlite";
import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import { getNodeSqliteKysely, prepareSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  advanceTranscriptMutationAtInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  readSelectedTranscriptPayload,
  transcriptPayloadColumns,
  type SelectedTranscriptPayload,
} from "./transcript-payload.js";

/** Compare immediately before each update: one transaction may rewrite the same seq again. */
export function createCompressedTranscriptRewriteMatcher(
  database: DatabaseSync,
  sessionId: string,
) {
  const read = prepareSqliteQueryTakeFirstSync<number, SelectedTranscriptPayload>(
    database,
    (parameter) =>
      getNodeSqliteKysely<Pick<DB, "transcript_events">>(database)
        .selectFrom("transcript_events")
        .select(transcriptPayloadColumns(database))
        .where("session_id", "=", sessionId)
        .where(
          "seq",
          "=",
          parameter((seq) => seq),
        )
        .where("event_json", "is", null),
  );
  return (seq: number, expectedJson: string): boolean => {
    const source = read(seq);
    return source !== undefined && readSelectedTranscriptPayload(database, source) === expectedJson;
  };
}

/** Identity equality remains server-side, including oversized and exceptional text. */
export function transcriptRewriteSourceMatchesSql(
  expectedJson: Expression<string>,
  compressedMatches: Expression<number>,
): RawBuilder<SqlBool> {
  /* kysely-allow-raw: the caller holds the writer transaction from source comparison through effect. */
  return sql<SqlBool>`(event_json = ${expectedJson} OR (event_json IS NULL AND ${compressedMatches} = 1))`;
}

/** Invalidate replacement snapshots without making a repaired old session newly active. */
export function recordTranscriptReplacementMutation(
  database: OpenClawAgentDatabase,
  sessionId: string,
  preservedUpdatedAt: number | null | undefined,
): void {
  if (preservedUpdatedAt === undefined || preservedUpdatedAt === null) {
    touchTranscriptMutationInTransaction(database, sessionId);
  } else {
    advanceTranscriptMutationAtInTransaction(database, sessionId, preservedUpdatedAt, {
      strictly: true,
    });
  }
}
