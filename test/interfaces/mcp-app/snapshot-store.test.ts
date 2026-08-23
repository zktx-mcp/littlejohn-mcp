import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  parseUtcTimestamp,
  type CanonicalJson,
} from "../../../src/core/index.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import { presentationSnapshotLimits } from "../../../src/runtime/presentation-snapshot.js";
import { stockTokenTradeHistoryApplicationContract } from
  "../../../src/stock-token-trade-history/contracts.js";
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

describe("presentation snapshot store", () => {
  it("reloads the exact admitted Stock Token source siblings without a market read port", async () => {
    const opened = await openDatabase();
    const input = stockTokenTradeHistoryApplicationContract.parseInput({
      symbol: "AAPL",
      window: "1d",
    });
    const result = stockTokenTradeHistoryApplicationContract.parsePublicSuccess(
      input,
      stockTokenTradeHistoryAvailableFixture(),
    );
    const canonicalResult = captureCanonicalJson(result);
    const committed = availableValue(opened.database.presentationSnapshotStore().commit({
      contractId: stockTokenTradeHistoryApplicationContract.capabilityId,
      contractVersion: stockTokenTradeHistoryApplicationContract.contractVersion,
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

    const oversized = captureCanonicalJson({
      payload: "x".repeat(presentationSnapshotLimits.resultBytes),
    });
    expect(store.prepare({
      contractId: "qualification.read",
      contractVersion: "1",
      normalizedInput: captureCanonicalJson({}),
      admittedResult: oversized,
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
});
