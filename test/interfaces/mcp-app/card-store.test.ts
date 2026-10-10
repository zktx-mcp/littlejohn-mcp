import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUtcTimestamp, canonicalJsonStringify, captureCanonicalJson } from "../../../src/core/index.js";
import {createOwnerInstanceId} from "../../../src/runtime/runtime-identity.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import { admitCardRecord, cardErrorDefinitions, cardOutcomeSchema, presentationCardLimits, cardActionResponseLimitBytes, admitCardActionDelivery,
  serializeCardActionPresentation, admitCardActionPresentation, type CardPresentation } from "../../../src/interfaces/mcp-app/card-contract.js";

const closures: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closures.splice(0).reverse()) await close(); });
const id = (value: number) => { const bytes = Buffer.alloc(32); bytes.writeUInt32BE(value); return bytes.toString("base64url"); };
const record = (index = 1, cardId = id(index)) => { const value = admitCardRecord({
  cardId, kind: "signing", contractVersion: "1", operationId: id(index + 100_000), resultDigest: "a".repeat(64),
  snapshotId: null, inputState: "input_pending", closeReason: null, dispatchId: null,
  context: { account: { chainId: "eip155:4663", address: `0x${"11".repeat(20)}` }, method: "personal_sign" },
  expiresAt: "2026-09-11T00:05:00.000Z",  outcome: null,
}); if (value.kind !== "signing") throw new Error("Signing fixture required."); return value; };
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "littlejohn-card-store-"));
  const path = join(root, "product.sqlite3");
  const database = await ProductDatabase.open(path, parseUtcTimestamp("2026-09-11T00:00:00.000Z"));
  database.ownerStore().publishOwner(createOwnerInstanceId(), Buffer.alloc(32, 7).toString("base64url"), parseUtcTimestamp("2026-09-11T00:00:00.000Z"));
  closures.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const store = database.presentationCardStore();
  const create = (index = 1) => {
    const reserved = store.beginCreation("signing", {index}, null);
    if (reserved.status !== "reserved") throw new Error("A fresh private decision must reserve a card.");
    const committed = store.commitCreation(reserved.reservation, record(index, reserved.cardId));
    if (committed.kind !== "signing") throw new Error("Signing card required.");
    return committed;
  };
  return { database, path, store, create };
};

it("admits every card-owned failure as a saved terminal classification", () => {
  for (const { code } of cardErrorDefinitions) {
    expect(cardOutcomeSchema.parse({ kind: "failure", failureCode: code })).toEqual({ kind: "failure", failureCode: code });
  }
});

describe("card SQLite ownership", () => {
  it("preserves component bounds and canonical nullable presentation in a paired action response", () => {
    const stored = { ...record(), inputState: "input_closed" as const, closeReason: "submitted" as const, dispatchId: id(9), outcome: { kind: "signing" as const, status: "verified" as const } };
    const presentation: CardPresentation = { state: { mode: "static", reference: { kind: "card", cardId: stored.cardId }, record: stored },
      display: { kind: "summary" }, actions: [] };
    const delivery = { result: "x".repeat(65_533), presentation };
    expect(cardActionResponseLimitBytes).toBe(2 * 65_535 + 10 + 1);
    expect(Buffer.byteLength(JSON.stringify(delivery) + "\n")).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(delivery) + "\n")).toBeLessThanOrEqual(131_081);
    expect(admitCardActionDelivery(delivery)).toEqual(delivery);
    expect(() => admitCardActionDelivery({ ...delivery, result: `${delivery.result}x` })).toThrow("response bounds");
    const text = serializeCardActionPresentation(presentation);
    expect(JSON.parse(text)).toEqual(presentation);
    expect(admitCardActionPresentation(text)).toEqual(presentation);
    expect(() => admitCardActionPresentation(` ${text}`)).toThrow("not canonical");
    expect(() => admitCardActionPresentation(presentation)).toThrow("canonical JSON text");
  });
  it("closes one exact pending predecessor and preserves its closed input on restart", async () => {
    const test = await setup(); const first = test.create();
    const admission = test.store.prepareDecision(first, id(7));
    const closed = test.store.commitDecision(admission, {kind: "signing", operationId: first.operationId, resultDigest: first.resultDigest},
      {kind: "signing", status: "verified"});
    expect(closed).toMatchObject({inputState: "input_closed", closeReason: "submitted", dispatchId: id(7)});
    expect(() => test.store.replace(first, {...first, inputState: "input_closed", closeReason: "discarded"})).toThrow();
    expect(() => test.store.replace(closed, first)).toThrow();
    expect(() => test.store.prepareDecision(closed, id(8))).toThrow();
    test.database.close();
    const reopened = await ProductDatabase.open(test.path, parseUtcTimestamp("2026-09-11T00:00:01.000Z"));
    try { expect(reopened.presentationCardStore().read(first.cardId)).toEqual(closed); }
    finally { reopened.close(); }
  });

  it("enforces the accepted 16,384-record capacity without eviction or resetting an existing decision", async () => {
    const test = await setup(); const raw = new Database(test.path);
    try {
      const insert = raw.prepare("INSERT INTO presentation_card(card_id,owner_generation,kind,operation_id,record_json) VALUES (?,?,?,?,?)");
      raw.transaction(() => {
        for (let index = 1; index < 16_384; index++) {
          const value = record(index);
          insert.run(value.cardId, test.database.ownerStore().readOwner()!.ownerInstanceId, value.kind, value.operationId, canonicalJsonStringify(captureCanonicalJson(value)));
        }
      })();
      const final = test.create(16_384);
      expect(test.store.read(final.cardId)).toEqual(final);
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_card").get()).toEqual({ count: 16_384 });
      expect(() => test.store.beginCreation("signing", {index: 16_385}, null)).toThrow("Card storage capacity is exhausted");
      expect(test.store.read(id(1))).toEqual(record(1));
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_card").get()).toEqual({ count: 16_384 });
    } finally { raw.close(); }
  });

  it("rejects oversized stored bytes before JSON decoding and rejects index/body disagreement", async () => {
    const test = await setup(); const first = test.create();
    const raw = new Database(test.path);
    try {
      const excess = JSON.stringify({ ...first, unexpected: "x".repeat(presentationCardLimits.recordBytes) });
      raw.pragma("ignore_check_constraints = ON");
      raw.prepare("UPDATE presentation_card SET record_json=? WHERE card_id=?").run(excess, first.cardId);
      const parse = vi.spyOn(JSON, "parse");
      expect(() => test.store.read(first.cardId)).toThrow();
      expect(parse.mock.calls.some(([text]) => text === excess)).toBe(false);
      parse.mockRestore();
      const other = { ...first, cardId: id(99) };
      raw.prepare("UPDATE presentation_card SET record_json=? WHERE card_id=?").run(canonicalJsonStringify(captureCanonicalJson(other)), first.cardId);
      expect(() => test.store.read(first.cardId)).toThrow();
      test.database.close();
      await expect(ProductDatabase.open(test.path, parseUtcTimestamp("2026-09-11T00:00:01.000Z"))).rejects.toThrow();
    } finally { raw.close(); }
  });
});
