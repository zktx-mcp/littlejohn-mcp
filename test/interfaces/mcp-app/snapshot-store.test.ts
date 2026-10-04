import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  getCapabilityDefinitionSnapshot,
  parseCapabilityInput,
  parseCapabilitySuccess,
  parseUtcTimestamp,
  type CanonicalJson,
} from "../../../src/core/index.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import { presentationSnapshotLimits, presentationSnapshotMetadataLimits } from "../../../src/runtime/presentation-snapshot.js";
import {admitPresentationSnapshotDescriptor, descriptorForPresentationSnapshot} from "../../../src/interfaces/mcp-app/contracts.js";
import {stockTokenTradeHistoryCapability} from "../../../src/stock-token-trade-history/contracts.js";
import { stockTokenTradeHistoryAvailableFixture } from
  "../stock-token-trade-history-fixture.js";

const openedAt = parseUtcTimestamp("2026-08-12T00:00:00.000Z");
const directories: string[] = [];
let productDatabase: ProductDatabase | undefined;

afterEach(async () => {
  productDatabase?.close();
  productDatabase = undefined;
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const openDatabase = async (): Promise<Readonly<{
  database: ProductDatabase;
  path: string;
}>> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-presentation-"));
  directories.push(directory);
  const path = resolve(directory, "runtime.sqlite3");
  productDatabase = await ProductDatabase.open(path, openedAt);
  return Object.freeze({ database: productDatabase, path });
};

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const canonicalResultAtBytes = (byteLength: number): CanonicalJson => {
  const emptyBytes = Buffer.byteLength('{"payload":""}', "utf8");
  const value = captureCanonicalJson({ payload: "x".repeat(byteLength - emptyBytes) });
  if (Buffer.byteLength(canonicalJsonStringify(value), "utf8") !== byteLength) {
    throw new TypeError("Snapshot boundary fixture is invalid.");
  }
  return value;
};

const expectedSnapshotId = (
  contractId: string,
  contractVersion: string,
  normalizedInput: CanonicalJson,
  admittedResult: CanonicalJson,
): string => {
  const input = Buffer.from(canonicalJsonStringify(normalizedInput), "utf8");
  const result = Buffer.from(canonicalJsonStringify(admittedResult), "utf8");
  return `sha256:${sha256([
    contractId,
    contractVersion,
    String(input.length),
    sha256(input),
    String(result.length),
    sha256(result),
  ].join("\0"))}`;
};

const availableValue = <Value>(
  result: Readonly<{ status: "available"; value: Value }> |
    Readonly<{ status: "unavailable"; reason: string }>,
): Value => {
  expect(result.status).toBe("available");
  if (result.status !== "available") throw new TypeError("Snapshot was unavailable.");
  return result.value;
};

// These fixtures independently encode real canonical pairs. Repeated large results
// share one Buffer and digest; no aggregate-sized JavaScript payload is retained.
const fixtureResult = (bytes: Buffer) => ({
  bytes,
  digest: sha256(bytes),
  chunks: JSON.stringify(Array.from({ length: Math.ceil(bytes.length / 262_144) }, (_, index) =>
    sha256(bytes.subarray(index * 262_144, (index + 1) * 262_144)))),
});
const seedSnapshot = (raw: Database.Database, id: number, result: ReturnType<typeof fixtureResult>) => {
  const input = Buffer.from(JSON.stringify({ id }));
  const inputDigest = sha256(input);
  const snapshotId = `sha256:${sha256([
    "qualification.read", "1", String(input.length), inputDigest,
    String(result.bytes.length), result.digest,
  ].join("\0"))}`;
  raw.prepare(`INSERT INTO presentation_snapshot VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(snapshotId, "qualification.read", "1", input, inputDigest,
      result.bytes, result.digest, result.chunks);
  return snapshotId;
};
const expectUnavailableStartup = async (path: string): Promise<void> => {
  let failure: unknown;
  try { (await ProductDatabase.open(path, openedAt)).close(); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ failure: { error: { code: "runtime_state_unavailable" } } });
};
const snapshotTotals = (raw: Database.Database) => raw.prepare(`SELECT count(*) AS rows,
  coalesce(sum(octet_length(input_bytes) + octet_length(result_bytes)), 0) AS bytes
  FROM presentation_snapshot`).get();
const snapshotKeys = (raw: Database.Database) => raw.prepare(`SELECT snapshot_id,
  input_digest, result_digest FROM presentation_snapshot ORDER BY snapshot_id`).all();
const smallCandidate = {
  contractId: "qualification.read",
  contractVersion: "1",
  normalizedInput: { id: "candidate" },
  admittedResult: {},
} as const;

describe("presentation snapshot store", () => {
  it("keeps the documented identity bytes and rejects independent descriptor substitutions", async () => {
    const { database } = await openDatabase();
    const input = captureCanonicalJson({ subject: "자산" });
    const result = captureCanonicalJson({ value: "évidence" });
    const record = availableValue(database.presentationSnapshotStore().commit({
      contractId: "qualification.자산", contractVersion: "2",
      normalizedInput: input, admittedResult: result,
    }));
    expect(record.snapshotId).toBe(expectedSnapshotId("qualification.자산", "2", input, result));
    const descriptor = descriptorForPresentationSnapshot(record);
    for (const change of [
      { contractId: "qualification.other" }, { contractVersion: "3" },
      { inputUtf8Bytes: descriptor.inputUtf8Bytes + 1 }, { inputSha256: "a".repeat(64) },
      { resultUtf8Bytes: descriptor.resultUtf8Bytes + 1 }, { resultSha256: "b".repeat(64) },
    ]) expect(() => admitPresentationSnapshotDescriptor({ ...descriptor, ...change }))
      .toThrow("descriptor identity");
  });
  it("reloads the exact admitted Stock Token source siblings without a market read port", async () => {
    const opened = await openDatabase();
    const input = parseCapabilityInput(stockTokenTradeHistoryCapability, {
      symbol: "AAPL",
      period: { count: 1, unit: "day" },
    });
    const result = parseCapabilitySuccess(
      stockTokenTradeHistoryCapability,
      input,
      stockTokenTradeHistoryAvailableFixture(),
    );
    const identity = getCapabilityDefinitionSnapshot(stockTokenTradeHistoryCapability);
    const canonicalResult = captureCanonicalJson(result);
    const committed = availableValue(opened.database.presentationSnapshotStore().commit({
      contractId: identity.capabilityId,
      contractVersion: identity.contractVersion,
      normalizedInput: captureCanonicalJson(input),
      admittedResult: canonicalResult,
    }));

    opened.database.close();
    productDatabase = await ProductDatabase.open(opened.path, openedAt);
    const reloaded = availableValue(productDatabase.presentationSnapshotStore().read(committed.snapshotId));
    expect(new TextDecoder("utf-8", { fatal: true }).decode(reloaded.resultBytes))
      .toBe(canonicalJsonStringify(canonicalResult));
    expect(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reloaded.resultBytes)))
      .toEqual(canonicalResult);
  });

  it("binds an exact admitted pair, reuses it, and reads the same identities after restart", async () => {
    const opened = await openDatabase();
    const store = opened.database.presentationSnapshotStore();
    const normalizedInput = captureCanonicalJson({ subject: "alpha" });
    const firstResult = captureCanonicalJson({ value: "first" });
    const secondResult = captureCanonicalJson({ value: "second" });

    const first = availableValue(store.commit({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput,
      admittedResult: firstResult,
    }));
    expect(first.snapshotId).toBe(expectedSnapshotId(
      "qualification.read",
      "1",
      normalizedInput,
      firstResult,
    ));
    expect(availableValue(store.commit({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput,
      admittedResult: firstResult,
    }))).toEqual(first);

    const second = availableValue(store.commit({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput,
      admittedResult: secondResult,
    }));
    expect(second.snapshotId).not.toBe(first.snapshotId);

    const differentInput = availableValue(store.commit({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput: captureCanonicalJson({ subject: "beta" }),
      admittedResult: firstResult,
    }));
    expect(differentInput.snapshotId).not.toBe(first.snapshotId);

    opened.database.close();
    productDatabase = await ProductDatabase.open(opened.path, openedAt);
    const reopened = productDatabase.presentationSnapshotStore();
    expect(availableValue(reopened.read(first.snapshotId))).toEqual(first);
    expect(availableValue(reopened.read(second.snapshotId))).toEqual(second);
    expect(reopened.read(`sha256:${"0".repeat(64)}`)).toEqual({
      status: "unavailable",
      reason: "snapshot_missing",
    });
    expect(reopened.read("latest")).toEqual({
      status: "unavailable",
      reason: "snapshot_inconsistent",
    });
  });

  it("slices canonical UTF-8 bytes without treating a multibyte boundary as text", async () => {
    const { database } = await openDatabase();
    const store = database.presentationSnapshotStore();
    const prefixBytes = Buffer.byteLength('{"payload":"', "utf8");
    const admittedResult = captureCanonicalJson({
      payload: `${"a".repeat(presentationSnapshotLimits.resultChunkBytes - 1 - prefixBytes)}€tail`,
    });
    const committed = availableValue(store.commit({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput: captureCanonicalJson({ subject: "multibyte" }),
      admittedResult,
    }));
    const canonical = Buffer.from(canonicalJsonStringify(admittedResult), "utf8");
    expect(canonical.subarray(presentationSnapshotLimits.resultChunkBytes - 1,
      presentationSnapshotLimits.resultChunkBytes + 2)).toEqual(Buffer.from("€", "utf8"));

    const chunks: Uint8Array[] = [];
    const count = Math.ceil(canonical.length / presentationSnapshotLimits.resultChunkBytes);
    for (let index = 0; index < count; index += 1) {
      chunks.push(availableValue(store.readResultChunk({ snapshotId: committed.snapshotId, index })).bytes);
    }
    const reconstructed = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    expect(reconstructed).toEqual(canonical);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(reconstructed))
      .toBe(canonicalJsonStringify(admittedResult));
    expect(store.readResultChunk({ snapshotId: committed.snapshotId, index: count })).toEqual({
      status: "unavailable",
      reason: "snapshot_inconsistent",
    });

  });

  it("admits the literal complete result boundary and rejects one byte over", async () => {
    const { database } = await openDatabase();
    const store = database.presentationSnapshotStore();
    const exact = canonicalResultAtBytes(8_388_607);
    const over = canonicalResultAtBytes(8_388_608);
    expect(presentationSnapshotLimits.resultBytes).toBe(8_388_607);
    expect(store.prepare({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput: captureCanonicalJson({ subject: "exact" }),
      admittedResult: exact,
    }).status).toBe("available");
    expect(store.prepare({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput: captureCanonicalJson({ subject: "over" }),
      admittedResult: over,
    })).toEqual({ status: "unavailable", reason: "capacity_exceeded" });
  });

  it("isolates one corrupt cached pair without invalidating an unrelated snapshot", async () => {
    const opened = await openDatabase();
    const store = opened.database.presentationSnapshotStore();
    const first = availableValue(store.commit({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput: captureCanonicalJson({ subject: "first" }),
      admittedResult: captureCanonicalJson({ value: "first" }),
    }));
    const second = availableValue(store.commit({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput: captureCanonicalJson({ subject: "second" }),
      admittedResult: captureCanonicalJson({ value: "second" }),
    }));
    opened.database.close();
    productDatabase = undefined;

    const raw = new Database(opened.path);
    raw.prepare("UPDATE presentation_snapshot SET result_bytes = ? WHERE snapshot_id = ?")
      .run(Buffer.from('{"value":"corrupt"}', "utf8"), first.snapshotId);
    raw.close();

    productDatabase = await ProductDatabase.open(opened.path, openedAt);
    const reopened = productDatabase.presentationSnapshotStore();
    expect(reopened.read(first.snapshotId)).toEqual({
      status: "unavailable",
      reason: "snapshot_inconsistent",
    });
    expect(availableValue(reopened.read(second.snapshotId))).toEqual(second);
  });

  it("rejects a same-length corrupt result before returning one of its chunks", async () => {
    const opened = await openDatabase();
    const store = opened.database.presentationSnapshotStore();
    const snapshot = availableValue(store.commit({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput: captureCanonicalJson({ subject: "chunk" }),
      admittedResult: captureCanonicalJson({ value: "first" }),
    }));
    opened.database.close();
    productDatabase = undefined;

    const raw = new Database(opened.path);
    raw.prepare("UPDATE presentation_snapshot SET result_bytes = ? WHERE snapshot_id = ?")
      .run(Buffer.from('{"value":"third"}', "utf8"), snapshot.snapshotId);
    raw.close();

    productDatabase = await ProductDatabase.open(opened.path, openedAt);
    expect(productDatabase.presentationSnapshotStore().readResultChunk({
      snapshotId: snapshot.snapshotId,
      index: 0,
    })).toEqual({ status: "unavailable", reason: "snapshot_inconsistent" });
  });
  it("admits exact input bytes and rejects one extra byte before prepare or commit effects", async () => {
    const { database, path } = await openDatabase();
    const store = database.presentationSnapshotStore();
    const exact = { ...smallCandidate, normalizedInput: canonicalResultAtBytes(65_536) };
    const over = { ...smallCandidate, normalizedInput: canonicalResultAtBytes(65_537) };
    expect(presentationSnapshotLimits.inputBytes).toBe(65_536);
    expect(store.prepare(exact).status).toBe("available");
    const committed = availableValue(store.commit(exact));
    expect(availableValue(store.read(committed.snapshotId))).toEqual(committed);
    const raw = new Database(path);
    try {
      const before = snapshotKeys(raw);
      expect(store.prepare(over)).toEqual({ status: "unavailable", reason: "capacity_exceeded" });
      expect(store.commit(over)).toEqual({ status: "unavailable", reason: "capacity_exceeded" });
      expect(snapshotKeys(raw)).toEqual(before);
    } finally { raw.close(); }
  });

  it("enforces retained row capacity at startup and commit while reusing an exact full-store pair", async () => {
    const { database, path } = await openDatabase();
    expect(presentationSnapshotLimits.rows).toBe(16_384);
    const raw = new Database(path);
    try {
      const result = fixtureResult(Buffer.from("{}"));
      raw.transaction(() => {
        for (let id = 0; id < 16_383; id += 1) seedSnapshot(raw, id, result);
      })();
      const store = database.presentationSnapshotStore();
      const last = { ...smallCandidate, normalizedInput: { id: 16_383 } };
      const committed = availableValue(store.commit(last));
      expect(snapshotTotals(raw)).toEqual({ rows: 16_384, bytes: 218_266 });
      const before = snapshotKeys(raw);
      expect(availableValue(store.commit(last))).toEqual(committed);
      expect(store.commit(smallCandidate)).toEqual({ status: "unavailable", reason: "capacity_exceeded" });
      expect(snapshotKeys(raw)).toEqual(before);
      database.close();
      productDatabase = await ProductDatabase.open(path, openedAt);
      expect(availableValue(productDatabase.presentationSnapshotStore().read(committed.snapshotId)))
        .toEqual(committed);
      productDatabase.close();
      productDatabase = undefined;
      seedSnapshot(raw, 16_384, result);
      await expectUnavailableStartup(path);
    } finally { raw.close(); }
  });

  // This real near-512-MiB fixture exceeded Vitest's 5-second default in full runs
  // (up to 5.56 seconds). A 30-second budget gives fixture headroom, not a product deadline.
  it("enforces aggregate input-plus-result capacity at startup and atomic new commit", async () => {
    const { database, path } = await openDatabase();
    expect(presentationSnapshotLimits.aggregateBytes).toBe(536_870_912);
    const raw = new Database(path);
    try {
      const common = fixtureResult(Buffer.from(`"${" ".repeat(8_388_605)}"`));
      const tail = (bytes: number) => fixtureResult(Buffer.from(`"${" ".repeat(bytes - 2)}"`));
      raw.transaction(() => {
        for (let id = 0; id < 63; id += 1) seedSnapshot(raw, id, common);
        seedSnapshot(raw, 63, tail(8_388_085));
      })();
      expect(snapshotTotals(raw)).toEqual({ rows: 64, bytes: 536_870_892 });
      const store = database.presentationSnapshotStore();
      const candidate = availableValue(store.commit(smallCandidate));
      expect(snapshotTotals(raw)).toEqual({ rows: 65, bytes: 536_870_912 });
      expect(availableValue(store.commit(smallCandidate))).toEqual(candidate);
      database.close();
      productDatabase = await ProductDatabase.open(path, openedAt);
      expect(availableValue(productDatabase.presentationSnapshotStore().read(candidate.snapshotId)))
        .toEqual(candidate);
      raw.prepare("DELETE FROM presentation_snapshot WHERE snapshot_id = ?").run(candidate.snapshotId);
      raw.prepare("DELETE FROM presentation_snapshot WHERE input_bytes = ?").run(Buffer.from('{"id":63}'));
      seedSnapshot(raw, 63, tail(8_388_086));
      expect(snapshotTotals(raw)).toEqual({ rows: 64, bytes: 536_870_893 });
      const before = snapshotKeys(raw);
      expect(productDatabase.presentationSnapshotStore().commit(smallCandidate))
        .toEqual({ status: "unavailable", reason: "capacity_exceeded" });
      expect(snapshotKeys(raw)).toEqual(before);
      expect(snapshotTotals(raw)).toEqual({ rows: 64, bytes: 536_870_893 });
      productDatabase.close();
      productDatabase = undefined;
      raw.prepare("DELETE FROM presentation_snapshot WHERE input_bytes = ?").run(Buffer.from('{"id":63}'));
      seedSnapshot(raw, 63, tail(8_388_106));
      expect(snapshotTotals(raw)).toEqual({ rows: 64, bytes: 536_870_913 });
      await expectUnavailableStartup(path);
    } finally { raw.close(); }
  }, 30_000);

  it("preserves complete metadata at its carrier bound and refuses oversized or malformed identities before writing", async () => {
    const { database, path } = await openDatabase();
    const store = database.presentationSnapshotStore();
    expect(presentationSnapshotMetadataLimits.contractIdentityBytes).toBe(65_536);
    const raw = new Database(path);
    try {
      for (const field of ["contractId", "contractVersion"] as const) {
        const exact = { ...smallCandidate, [field]: "1".repeat(65_536) };
        const committed = availableValue(store.commit(exact));
        expect(availableValue(store.read(committed.snapshotId))).toEqual(committed);
        const before = snapshotKeys(raw);
        const over = { ...smallCandidate, [field]: "1".repeat(65_537) };
        expect(store.prepare(over)).toEqual({ status: "unavailable", reason: "capacity_exceeded" });
        expect(store.commit(over)).toEqual({ status: "unavailable", reason: "capacity_exceeded" });
        expect(snapshotKeys(raw)).toEqual(before);
      }
      expect(store.commit({ ...smallCandidate, contractId: "bad\ud800" }))
        .toEqual({ status: "unavailable", reason: "snapshot_inconsistent" });
    } finally { raw.close(); }
  });

  it("withholds oversized snapshot scalars in the actual SQL read and keeps corruption local", async () => {
    const { database, path } = await openDatabase();
    const store = database.presentationSnapshotStore();
    const first = availableValue(store.commit(smallCandidate));
    const other = availableValue(store.commit({ ...smallCandidate, normalizedInput: { id: "other" } }));
    const statements = new Set<string>();
    const original = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database, sql: string,
    ) {
      if (sql.includes("FROM presentation_snapshot WHERE snapshot_id = ?")) statements.add(sql);
      return original.call(this, sql);
    });
    store.read(first.snapshotId);
    store.readResultChunk({ snapshotId: first.snapshotId, index: 0 });
    spy.mockRestore();
    expect(statements.size).toBe(2);
    const raw = new Database(path);
    try {
      raw.pragma("ignore_check_constraints = ON");
      raw.prepare(`UPDATE presentation_snapshot SET contract_id = ?, result_bytes = ? WHERE snapshot_id = ?`)
        .run("é".repeat(32_769), Buffer.alloc(8_388_608, 32), first.snapshotId);
      for (const sql of statements) {
        const chunk = sql.includes("AS chunkBytes");
        const row = raw.prepare(sql).get(...(chunk ? [1, 262_144, first.snapshotId] : [first.snapshotId])) as Record<string, unknown>;
        expect(row["contractIdByteLength"]).toBe(65_538);
        expect(row["contractId"]).toBeNull();
        expect(row[chunk ? "chunkBytes" : "resultBytes"]).toBeNull();
        const ungated = sql.replace(/CASE WHEN typeof\(contract_id\).*?END AS contractId/su,
          "CAST(contract_id AS BLOB) AS contractId");
        expect(ungated).not.toBe(sql);
        const exposed = raw.prepare(ungated).get(...(chunk ? [1, 262_144, first.snapshotId] : [first.snapshotId])) as Record<string, unknown>;
        expect((exposed["contractId"] as Buffer).length).toBe(65_538);
      }
      database.close();
      productDatabase = await ProductDatabase.open(path, openedAt);
      const reopened = productDatabase.presentationSnapshotStore();
      expect(reopened.read(first.snapshotId)).toEqual({ status: "unavailable", reason: "snapshot_inconsistent" });
      expect(reopened.readResultChunk({ snapshotId: first.snapshotId, index: 0 }))
        .toEqual({ status: "unavailable", reason: "snapshot_inconsistent" });
      expect(availableValue(reopened.read(other.snapshotId))).toEqual(other);
    } finally { raw.close(); }
  });

  it("rejects a stored BOM without normalizing a noncanonical pair into a valid replay", async () => {
    const { database, path } = await openDatabase();
    const raw = new Database(path);
    try {
      const id = seedSnapshot(raw, 77, fixtureResult(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])));
      expect(database.presentationSnapshotStore().read(id))
        .toEqual({ status: "unavailable", reason: "snapshot_inconsistent" });
    } finally { raw.close(); }
  });

});
