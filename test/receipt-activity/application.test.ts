import { createSigningCodec } from "../../src/chain/evm-standard.js";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { parseHash32, parseHexBytes, parseEvmAddress, keccak256FromUtf8 } from "../../src/core/index.js";
import { normalizeIncludedTransaction, normalizeRpcTransaction } from "../../src/chain/normalization.js";
import { serializeDynamicFeeRequest, type TransactionChainReadPort } from "../../src/chain/transaction-reads.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { ReceiptActivity } from "../../src/receipt-activity/application.js";
import { createReviewApplication } from "../../src/review/application.js";
import { createReadyExchangeReview } from "../../src/review/contracts.js";
import { createReviewedRequestReference } from "../../src/review/request-reference.js";
import { observeExchange } from "../../src/review/preparation.js";
import { createExchangeFixture } from "../review/fixture.js";
import { uniswapV4ContractAddresses } from "../../src/protocols/uniswap-v4/client.js";

import { createReceiptFixture as fixture } from "./fixture.js";
const qty = (value: string | bigint) => `0x${BigInt(value).toString(16)}`;
describe("transaction ledger and receipt process", () => {
  it("hands the same command through Review, one Wallet request, the ledger and its public read contract", async () => {
    const test = await fixture();
    const request = vi.fn(async () => ({ response: Promise.resolve({ status: "hash_returned" as const, transactionHash: test.hash }) }));
    const app = createReviewApplication({ preparation: { ...test.deps, transactions: test.transactions },
      receiptInvocationPorts: test.invocationPorts, nativeUnitAuthority: test.nativeUnitAuthority,
      codec: test.codec, signingCodec: createSigningCodec(), walletRequests: { hasPendingRequest: () => false, startRequest: request },
      ledger: test.database.transactionLedgerStore() });
    try {
      const review = await app.exchange.start(test.input.request, new AbortController().signal);
      expect(review.state).toBe("ready_for_wallet_review");
      if (review.state !== "ready_for_wallet_review") return;
      expect(app.presentations.readPresentation(review.observation.data.operationId).status).toBe("available");
      const result = await app.exchange.confirm({ review, initiatedBy: "cli" }, new AbortController().signal);
      expect(result).toMatchObject({ kind: "wallet_result", outcome: { status: "hash_returned", recording: "recorded", lookup: "completed" } });
      expect(request).toHaveBeenCalledTimes(1);
      expect(app.exchange.get(review.observation.data.operationId)).toBeNull();
      expect(app.presentations.readPresentation(review.observation.data.operationId).status).toBe("unavailable");
      const record = app.activity.get({ account: test.reference.account, transactionHash: test.hash });
      expect(record?.inspection?.data).toMatchObject({ execution: "success", requestComparison: "matched", effectComparison: "matched" });
      expect(app.activity.list({ account: test.reference.account, cursor: null }).records).toEqual([record]);
    } finally { await app.close(); await test.close(); }
  });
  it("retains a known receipt when subsequent token metadata is unavailable", async () => {
    const test = await fixture();
    try {
      test.receive();
      vi.spyOn(test.deps.reads, "readTokenDecimals").mockRejectedValue(new Error("Token metadata unavailable."));
      const result = await test.activity.inspect(test.reference.account, test.hash, new AbortController().signal);
      expect(result.status).toBe("unavailable");
      expect(result.record?.inspection?.data).toMatchObject({ status: "included", execution: "success",
        effectComparison: "unavailable", metadataComplete: false, fees: { amount: { raw: "105000" } } });
      expect(test.activity.get(test.reference.account, test.hash)).toEqual(result.record);
    } finally { await test.close(); }
  });

  it("bounds a user-started poll and retains the observed nonce when the hash later disappears", async () => {
    const test = await fixture();
    try {
      test.receive();
      const pending = normalizeRpcTransaction({ ...test.tx, blockHash: null, blockNumber: null, transactionIndex: null }, test.reference.account.chainId);
      const read = vi.spyOn(test.transactions, "readTransaction").mockResolvedValue({ status: "pending", transaction: pending });
      vi.useFakeTimers();
      const query = test.activity.inspect(test.reference.account, test.hash, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(90_001);
      const result = await query;
      expect(result.status).toBe("unavailable");
      expect(result.record?.inspection?.data.status).toBe("pending");
      expect(result.record?.observedTransaction).toEqual({ sender: test.reference.account.address, nonce: "1" });
      const count = read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(read).toHaveBeenCalledTimes(count);
      vi.useRealTimers();
      read.mockResolvedValue({ status: "not_found" });
      vi.spyOn(test.transactions, "nonce").mockResolvedValue({ confirmed: "2", pending: "2" });
      expect((await test.activity.reconcileAccount(test.reference.account, new AbortController().signal)).unresolved).toEqual([]);
      const stored = test.activity.get(test.reference.account, test.hash)!;
      expect(stored.inspection?.data.status).toBe("not_found");
      expect(stored.observedTransaction).toEqual({ sender: test.reference.account.address, nonce: "1" });
    } finally { vi.useRealTimers(); await test.close(); }
  });

  it("withholds an oversized SQL record before transfer while a removed projection bound transfers it", async () => {
    const test = await fixture();
    const raw = new Database(test.path);
    try {
      test.receive();
      const original = Database.prototype.prepare;
      let query = "";
      const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function(this: Database.Database, sql: string) {
        if (sql.includes("FROM transaction_ledger WHERE chain_id = ? AND transaction_hash = ?")) query = sql;
        return original.call(this, sql);
      });
      try { test.activity.get(test.reference.account, test.hash); } finally { spy.mockRestore(); }
      expect(query).not.toBe("");
      const row = raw.prepare("SELECT record_json FROM transaction_ledger").get() as { record_json: string };
      const oversized = row.record_json + " ".repeat(1_048_576);
      raw.pragma("ignore_check_constraints = ON");
      raw.prepare("UPDATE transaction_ledger SET record_json=?").run(oversized);
      const args = [test.reference.account.chainId, test.hash];
      const guarded = raw.prepare(query).get(...args) as { recordJson: unknown; recordJsonByteLength: number };
      expect(guarded.recordJson).toBeNull();
      expect(guarded.recordJsonByteLength).toBe(Buffer.byteLength(oversized));
      const unbounded = query.replace("AND octet_length(record_json) <= 65535 ", "");
      expect(unbounded).not.toBe(query);
      const transferred = raw.prepare(unbounded).get(...args) as { recordJson: Buffer };
      expect(transferred.recordJson.byteLength).toBe(Buffer.byteLength(oversized));
      expect(() => test.activity.get(test.reference.account, test.hash)).toThrow();
    } finally { raw.close(); await test.close(); }
  });
  for (const kind of ["swap", "erc20_approval", "permit2_approval"] as const) it(`records and verifies an actual ${kind} after the temporary request has ended`, async () => {
    const test = await fixture(kind);
    try {
      test.receive();
      expect(test.activity.get(test.reference.account, test.hash)?.inspection).toBeNull();
      await test.activity.inspectWalletTransaction({ transactionHash: test.hash, reference: test.reference, receivedAt: test.deps.clock.now() }, new AbortController().signal);
      const record = test.activity.get(test.reference.account, test.hash)!;
      expect(record.inspection?.data).toMatchObject({ status: "included", execution: "success", requestComparison: "matched", effectComparison: "matched",
        fees: { amount: { raw: "105000", decimals: { status: "available", value: "18" } } } });
      const encoded = JSON.stringify(record);
      expect(encoded).not.toContain(test.original.privateRequest.data);
      expect(encoded).not.toContain('"review":');
      await test.reopen();
      expect(test.activity.get(test.reference.account, test.hash)).toEqual(record);
      expect(test.activity.currentDependencies(test.reference.account).unresolved).toEqual([]);
    } finally { await test.close(); }
  });

  for (const change of ["request", "effects"] as const) it(`preserves the original reference while independent ${change} evidence differs`, async () => {
    const test = await fixture();
    try {
      test.receive();
      if (change === "request") test.tx.nonce = "0x2";
      else (test.receipt.logs[1] as { data: string }).data = `0x${18n.toString(16).padStart(64, "0")}`;
      const result = await test.activity.inspect(test.reference.account, test.hash, new AbortController().signal);
      expect(result.record?.inspection?.data).toMatchObject({ status: "included", execution: "success",
        requestComparison: change === "request" ? "mismatched" : "matched",
        effectComparison: change === "request" ? "unavailable" : "mismatched" });
      expect(result.record?.origin).toEqual({ kind: "wallet", reference: test.reference });
      expect(test.activity.list(test.reference.account).records).toHaveLength(1);
    } finally { await test.close(); }
  });

  it("retains the previous valid ledger row when a conflicting reference is refused", async () => {
    const test = await fixture();
    try {
      test.receive();
      const before = test.activity.get(test.reference.account, test.hash)!;
      const reservation = test.activity.reserveWalletTransaction();
      expect(() => test.activity.recordWalletTransaction(reservation, { transactionHash: test.hash, receivedAt: test.deps.clock.now(),
        reference: { ...test.reference, walletRequestCommitment: parseHash32(`0x${"cd".repeat(32)}`) } })).toThrow();
      test.activity.releaseWalletTransaction(reservation);
      expect(test.activity.get(test.reference.account, test.hash)).toEqual(before);
      const raw = new Database(test.path, { readonly: true });
      try {
        const row = raw.prepare("SELECT record_json FROM transaction_ledger").get() as { record_json: string };
        expect(row.record_json).not.toContain(test.original.privateRequest.data);
      } finally { raw.close(); }
    } finally { await test.close(); }
  });
});
