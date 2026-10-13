import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { WorkboardCardReadScope } from "./persistence-types.js";
import { requiredString, stringValue, type WorkboardCardDatabase } from "./sqlite-store-records.js";
import type { WorkboardSqlConnection } from "./sqlite-store-schema.js";

const ASCII_KEY_CHARACTERS = Array.from({ length: 94 }, (_, index) =>
  String.fromCharCode(33 + index),
).join("");

function normalizeSessionLinkKey(value: string): string {
  const raw = value.trim();
  const parts = raw.split(":");
  let body = 0;
  while (parts.length - body >= 3 && parts[body]?.toLowerCase() === "agent") {
    parts[body] = "agent";
    parts[body + 1] = parts[body + 1]?.toLowerCase() ?? "";
    body += 2;
  }
  while (body < parts.length && !parts[body]?.trim()) {
    body++;
  }
  const channel = parts[body]?.toLowerCase();
  const kind = parts[body + 1]?.toLowerCase();
  // Catalog IDs are opaque too, but the shared routing parser predates them.
  if (channel === "catalog") {
    return parts.join(":");
  }
  return (channel === "matrix" && (kind === "channel" || kind === "group")) ||
    (channel === "signal" && kind === "group")
    ? (parseAgentSessionKey(`agent:main:${raw}`)?.rest ?? "")
    : raw.toLowerCase();
}

export function readSessionLinkedCardIds(
  db: WorkboardSqlConnection,
  scope: Extract<WorkboardCardReadScope, { kind: "session-links" }>,
): string[] {
  const query = getNodeSqliteKysely<WorkboardCardDatabase>(db);
  const key = normalizeSessionLinkKey(scope.sessionKey);
  const folded = key.toLowerCase();
  // SQLite lower() folds ASCII only. Keep unusual characters (including spaces)
  // as candidates for JavaScript normalization before loading any card payloads.
  const ascii = /^[\x20-\x7e]*$/.test(key);
  const selected = new Set<string>();
  let cards = query
    .selectFrom("workboard_cards")
    .select(["id", "session_key", "execution_id", "execution_session_key"]);
  if (ascii) {
    cards = cards.where((eb) =>
      eb.or(
        (["session_key", "execution_session_key"] as const).flatMap((column) => [
          eb(eb.fn<string>("lower", [eb.fn<string>("trim", [column])]), "=", folded),
          eb(eb.fn<string>("trim", [eb.ref(column), eb.val(ASCII_KEY_CHARACTERS)]), "!=", ""),
        ]),
      ),
    );
  }
  if (scope.boardId !== undefined) {
    cards = cards.where("board_id", "=", scope.boardId);
  }
  for (const row of iterateSqliteQuerySync(db, cards)) {
    const direct = stringValue(row, "session_key");
    const execution = stringValue(row, "execution_id")
      ? stringValue(row, "execution_session_key")
      : undefined;
    if (
      [direct, execution].some(
        (candidate) => candidate && normalizeSessionLinkKey(candidate) === key,
      )
    ) {
      selected.add(requiredString(row, "id"));
    }
  }
  for (const table of ["workboard_card_attempts", "workboard_card_events"] as const) {
    let links = query.selectFrom(table).select(["card_id", "session_key"]);
    if (ascii) {
      links = links.where((eb) =>
        eb.or([
          eb(eb.fn<string>("lower", [eb.fn<string>("trim", ["session_key"])]), "=", folded),
          eb(
            eb.fn<string>("trim", [eb.ref("session_key"), eb.val(ASCII_KEY_CHARACTERS)]),
            "!=",
            "",
          ),
        ]),
      );
    }
    if (scope.boardId !== undefined) {
      links = links.where(
        "card_id",
        "in",
        query.selectFrom("workboard_cards").select("id").where("board_id", "=", scope.boardId),
      );
    }
    for (const row of iterateSqliteQuerySync(db, links)) {
      const candidate = stringValue(row, "session_key");
      if (candidate && normalizeSessionLinkKey(candidate) === key) {
        selected.add(requiredString(row, "card_id"));
      }
    }
  }
  return [...selected];
}
