import { describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { installSqliteTempTrackingSchema } from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";
import type { SqliteTempTrackingSchema } from "./sqlite-temp-generation-schema.js";

describe("connection-local tracking installation", () => {
  const { openDatabase } = useSqliteSchemaTestFixture();

  it.each(["generation", "transcript-index"] as const)(
    "skips absent trigger drops and preserves %s writes after reinstall and rollback",
    (kind) => {
      const database = openDatabase("CREATE TABLE original (session_id TEXT, id INTEGER)");
      let generation = 0;
      database.function("changed", () => ++generation);
      const schema: SqliteTempTrackingSchema =
        kind === "generation"
          ? {
              kind,
              functionName: "changed",
              triggers: (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => ({
                name: `original_${operation.toLowerCase()}`,
                table: "original",
                operation,
                enabled: true,
              })),
            }
          : {
              kind,
              statusTable: "local_status",
              pendingTable: "local_pending",
              pendingIndex: "local_pending_state",
              observedTables: ["original"],
            };
      const observed = observeHostDataSql();
      try {
        installSqliteTempTrackingSchema(database, schema);
        expect(observed.queries.filter((sql) => /\bDROP TRIGGER\b/iu.test(sql))).toEqual([]);
      } finally {
        observed.restore();
      }
      const expectPending = (ids: string[]) => {
        expect(
          database.prepare("SELECT session_id FROM temp.local_pending ORDER BY session_id").all(),
        ).toEqual(ids.map((session_id) => ({ session_id })));
      };
      database.exec("INSERT INTO original VALUES ('first', 1)");
      if (kind === "generation") {
        expect(generation).toBe(1);
      } else {
        expectPending(["first"]);
        database.exec("DELETE FROM temp.local_pending");
      }

      installSqliteTempTrackingSchema(database, schema);
      database.exec("BEGIN; UPDATE original SET session_id = 'rolled-back'; ROLLBACK");
      if (kind === "transcript-index") {
        expectPending([]);
      }
      const before = generation;
      database.exec("UPDATE original SET session_id = 'second'");
      if (kind === "generation") {
        expect(generation).toBe(before + 1);
      } else {
        expectPending(["first", "second"]);
      }
      database.exec("BEGIN");
      installSqliteTempTrackingSchema(database, schema);
      database.exec("ROLLBACK");
      installSqliteTempTrackingSchema(database, schema);
      const reinstalled = generation;
      database.exec("DELETE FROM original");
      if (kind === "generation") {
        expect(generation).toBe(reinstalled + 1);
      } else {
        expectPending(["first", "second"]);
      }
    },
  );
});
