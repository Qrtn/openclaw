import { expectDefined } from "@openclaw/normalization-core";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { sql, type Expression } from "kysely";
import { beginEngineStoreReadSnapshot } from "../../infra/database-engine/adapters.js";
import { engineTextByteSliceSql } from "../../infra/database-engine/text-bytes.js";
import {
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { sqlitePrimaryResultCode } from "../../infra/sqlite-error-diagnostics.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { classifyOpenClawAgentDatabaseReadError } from "../../state/openclaw-agent-db-read-error.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { prepareTranscriptEventReadQuery } from "./session-accessor.sqlite-read.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { sessionHistoryCleanupError } from "./session-history-worker-errors.js";
import { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptHydrationChunk,
  SessionTranscriptHydrationWorkerResult,
} from "./session-transcript-worker.types.js";
import {
  MAX_COMPRESSED_EVENT_BYTES,
  readCompressedTranscriptPayloadBytes,
  readTranscriptStorageEncoding,
} from "./transcript-payload.js";

const SLICE_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const CHUNK_FRAMES = 128;
// Each buffered row carries one identity slice or small compressed blob, never both.
const PAGE_ROWS = CHUNK_BYTES / SLICE_BYTES;

/** One task owns its snapshot through every acknowledged frame and native cleanup. */
export async function streamSessionTranscriptHydration(
  request: Extract<SessionHistoryWorkerInput, { kind: "transcript-hydration" }>,
  channel: WorkerTaskChannel,
  control: WorkerTaskControl,
): Promise<Extract<SessionTranscriptHydrationWorkerResult, { kind: "full" }>> {
  return await control.runNativeSection(async () => {
    const opened = openOpenClawAgentDatabaseReadOnly(toDatabaseOptions(request.resolvedScope));
    if (!opened.found) {
      throw new SessionTranscriptStorageUnavailableError(opened.reason);
    }
    const { database } = opened;
    let snapshot: ReturnType<typeof beginEngineStoreReadSnapshot> | undefined;
    let outcome:
      | { value: Extract<SessionTranscriptHydrationWorkerResult, { kind: "full" }> }
      | { error: unknown };
    try {
      if (request.expectedIdentity) {
        assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
      }
      snapshot = beginEngineStoreReadSnapshot(database.db);
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...request.resolvedScope });
      const { version, coldArchive } = readTranscriptContextStateInTransaction(
        database,
        request.resolvedScope.sessionId,
      );
      if (coldArchive) {
        throw new SessionTranscriptColdError(request.resolvedScope.sessionId);
      }
      const encoding = readTranscriptStorageEncoding(database.db);
      const source = prepareTranscriptEventReadQuery(database, request.resolvedScope.sessionId, {
        ...request.target,
        beforeEventSeq: fence?.beforeRawSeq,
      }).$if(request.afterSeq !== undefined, (query) => query.where("seq", ">", request.afterSeq!));
      // kysely-allow-raw: This fixed column is the canonical identity payload, never a dynamic identifier.
      const identity = sql.ref<string | null>("event_json");
      const eventSlice = (offset: number | Expression<number>) =>
        engineTextByteSliceSql(database.db, identity, offset, SLICE_BYTES).as("data");
      const pageQuery = source
        .select([
          "seq",
          eventSlice(1),
          "event_utf8_bytes",
          // kysely-allow-raw: Admit small compressed bodies inline without exceeding the page byte bound.
          sql<Uint8Array | null>`CASE WHEN event_json IS NULL
            AND octet_length(event_zstd) BETWEEN 1 AND ${SLICE_BYTES}
            AND event_utf8_bytes BETWEEN 1 AND ${MAX_COMPRESSED_EVENT_BYTES}
            THEN event_zstd ELSE NULL END`.as("event_zstd"),
          // kysely-allow-raw: Only larger blobs require a separate bounded read; invalid small rows decode as rejected.
          sql<number | null>`octet_length(event_zstd)`.as("compressed_bytes"),
        ])
        .orderBy("seq", "asc")
        .limit(PAGE_ROWS);
      const readPage = prepareSqliteQuerySync<
        number,
        {
          seq: number;
          data: Uint8Array | null;
          event_utf8_bytes: number | null;
          event_zstd: Uint8Array | null;
          compressed_bytes: number | null;
        }
      >(database.db, (parameter) =>
        pageQuery.where(
          "seq",
          ">",
          parameter((seq) => seq),
        ),
      );
      const readPart = prepareSqliteQueryTakeFirstSync<
        { seq: number; offset: number },
        { data: Uint8Array | null }
      >(database.db, (parameter) =>
        source.select(eventSlice(parameter((value) => value.offset))).where(
          "seq",
          "=",
          parameter((value) => value.seq),
        ),
      );
      const readCompressed = prepareSqliteQueryTakeFirstSync<
        number,
        { event_zstd: Uint8Array | null; event_utf8_bytes: number | null }
      >(database.db, (parameter) =>
        source
          .select([
            "event_utf8_bytes",
            // kysely-allow-raw: Refuse oversized compressed data before the database bridge copies it.
            sql<Uint8Array | null>`CASE WHEN event_utf8_bytes BETWEEN 1 AND ${MAX_COMPRESSED_EVENT_BYTES}
              AND octet_length(event_zstd) BETWEEN 1 AND ${MAX_COMPRESSED_EVENT_BYTES}
              THEN event_zstd ELSE NULL END`.as("event_zstd"),
          ])
          .where(
            "seq",
            "=",
            parameter((seq) => seq),
          ),
      );
      let frames: SessionTranscriptHydrationChunk["frames"] = [];
      let bytes = 0;
      let eventCount = 0;
      const flush = async () => {
        if (frames.length === 0) {
          return;
        }
        const response = await channel.request({
          kind: "transcript-hydration-chunk",
          encoding,
          frames,
        } satisfies SessionTranscriptHydrationChunk);
        response.consumed();
        frames = [];
        bytes = 0;
        control.throwIfCancelled();
      };
      let afterSeq = request.afterSeq;
      for (;;) {
        control.throwIfCancelled();
        const page =
          afterSeq === undefined
            ? executeSqliteQuerySync(database.db, pageQuery).rows
            : readPage(afterSeq).rows;
        for (const row of page) {
          const compressed =
            row.data === null
              ? (row.compressed_bytes ?? 0) > SLICE_BYTES
                ? readCompressed(row.seq)
                : row
              : undefined;
          const decoded = compressed
            ? readCompressedTranscriptPayloadBytes(
                compressed.event_zstd,
                compressed.event_utf8_bytes,
              )
            : undefined;
          for (let offset = 1; ; offset += SLICE_BYTES) {
            control.throwIfCancelled();
            // The codec returns Buffer; every frame must own only its sliced bytes.
            const data =
              decoded !== undefined
                ? new Uint8Array(decoded.subarray(offset - 1, offset - 1 + SLICE_BYTES))
                : expectDefined(
                    offset === 1 ? row.data : readPart({ seq: row.seq, offset })?.data,
                    "transcript snapshot row",
                  );
            if (bytes + data.byteLength > CHUNK_BYTES) {
              await flush();
            }
            const endOfEvent = data.byteLength < SLICE_BYTES;
            frames.push({
              data,
              endOfEvent,
              ...(request.includeEventJson && endOfEvent ? { seq: row.seq } : {}),
            });
            bytes += data.byteLength;
            if (bytes >= CHUNK_BYTES || frames.length >= CHUNK_FRAMES) {
              await flush();
            }
            if (endOfEvent) {
              eventCount++;
              break;
            }
          }
        }
        if (page.length < PAGE_ROWS) {
          break;
        }
        afterSeq = page[page.length - 1]!.seq;
      }
      await flush();
      control.throwIfCancelled();
      outcome = { value: { kind: "full", version, eventCount } };
    } catch (error) {
      outcome = {
        error:
          sqlitePrimaryResultCode(error) === 1
            ? classifyOpenClawAgentDatabaseReadError(database.db, error)
            : error,
      };
    }
    try {
      try {
        snapshot?.close();
      } finally {
        database.close();
      }
    } catch (cleanupError) {
      throw "error" in outcome
        ? sessionHistoryCleanupError(outcome.error, cleanupError, "database close")
        : cleanupError;
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  });
}
