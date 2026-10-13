import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../agents/internal-runtime-context.js";
import { SOURCE_PAGE_MAX_BYTES } from "../../gateway/session-transcript-source-pages.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  resolveHistoryAnchorPageRange,
  type TranscriptAnchorPageOptions,
} from "../../sessions/transcript-anchor-page.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { positionTranscriptDisplayEvents } from "./session-accessor.sqlite-display-position.js";
import { findUnindexedActiveTranscriptEntry } from "./session-accessor.sqlite-history-navigation.js";
import {
  getActiveTranscriptKysely,
  type SessionTranscriptMessageAnchorPage,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-projection-read.js";
import {
  readUnindexedHistoryControls,
  resolveClosedResetInterval,
  type ClosedResetInterval,
} from "./session-accessor.sqlite-reset-window.js";
import { isVisibleHistoryNonMessageEvent } from "./session-history-visibility.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { readSelectedTranscriptPayload, transcriptPayloadColumns } from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";

/** Select display slots without loading custom content or details into history metadata. */
export function isVisibleHistoryNonMessageEventSql(
  type: Expression<string | null>,
  display: Expression<number>,
  customType: Expression<string | null>,
  valid: Expression<number>,
): RawBuilder<SqlBool> {
  return /* kysely-allow-raw: malformed selected custom messages are returned for the existing read refusal. */ sql<SqlBool>`(${type} IN ('compaction', 'reset', 'custom_message') AND CASE
    WHEN ${type} IN ('compaction', 'reset') THEN TRUE
    WHEN ${type} = 'custom_message' THEN
      ${valid} = 0 OR (${display} = 1 AND (${customType} IS NULL OR ${customType} != ${OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE}))
    ELSE FALSE END)`;
}

export const historyNavigationValidSql =
  /* kysely-allow-raw: only custom-message visibility needs navigation parsing. */
  sql<number>`CASE WHEN identity.event_type = 'custom_message' THEN event.navigation_valid ELSE 1 END`;

export function parseStoredTranscriptEvent(eventJson: string): TranscriptEvent {
  // SAFETY: The active projection indexes serialized TranscriptEvent rows.
  return JSON.parse(eventJson) as TranscriptEvent;
}

function selectHistoricalDisplayEvents(
  projection: CurrentTranscriptProjection,
  interval: ClosedResetInterval,
) {
  const active = getActiveTranscriptKysely(projection.database).selectFrom(
    "session_transcript_active_events as active",
  );
  const identity =
    // Without statistics, the covering event-type index can scan the session for every row.
    getActiveTranscriptKysely(projection.database)
      .selectFrom("transcript_event_identities")
      .select(["session_id", "seq", "event_type"])
      .modifyEnd(
        /* kysely-allow-raw: pin the canonical sequence lookup to avoid quadratic cold-history joins. */ sql`INDEXED BY idx_agent_transcript_event_identity_sequence`,
      )
      .as("identity");
  const withIdentity = projection.hasUnindexedPrefix
    ? active.leftJoin(identity, (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
    : active.innerJoin(identity, (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      );
  const unindexedControls = readUnindexedHistoryControls(projection)
    .filter(
      (row) =>
        isVisibleHistoryNonMessageEvent(row.event) &&
        row.active_position > interval.startExclusiveActivePosition &&
        row.active_position <= interval.endInclusiveActivePosition,
    )
    .map((row) => row.event_seq);
  return withIdentity
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("active.active_position", ">", interval.startExclusiveActivePosition)
    .where("active.active_position", "<=", interval.endInclusiveActivePosition)
    .where((eb) =>
      eb.or([
        eb("active.message_position", "is not", null),
        isVisibleHistoryNonMessageEventSql(
          eb.ref("identity.event_type"),
          eb.ref("event.navigation_display"),
          eb.ref("event.navigation_custom_type"),
          eb.ref("event.navigation_valid"),
        ),
        ...(unindexedControls.length > 0
          ? [
              eb(
                "active.event_seq",
                "in",
                /* kysely-allow-raw: one bounded binding carries recovered control sequences. */
                sql<number>`(SELECT value FROM json_each(${JSON.stringify(unindexedControls)}))`,
              ),
            ]
          : []),
      ]),
    );
}

function selectDisplayableActiveEventById(
  projection: CurrentTranscriptProjection,
  eventId: string,
) {
  const db = getActiveTranscriptKysely(projection.database);
  return db
    .selectFrom("transcript_event_identities as identity")
    .innerJoin("session_transcript_active_events as active", (join) =>
      join
        .onRef("active.session_id", "=", "identity.session_id")
        .onRef("active.event_seq", "=", "identity.seq"),
    )
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select([
      "active.event_seq",
      "active.active_position",
      "active.message_position",
      "identity.event_type",
      historyNavigationValidSql.as("navigation_valid"),
    ])
    .where("identity.session_id", "=", projection.resolved.sessionId)
    .where("identity.event_id", "=", eventId)
    .where((eb) =>
      eb.or([
        eb("active.message_position", "is not", null),
        isVisibleHistoryNonMessageEventSql(
          eb.ref("identity.event_type"),
          eb.ref("event.navigation_display"),
          eb.ref("event.navigation_custom_type"),
          eb.ref("event.navigation_valid"),
        ),
      ]),
    );
}

export function readDisplayableActiveEventById(
  projection: CurrentTranscriptProjection,
  eventId: string,
  maxBytes?: number,
) {
  const db = getActiveTranscriptKysely(projection.database);
  const payloadColumns = transcriptPayloadColumns(projection.database.db, "event");
  const indexed = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    selectDisplayableActiveEventById(projection, eventId)
      .select((eb) =>
        eb
          .case()
          .when(
            maxBytes === undefined
              ? eb.val(true)
              : eb(transcriptEventReadBytesSql("event"), "<=", maxBytes),
          )
          .then(1)
          .else(0)
          .end()
          .as("payload_admitted"),
      )
      .select((eb) =>
        maxBytes === undefined
          ? payloadColumns
          : [
              eb
                .case()
                .when(eb(transcriptEventReadBytesSql("event"), "<=", maxBytes))
                .then(payloadColumns[0].expression)
                .else(null)
                .end()
                .as("event_data"),
              eb
                .case()
                .when(eb(transcriptEventReadBytesSql("event"), "<=", maxBytes))
                .then(payloadColumns[1].expression)
                .else(null)
                .end()
                .as("event_zstd"),
              eb
                .case()
                .when(eb(transcriptEventReadBytesSql("event"), "<=", maxBytes))
                .then(payloadColumns[2].expression)
                .else(null)
                .end()
                .as("event_utf8_bytes"),
              payloadColumns[3],
              payloadColumns[4],
            ],
      ),
  );
  assertTranscriptNavigationValid(indexed?.navigation_valid);
  if (indexed) {
    return indexed.payload_admitted === 0
      ? undefined
      : {
          event_seq: indexed.event_seq,
          active_position: indexed.active_position,
          message_position: indexed.message_position,
          event_type: indexed.event_type,
          navigation_valid: indexed.navigation_valid,
          event_json: readSelectedTranscriptPayload(projection.database.db, indexed),
        };
  }
  const unindexed = findUnindexedActiveTranscriptEntry(projection, eventId);
  if (
    !unindexed ||
    (unindexed.message_position === null && !isVisibleHistoryNonMessageEvent(unindexed.event))
  ) {
    return undefined;
  }
  if (maxBytes !== undefined && unindexed.serialized_bytes - 1 > maxBytes) {
    return undefined;
  }
  const event = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("transcript_events")
      .select(transcriptPayloadColumns(projection.database.db))
      .where("session_id", "=", projection.resolved.sessionId)
      .where("seq", "=", unindexed.event_seq),
  );
  return event
    ? {
        event_seq: unindexed.event_seq,
        active_position: unindexed.active_position,
        message_position: unindexed.message_position,
        event_type: typeof unindexed.event.type === "string" ? unindexed.event.type : null,
        event_json: readSelectedTranscriptPayload(projection.database.db, event),
      }
    : undefined;
}

export function readDisplayableActiveEventMetadataById(
  projection: CurrentTranscriptProjection,
  eventId: string,
) {
  const indexed = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    selectDisplayableActiveEventById(projection, eventId),
  );
  assertTranscriptNavigationValid(indexed?.navigation_valid);
  if (indexed) {
    return indexed;
  }
  const unindexed = findUnindexedActiveTranscriptEntry(projection, eventId);
  if (
    !unindexed ||
    (unindexed.message_position === null && !isVisibleHistoryNonMessageEvent(unindexed.event))
  ) {
    return undefined;
  }
  return {
    event_seq: unindexed.event_seq,
    active_position: unindexed.active_position,
    message_position: unindexed.message_position,
    event_type: typeof unindexed.event.type === "string" ? unindexed.event.type : null,
  };
}

function countHistoricalDisplayEvents(
  projection: CurrentTranscriptProjection,
  interval: ClosedResetInterval,
  beforeActivePosition: number,
): number {
  const query = selectHistoricalDisplayEvents(projection, interval)
    .select((eb) => [
      eb.fn.countAll<number>().as("event_count"),
      eb.fn.min(historyNavigationValidSql).as("navigation_valid"),
    ])
    .where("active.active_position", "<", beforeActivePosition);
  const row = executeSqliteQueryTakeFirstSync(projection.database.db, query);
  assertTranscriptNavigationValid(row?.navigation_valid ?? undefined);
  return row?.event_count ?? 0;
}

function readHistoricalDisplayEventRange(
  projection: CurrentTranscriptProjection,
  displaySource: string | undefined,
  interval: ClosedResetInterval,
  start: number,
  count: number,
  anchor: { activePosition: number; displayPosition: number },
  maxBytes?: number,
): SessionTranscriptMessageEvent[] {
  if (count <= 0) {
    return [];
  }
  const query = selectHistoricalDisplayEvents(projection, interval).select((eb) => [
    "active.event_seq",
    historyNavigationValidSql.as("navigation_valid"),
    eb(transcriptEventReadBytesSql("event"), "+", 1).as("serialized_bytes"),
  ]);
  const olderCount = anchor.displayPosition - start;
  // The anchor already identifies the physical position; visit only its selected neighbors.
  const older =
    olderCount === 0
      ? []
      : executeSqliteQuerySync(
          projection.database.db,
          query
            .where("active.active_position", "<", anchor.activePosition)
            .orderBy("active.active_position", "desc")
            .limit(olderCount),
        ).rows;
  const newer = executeSqliteQuerySync(
    projection.database.db,
    query
      .where("active.active_position", ">=", anchor.activePosition)
      .orderBy("active.active_position", "asc")
      .limit(count - olderCount),
  ).rows;
  const ranged = [...older.toReversed(), ...newer].map((row, index) => {
    assertTranscriptNavigationValid(row.navigation_valid);
    return Object.assign(row, { displaySeq: start + index + 1 });
  });
  let selected = ranged;
  if (
    maxBytes === undefined &&
    ranged.reduce((bytes, row) => bytes + row.serialized_bytes, 2) > SOURCE_PAGE_MAX_BYTES
  ) {
    throw new Error(
      `Transcript history page exceeds the ${SOURCE_PAGE_MAX_BYTES}-byte limit; request a smaller limit`,
    );
  }
  if (maxBytes !== undefined) {
    const limit = Math.min(SOURCE_PAGE_MAX_BYTES, Math.max(1_024, Math.floor(maxBytes)));
    let bytes = 2;
    let selectedStart = ranged.length;
    while (selectedStart > 0) {
      const nextBytes = ranged[selectedStart - 1]!.serialized_bytes;
      if (bytes + nextBytes > limit) {
        break;
      }
      bytes += nextBytes;
      selectedStart--;
    }
    selected = ranged.slice(selectedStart);
  }
  if (selected.length === 0) {
    return [];
  }
  const payloads = executeSqliteQuerySync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("transcript_events")
      .select(["seq", ...transcriptPayloadColumns(projection.database.db)])
      .where("session_id", "=", projection.resolved.sessionId)
      .where(
        "seq",
        "in",
        selected.map((row) => row.event_seq),
      ),
  ).rows;
  const payloadBySeq = new Map(
    payloads.map((row) => [row.seq, readSelectedTranscriptPayload(projection.database.db, row)]),
  );
  return positionTranscriptDisplayEvents(
    projection,
    displaySource,
    selected.flatMap((row) => {
      const eventJson = payloadBySeq.get(row.event_seq);
      return eventJson === undefined
        ? []
        : [
            {
              event: parseStoredTranscriptEvent(eventJson),
              eventSeq: row.event_seq,
              seq: row.displaySeq,
            },
          ];
    }),
  );
}

function resolveClosedResetIntervalForDisplayable(
  projection: CurrentTranscriptProjection,
  row: { active_position: number; event_type: string | null },
): ClosedResetInterval | undefined {
  if (typeof row.event_type !== "string") {
    return undefined;
  }
  return resolveClosedResetInterval(projection, {
    activePosition: row.active_position,
    eventType: row.event_type,
  });
}

export function resolveHistoricalHistoryEvent(
  projection: CurrentTranscriptProjection,
  row: NonNullable<ReturnType<typeof readDisplayableActiveEventById>>,
): SessionTranscriptMessageEvent | undefined {
  const interval = resolveClosedResetIntervalForDisplayable(projection, row);
  if (!interval) {
    return undefined;
  }
  return {
    event: parseStoredTranscriptEvent(row.event_json),
    eventSeq: row.event_seq,
    seq: countHistoricalDisplayEvents(projection, interval, row.active_position) + 1,
  };
}

export function readHistoricalHistoryPrecedingEvent(
  projection: CurrentTranscriptProjection,
  row: NonNullable<ReturnType<typeof readDisplayableActiveEventById>>,
  event: SessionTranscriptMessageEvent,
): SessionTranscriptMessageEvent | undefined {
  const interval = resolveClosedResetIntervalForDisplayable(projection, row);
  return interval && event.seq > 1
    ? readHistoricalDisplayEventRange(projection, undefined, interval, event.seq - 2, 1, {
        activePosition: row.active_position,
        displayPosition: event.seq - 1,
      })[0]
    : undefined;
}

export function readHistoricalHistoryAnchorPage(
  projection: CurrentTranscriptProjection,
  displaySource: string | undefined,
  row: { active_position: number; event_type: string | null },
  options: TranscriptAnchorPageOptions,
  excludeClosingReset = false,
): SessionTranscriptMessageAnchorPage | undefined {
  const interval = resolveClosedResetIntervalForDisplayable(projection, row);
  if (!interval) {
    return undefined;
  }
  const counts = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    selectHistoricalDisplayEvents(projection, interval).select((eb) => [
      eb.fn.countAll<number>().as("total"),
      eb.fn.min(historyNavigationValidSql).as("navigation_valid"),
      eb.fn
        .countAll<number>()
        .filterWhere("active.active_position", "<", row.active_position)
        .as("before_anchor"),
    ]),
  );
  assertTranscriptNavigationValid(counts?.navigation_valid ?? undefined);
  const anchorPosition = counts?.before_anchor ?? 0;
  const total = excludeClosingReset ? anchorPosition : (counts?.total ?? 0);
  const range = resolveHistoryAnchorPageRange(
    total,
    excludeClosingReset ? total - 1 : anchorPosition,
    options,
  );
  return {
    events: readHistoricalDisplayEventRange(
      projection,
      displaySource,
      interval,
      range.readStart,
      range.endExclusive - range.readStart,
      { activePosition: row.active_position, displayPosition: anchorPosition },
      options.maxBytes,
    ),
    found: true,
    hasOverreadContext: range.hasOverreadContext,
    offset: range.offset,
    displaySource,
    totalMessages: total,
  };
}
