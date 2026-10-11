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
  const create = (index = 1, publicationKey: string | null = null) => {
    const reserved = store.beginCreation("signing", {index}, publicationKey);
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

  it("creates beyond the former retained-row quota without eviction or resetting an existing decision", async () => {
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
      const next = test.create(16_385);
      expect(test.store.read(next.cardId)).toEqual(next);
      expect(test.store.read(id(1))).toEqual(record(1));
      expect(test.store.read(final.cardId)).toEqual(final);
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_card").get()).toEqual({ count: 16_385 });
    } finally { raw.close(); }
  });

  it("rejects corrupt card reads, duplicate publication and decisions, including retained history after reopen", async () => {
    for (const corruption of ["oversized", "index"] as const) {
      const test = await setup(); const key = id(42); const first = test.create(1, key);
      const raw = new Database(test.path);
      const text = corruption === "oversized"
        ? JSON.stringify({ ...first, unexpected: "x".repeat(presentationCardLimits.recordBytes) })
        : canonicalJsonStringify(captureCanonicalJson({ ...first, cardId: id(99) }));
      const original = canonicalJsonStringify(captureCanonicalJson(first));
      const update = raw.prepare("UPDATE presentation_card SET record_json=? WHERE card_id=?");
      try {
        const admission = test.store.prepareDecision(first, id(7));
        test.store.discardDecision(admission);
        raw.pragma("ignore_check_constraints = ON");
        update.run(text, first.cardId);
        const parse = vi.spyOn(JSON, "parse");
        try {
          expect(() => test.store.read(first.cardId)).toThrow();
          if (corruption === "oversized") expect(parse.mock.calls.some(([value]) => value === text)).toBe(false);
        } finally { parse.mockRestore(); }
        expect(() => test.store.beginCreation("signing", {index: 1}, key)).toThrow();
        expect(() => test.store.prepareDecision(first, id(7))).toThrow();
        update.run(original, first.cardId);
        expect(test.store.read(first.cardId)).toEqual(first);
        const restored = test.store.prepareDecision(first, id(7));
        test.store.discardDecision(restored);

        // A current-generation invalid row is a startup input. Retained rows
        // from an earlier generation are admitted lazily by the exact owner.
        test.database.ownerStore().publishOwner(createOwnerInstanceId(), Buffer.alloc(32, 7).toString("base64url"),
          parseUtcTimestamp("2026-09-11T00:00:01.000Z"));
        update.run(text, first.cardId);
        test.database.close();
        const reopened = await ProductDatabase.open(test.path, parseUtcTimestamp("2026-09-11T00:00:01.000Z"));
        try {
          const store = reopened.presentationCardStore();
          expect(() => store.read(first.cardId)).toThrow();
          expect(() => store.beginCreation("signing", {index: 1}, key)).toThrow();
          expect(raw.prepare("SELECT record_json AS text FROM presentation_card WHERE card_id=?").get(first.cardId)).toEqual({text});
          update.run(original, first.cardId);
          expect(store.read(first.cardId)).toEqual({...first, inputState: "input_closed", closeReason: "owner_lost"});
          expect(store.beginCreation("signing", {index: 1}, key)).toEqual({status: "existing", cardId: first.cardId});
          expect(() => store.prepareDecision(first, id(7))).toThrow();
        } finally { reopened.close(); }
      } finally { raw.close(); test.database.close(); }
    }
  });
});
