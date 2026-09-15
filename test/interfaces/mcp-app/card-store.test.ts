import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUtcTimestamp, canonicalJsonStringify, captureCanonicalJson } from "../../../src/core/index.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import { admitCardRecord, cardErrorDefinitions, cardOutcomeSchema, presentationCardLimits, cardActionResponseLimitBytes, admitCardActionDelivery,
  serializeCardActionPresentation, admitCardActionPresentation, type CardPresentation } from "../../../src/interfaces/mcp-app/card-contract.js";

const closures: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closures.splice(0).reverse()) await close(); });
const id = (value: number) => { const bytes = Buffer.alloc(32); bytes.writeUInt32BE(value); return bytes.toString("base64url"); };
const record = (index = 1) => { const value = admitCardRecord({
  cardId: id(index), kind: "signing", contractVersion: "1", operationId: id(index + 100_000), resultDigest: "a".repeat(64),
  snapshotId: null, firstCardOpenRequestId: null,
  context: { account: { chainId: "eip155:4663", address: `0x${"11".repeat(20)}` }, method: "personal_sign" },
  expiresAt: "2026-09-11T00:05:00.000Z", phase: "ready", outcome: null,
}); if (value.kind !== "signing") throw new Error("Signing fixture required."); return value; };
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "littlejohn-card-store-"));
  const path = join(root, "product.sqlite3");
  const database = await ProductDatabase.open(path, parseUtcTimestamp("2026-09-11T00:00:00.000Z"));
  closures.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  return { database, path, store: database.presentationCardStore() };
};

it("admits every card-owned failure as a saved terminal classification", () => {
  for (const { code } of cardErrorDefinitions) {
    expect(cardOutcomeSchema.parse({ kind: "failure", failureCode: code })).toEqual({ kind: "failure", failureCode: code });
  }
});

describe("card SQLite ownership", () => {
  it("preserves component bounds and canonical nullable presentation in a paired action response", () => {
    const stored = { ...record(), phase: "closed" as const, outcome: { kind: "signing" as const, status: "verified" as const } };
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
  it("uses the independently counted closed metadata envelope", () => {
    // Independently counted containing envelope: 475 scalar bytes + 191 outcome bytes + 135 context bytes.
    expect(presentationCardLimits.recordBytes).toBe(801);
    expect(presentationCardLimits.aggregateBytes).toBe(13_123_584);
  });
  it("conditionally replaces one exact predecessor, preserves terminal rows and validates them on restart", async () => {
    const test = await setup(); const first = test.store.insert(record());
    if (first.kind === "read") throw new Error("Decision fixture required.");
    const opened = test.store.replace(first, { ...first, firstCardOpenRequestId: id(7) });
    if (opened.kind === "read") throw new Error("Decision fixture required.");
    expect(() => test.store.replace(first, { ...first, firstCardOpenRequestId: id(7) })).toThrow();
    const closed = test.store.replace(opened, { ...opened, phase: "closed", outcome: { kind: "decision", reason: "returned" } });
    expect(() => test.store.replace(closed, opened)).toThrow();
    expect(test.store.insert(first)).toEqual(closed);
    test.database.close();
    const reopened = await ProductDatabase.open(test.path, parseUtcTimestamp("2026-09-11T00:00:01.000Z"));
    try { expect(reopened.presentationCardStore().read(first.cardId)).toEqual(closed); }
    finally { reopened.close(); }
  });

  it("enforces the accepted 16,384-record capacity without eviction or resetting an existing decision", async () => {
    const test = await setup(); const raw = new Database(test.path);
    try {
      const insert = raw.prepare("INSERT INTO presentation_card(card_id,kind,operation_id,record_json) VALUES (?,?,?,?)");
      raw.transaction(() => {
        for (let index = 1; index < 16_384; index++) {
          const value = record(index);
          insert.run(value.cardId, value.kind, value.operationId, canonicalJsonStringify(captureCanonicalJson(value)));
        }
      })();
      expect(test.store.insert(record(16_384))).toEqual(record(16_384));
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_card").get()).toEqual({ count: 16_384 });
      expect(() => test.store.insert(record(16_385))).toThrow("Card storage capacity is exhausted");
      expect(test.store.insert(record(1))).toEqual(record(1));
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_card").get()).toEqual({ count: 16_384 });
    } finally { raw.close(); }
  });

  it("rejects oversized stored bytes before JSON decoding and rejects index/body disagreement", async () => {
    const test = await setup(); const first = test.store.insert(record());
    if (first.kind === "read") throw new Error("Decision fixture required.");
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
