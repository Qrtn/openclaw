import path from "node:path";
import { expect, it, vi } from "vitest";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type {
  ReclamationDatabaseOptions,
  SessionMaintenanceReadCommand,
  SqliteSessionReclamationPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { readSessionMaintenanceInWorker } from "./session-accessor.sqlite-maintenance-transaction.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

it("reads warm maintenance without a transaction and observes newly committed capacity pressure", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const database = openOpenClawAgentDatabase(options);
    const write = (index: number) =>
      runOpenClawAgentWriteTransaction((writer) => {
        writeSessionEntry(writer, `agent:main:maintenance-${index}`, {
          sessionId: `maintenance-${index}`,
          updatedAt: Date.now(),
        });
      }, options);
    write(0);
    const plan = {
      kind: "maintenance-plan",
      databaseOptions: { ...options, path: database.path },
      expectedIdentity: readDatabasePathIdentitySync(database.path),
      input: {
        archiveDirectory: path.join(path.dirname(database.path), "archives"),
        storePath: database.path,
        maintenance: resolveMaintenanceConfigFromInput({
          mode: "enforce",
          maxEntries: 1,
          pruneAfter: "1d",
        }),
        preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] },
      },
    } satisfies SessionMaintenanceReadCommand & { databaseOptions: ReclamationDatabaseOptions };
    expect(readSessionMaintenanceInWorker(plan, database).kind).toBe("maintenance-plan");
    const exec = vi.spyOn(database.db, "exec");
    try {
      expect(readSessionMaintenanceInWorker(plan, database).kind).toBe("maintenance-plan");
      expect(exec.mock.calls).toEqual([]);
      write(1);
      exec.mockClear();
      expect(readSessionMaintenanceInWorker(plan, database)).toEqual({
        kind: "maintenance-write-required",
      });
    } finally {
      exec.mockRestore();
    }
  });
});

it.each(["durable", "warm durable", "runtime"] as const)(
  "resolves %s protected capacity with only the preservation facts it needs",
  async (protection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const keys = ["agent:main:capacity-protected-0", "agent:main:capacity-protected-1"] as const;
      const write = (indexes: Array<0 | 1>) =>
        runOpenClawAgentWriteTransaction((database) => {
          for (const index of indexes) {
            const key = keys[index];
            writeSessionEntry(database, key, {
              sessionId: `capacity-protected-${index}`,
              updatedAt: Date.now(),
              modelSelectionLocked: protection !== "runtime",
            });
          }
        }, options);
      write(protection === "warm durable" ? [0] : [0, 1]);
      const plan = {
        kind: "maintenance-plan",
        databaseOptions: resolveSessionReclamationDatabaseOptions(options),
        materializedPlans: [],
        input: {
          activeSessionKeys: protection === "runtime" ? keys : [],
          archiveDirectory: state.sessionsDir(),
          storePath: path.join(state.sessionsDir(), "sessions.json"),
          maintenance: resolveMaintenanceConfigFromInput({
            mode: "enforce",
            maxEntries: 1,
            pruneAfter: "1d",
          }),
          preservation: null,
        },
      } satisfies SqliteSessionReclamationPlan;
      if (protection === "warm durable") {
        await expect(runSqliteSessionReclamation({ plan })).resolves.toMatchObject({
          kind: "maintenance-plan",
          readOnlyInput: expect.any(Object),
          ageFact: { entryCount: 1 },
        });
        write([1]);
      }
      if (protection !== "runtime") {
        await expect(runSqliteSessionReclamation({ plan })).resolves.toMatchObject({
          kind: "maintenance-plan",
          readOnlyInput: expect.any(Object),
          value: { archived: 0, durableNoCandidates: true },
        });
      } else {
        await expect(runSqliteSessionReclamation({ plan })).resolves.toEqual({
          kind: "maintenance-preservation-required",
        });
        const result = await runSqliteSessionReclamation({
          plan: {
            ...plan,
            input: {
              ...plan.input,
              preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] },
            },
          },
        });
        expect(result.kind).toBe("maintenance-plan");
        if (result.kind === "maintenance-plan") {
          expect(result.value.archived).toBe(0);
          expect(result.value.durableNoCandidates).not.toBe(true);
        }
      }
    });
  },
);
