import path from "node:path";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import * as readonlyStore from "../../state/openclaw-agent-db-readonly.js";
import { streamSessionTranscriptHydration } from "./session-transcript-hydration.worker.js";
import type { SessionTranscriptHydrationChunk } from "./session-transcript-worker.types.js";
import * as payload from "./transcript-payload.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture(
  rows: Array<{ seq: number; text?: string; compressed?: Uint8Array; size?: number }>,
) {
  const pathname = path.join(tempDirs.make("hydration-pages-"), "transcript.sqlite");
  const writer = openNodeSqliteDatabase(pathname);
  // Minimal physical schema deliberately permits corrupt records and unusual sequence values.
  writer.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT,
      event_zstd BLOB, event_utf8_bytes INTEGER, PRIMARY KEY(session_id, seq));
    CREATE TABLE session_transcript_cold_archives (session_id TEXT, last_seq INTEGER);
    CREATE TABLE transcript_rewrite_watermarks (session_id TEXT, generation TEXT);
    CREATE TABLE session_windows (session_id TEXT, transcript_updated_at INTEGER);
    INSERT INTO transcript_rewrite_watermarks VALUES ('fixture', 'original');
    INSERT INTO session_windows VALUES ('fixture', 7);`);
  const insert = writer.prepare("INSERT INTO transcript_events VALUES ('fixture', ?, ?, ?, ?)");
  for (const row of rows) {
    insert.run(row.seq, row.text ?? null, row.compressed ?? null, row.size ?? null);
  }
  const reader = openNodeSqliteDatabase(pathname, { readOnly: true });
  admitSqliteSchema(reader);
  vi.spyOn(readonlyStore, "openOpenClawAgentDatabaseReadOnly").mockReturnValue({
    found: true,
    database: { agentId: "main", path: pathname, db: reader, close: () => reader.close() },
  });
  const controller = new AbortController();
  const control: WorkerTaskControl = {
    runNativeSection: async (operation) => operation(),
    throwIfCancelled: () => controller.signal.throwIfAborted(),
  };
  const chunks: SessionTranscriptHydrationChunk[] = [];
  const channel = (
    onChunk?: (chunk: SessionTranscriptHydrationChunk) => Promise<void>,
  ): WorkerTaskChannel => ({
    consumeInput() {},
    notify() {},
    async request(value) {
      const chunk = value as SessionTranscriptHydrationChunk;
      chunks.push(chunk);
      await onChunk?.(chunk);
      return { input: undefined, consumed() {} };
    },
  });
  const stream = (
    onChunk?: (chunk: SessionTranscriptHydrationChunk) => Promise<void>,
    afterSeq?: number,
  ) =>
    streamSessionTranscriptHydration(
      {
        kind: "transcript-hydration",
        database: { agentId: "main", path: pathname },
        resolvedScope: { agentId: "main", sessionId: "fixture", path: pathname },
        target: { sessionId: "fixture" },
        includeEventJson: true,
        afterSeq,
      },
      channel(onChunk),
      control,
    );
  return { writer, reader, chunks, controller, stream };
}

it("keeps exact bytes and one snapshot across ACKs and keyset pages", async () => {
  const codec = resolveZstdCodec();
  expect(codec).toBeDefined();
  const texts = Array.from({ length: 34 }, (_, index) =>
    JSON.stringify({ type: "custom", id: String(index), data: "x".repeat(65500) }),
  );
  // Put a multibyte code point across a slice and an exact-multiple event at the next boundary.
  texts[0] = `${" ".repeat(65535)}"🦞"`;
  texts[1] = "{}".padEnd(2 * 65536, " ");
  texts[2] = "{}".padEnd(5 * 1024 * 1024, " ");
  texts[17] = "{}".padEnd(1024 * 1024, " ");
  const f = fixture(
    texts.map((text, seq) =>
      seq === 17
        ? {
            seq,
            compressed: codec!.compress(Buffer.from(text), 1, true),
            size: Buffer.byteLength(text),
          }
        : { seq: seq === 0 ? -2 : seq, text },
    ),
  );
  const decode = vi.spyOn(payload, "readCompressedTranscriptPayloadBytes");
  let acknowledgements = 0;
  try {
    const result = await f.stream(async () => {
      expect(f.reader.isTransaction).toBe(true);
      if (acknowledgements++ === 0) {
        f.writer
          .prepare("UPDATE transcript_events SET event_json = 'changed' WHERE seq = 20")
          .run();
        f.writer
          .prepare("INSERT INTO transcript_events VALUES ('fixture', 100, 'new', NULL, NULL)")
          .run();
      }
      await Promise.resolve();
    });
    expect(result).toEqual({
      kind: "full",
      eventCount: texts.length,
      version: { generation: "original", rawSeq: 33, updatedAt: 7 },
    });
    const events: string[] = [];
    const sequences: number[] = [];
    let parts: Uint8Array[] = [];
    for (const chunk of f.chunks) {
      expect(chunk.encoding).toBe("UTF-8");
      expect(chunk.frames.length).toBeLessThanOrEqual(128);
      expect(
        chunk.frames.reduce((sum, frame) => sum + frame.data.byteLength, 0),
      ).toBeLessThanOrEqual(1024 * 1024);
      for (const frame of chunk.frames) {
        expect(frame.data.byteLength).toBeLessThanOrEqual(65536);
        expect(frame.data.buffer.byteLength).toBe(frame.data.byteLength);
        parts.push(frame.data);
        if (frame.endOfEvent) {
          sequences.push(frame.seq!);
          events.push(Buffer.concat(parts).toString("utf8"));
          parts = [];
        }
      }
    }
    expect(events).toEqual(texts);
    expect(sequences).toEqual(texts.map((_, index) => (index === 0 ? -2 : index)));
    expect(
      f.chunks
        .flatMap((chunk) => chunk.frames)
        .filter((frame) => frame.endOfEvent && frame.data.byteLength === 0)
        .map((frame) => frame.seq),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 17]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(f.reader.isOpen).toBe(false);
  } finally {
    f.writer.close();
  }
});

it("reads small compressed bodies with their page and fetches only large compressed blobs", async () => {
  const codec = resolveZstdCodec()!;
  const noise = Buffer.alloc(256 * 1024);
  let seed = 1;
  for (let index = 0; index < noise.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    noise[index] = seed & 255;
  }
  const texts = [
    ...Array.from({ length: 16 }, (_, seq) =>
      JSON.stringify({ id: seq, data: "x".repeat(1536 + seq * 400) }),
    ),
    JSON.stringify({ id: 16, data: noise.toString("base64") }),
  ];
  const rows = texts.map((text, seq) => ({
    seq,
    compressed: codec.compress(Buffer.from(text), 1, true),
    size: Buffer.byteLength(text),
  }));
  expect(rows.slice(0, 16).every((row) => row.compressed.byteLength <= 65536)).toBe(true);
  expect(rows.at(-1)?.compressed.byteLength).toBeGreaterThan(65536);
  const f = fixture(rows);
  const reads = trackSqliteStatementExecutions(f.reader, ["payload"], (statement) =>
    /\bfrom "transcript_events"/i.test(statement) && !/max\(/i.test(statement) ? "payload" : null,
  );
  try {
    await expect(f.stream()).resolves.toMatchObject({ eventCount: texts.length });
    expect(reads.counts.payload).toBe(3);
    expect(
      Buffer.concat(f.chunks.flatMap((chunk) => chunk.frames.map((frame) => frame.data))),
    ).toEqual(Buffer.from(texts.join("")));
  } finally {
    reads.restore();
    f.writer.close();
  }
});

it.each(["cancel", "host-error"] as const)(
  "closes the snapshot after %s without reading the next payload page",
  async (failure) => {
    const f = fixture([
      ...Array.from({ length: 16 }, (_, seq) => ({ seq, text: "{}".padEnd(65536, " ") })),
      { seq: 16, compressed: new Uint8Array([0]), size: 1 },
    ]);
    const reads = trackSqliteStatementExecutions(f.reader, ["payload"], (statement) =>
      /\bfrom "transcript_events"/i.test(statement) && !/max\(/i.test(statement) ? "payload" : null,
    );
    const decode = vi.spyOn(payload, "readCompressedTranscriptPayloadBytes");
    const error = new Error(failure);
    try {
      await expect(
        f.stream(async () => {
          expect(reads.blobBytes.payload).toBe(1024 * 1024);
          if (failure === "cancel") {
            f.controller.abort(error);
          } else {
            throw error;
          }
        }),
      ).rejects.toBe(error);
      expect(decode).not.toHaveBeenCalled();
      expect(f.reader.isOpen).toBe(false);
    } finally {
      reads.restore();
      f.writer.close();
    }
  },
);

it("keeps empty identity events and applies the sequence fence before decoding", async () => {
  const f = fixture([
    { seq: 0, compressed: new Uint8Array([0]), size: 1 },
    { seq: 1, text: "" },
    { seq: 2, text: '{"id":"selected"}' },
  ]);
  try {
    await expect(f.stream(undefined, 0)).resolves.toMatchObject({ eventCount: 2 });
    const frames = f.chunks.flatMap((chunk) => chunk.frames);
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(frames[0]).toEqual({ data: new Uint8Array(), endOfEvent: true, seq: 1 });
  } finally {
    f.writer.close();
  }
});

it("rejects an oversized compressed row before materializing its bytes", async () => {
  const f = fixture([{ seq: 0, compressed: new Uint8Array(4 * 1024 * 1024 + 1), size: 1 }]);
  const reads = trackSqliteStatementExecutions(f.reader, ["payload"], (statement) =>
    /\bfrom "transcript_events"/i.test(statement) ? "payload" : null,
  );
  try {
    await expect(f.stream()).rejects.toThrow("Invalid compressed transcript payload bounds");
    expect(reads.blobBytes.payload).toBe(0);
    expect(f.chunks).toHaveLength(0);
    expect(f.reader.isOpen).toBe(false);
  } finally {
    reads.restore();
    f.writer.close();
  }
});
