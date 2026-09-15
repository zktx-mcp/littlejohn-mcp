import type Database from "better-sqlite3";
import { canonicalJsonStringify, captureCanonicalJson, operationIdByteLength } from "../core/index.js";
import {
  admitCardRecord, isCardPhaseTransition, presentationCardLimits, cardKinds, type CardRecord, type PresentationCardStore, type ReadCardRecord,
} from "../interfaces/mcp-app/card-contract.js";
import type { PresentationSnapshotRecord, PresentationSnapshotResult } from "./presentation-snapshot.js";
import { createPresentationSnapshot } from "./presentation-snapshot-server.js";
import { CardError } from "../interfaces/mcp-app/card-errors.js";

const encoded = (record: CardRecord): string => canonicalJsonStringify(captureCanonicalJson(record));
const projection = `SELECT
  CASE WHEN octet_length(card_id) = ${Math.ceil(operationIdByteLength * 4 / 3)} THEN card_id END AS cardId,
  CASE WHEN octet_length(operation_id) = ${Math.ceil(operationIdByteLength * 4 / 3)} THEN operation_id END AS operationId,
  CASE WHEN kind IN (${cardKinds.map((kind) => `'${kind}'`).join(',')}) THEN kind END AS kind,
  CASE WHEN octet_length(record_json) BETWEEN 1 AND ${presentationCardLimits.recordBytes}
    THEN record_json END AS recordJson FROM presentation_card`;

const decode = (raw: unknown): CardRecord => {
  if (typeof raw !== "object" || raw === null || !("recordJson" in raw) || typeof raw.recordJson !== "string") {
    throw new CardError("runtime_state_unavailable");
  }
  let record: CardRecord;
  try { record = admitCardRecord(JSON.parse(raw.recordJson)); }
  catch { throw new CardError("runtime_state_unavailable"); }
  if (encoded(record) !== raw.recordJson || !("cardId" in raw) || raw.cardId !== record.cardId ||
      !("operationId" in raw) || raw.operationId !== (record.kind === "read" ? null : record.operationId) || !("kind" in raw) || raw.kind !== record.kind) {
    throw new CardError("runtime_state_unavailable");
  }
  return record;
};

export const validatePresentationCards = (database: Database.Database): void => {
  const capacity = database.prepare(`SELECT count(*) AS rows, coalesce(sum(octet_length(record_json)),0) AS bytes FROM presentation_card`).get() as { rows: number; bytes: number };
  if (!Number.isSafeInteger(capacity.rows) || !Number.isSafeInteger(capacity.bytes) || capacity.rows < 0 || capacity.bytes < 0 ||
      capacity.rows > presentationCardLimits.rows || capacity.bytes > presentationCardLimits.aggregateBytes) {
    throw new CardError("runtime_state_unavailable");
  }
  for (const row of database.prepare(`${projection} LIMIT ?`).iterate(presentationCardLimits.rows + 1)) decode(row);
};

interface Access {
  read<T>(operation: () => T): T;
  write<T>(operation: () => T): T;
}

export const createPresentationCardStore = (
  database: Database.Database, access: Access, snapshots: { insert(record: PresentationSnapshotRecord): PresentationSnapshotResult<PresentationSnapshotRecord> },
): PresentationCardStore => {
  const read = (where: string, values: readonly string[]): CardRecord | null => {
    const row = database.prepare(`${projection} WHERE ${where}`).get(...values);
    return row === undefined ? null : decode(row);
  };
  const same = (left: CardRecord, right: CardRecord): boolean => encoded(left) === encoded(right);
  const identity = (record: CardRecord): string => {
    if (record.kind === "read") return encoded({ ...record, phase: "pending", outcome: null });
    return encoded({ ...record, firstCardOpenRequestId: null, phase: "ready", outcome: null });
  };
  const writeReplacement = (expectedInput: CardRecord, nextInput: CardRecord): CardRecord => {
    const expected = admitCardRecord(expectedInput);
    const next = admitCardRecord(nextInput);
    if (identity(expected) !== identity(next) || !isCardPhaseTransition(expected.phase, next.phase) ||
        (expected.kind !== "read" && next.kind !== "read" && expected.firstCardOpenRequestId !== null &&
          next.firstCardOpenRequestId !== expected.firstCardOpenRequestId) ||
        (expected.phase === "closed" && !same(expected, next))) throw new CardError("presentation_inconsistent");
    const current = read("card_id = ?", [expected.cardId]);
      if (current === null || !same(current, expected)) throw new CardError("state_conflict");
      if (same(current, next)) return current;
      const result = database.prepare("UPDATE presentation_card SET record_json = ? WHERE card_id = ? AND record_json = ?")
        .run(encoded(next), expected.cardId, encoded(expected));
      if (result.changes !== 1) throw new CardError("state_conflict");
    return next;
  };
  const replace = (expected: CardRecord, next: CardRecord): CardRecord => access.write(() => writeReplacement(expected, next));
  return Object.freeze({
    unsettled() {
      return access.read(() => {
        const records: CardRecord[] = [];
        let count = 0;
        for (const row of database.prepare(`${projection} LIMIT ?`).iterate(presentationCardLimits.rows + 1)) {
          if (++count > presentationCardLimits.rows) throw new CardError("runtime_state_unavailable");
          const record = decode(row);
          if (record.phase !== "closed") records.push(record);
        }
        return records;
      });
    },
    read(cardId) { return access.read(() => read("card_id = ?", [cardId])); },
    find(kind, operationId) { return access.read(() => read("kind = ? AND operation_id = ?", [kind, operationId])); },
    insert(input) {
      const candidate = admitCardRecord(input);
      return access.write(() => {
        const existing = candidate.kind === "read" ? read("card_id = ?", [candidate.cardId])
          : read("kind = ? AND operation_id = ?", [candidate.kind, candidate.operationId]);
        if (existing !== null) {
          if (identity({ ...candidate, cardId: existing.cardId }) !== identity(existing)) throw new CardError("presentation_inconsistent");
          return existing;
        }
        const count = database.prepare("SELECT count(*) AS count FROM presentation_card").get() as { count: number };
        if (count.count >= presentationCardLimits.rows) throw new CardError("presentation_capacity_exceeded");
        database.prepare("INSERT INTO presentation_card(card_id, kind, operation_id, record_json) VALUES (?, ?, ?, ?)")
          .run(candidate.cardId, candidate.kind, candidate.kind === "read" ? null : candidate.operationId, encoded(candidate));
        return candidate;
      });
    },
    replace,
    completeRead(expected, input) {
      if (expected.phase !== "pending" || input.contractId !== expected.request.capabilityId ||
          input.contractVersion !== expected.contractVersion ||
          encodedValue(input.normalizedInput) !== encodedValue(expected.request.input)) throw new CardError("presentation_inconsistent");
      const prepared = createPresentationSnapshot(input);
      if (prepared.status === "unavailable") throw new CardError(prepared.reason === "capacity_exceeded" ? "presentation_capacity_exceeded" : "runtime_state_unavailable");
      return access.write(() => {
        const current = read("card_id = ?", [expected.cardId]);
        if (current === null || !same(current, expected)) throw new CardError("state_conflict");
        const committed = snapshots.insert(prepared.value);
        if (committed.status === "unavailable") throw new CardError(committed.reason === "capacity_exceeded"
          ? "presentation_capacity_exceeded" : "runtime_state_unavailable");
        // An exception in the conditional card write rolls back the snapshot too.
        return writeReplacement(expected, { ...expected, phase: "closed", outcome: { kind: "snapshot", snapshotId: committed.value.snapshotId } }) as ReadCardRecord;
      });
    },
  } satisfies PresentationCardStore);
};

const encodedValue = (value: unknown): string => canonicalJsonStringify(captureCanonicalJson(value));
