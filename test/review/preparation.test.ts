import { describe, expect, it, vi } from "vitest";
import {ObservationAuthorityRegistry, createCanonicalClock, createCapabilityInvocationAuthority, createObservationAuthority, createObservationAuthorityIssuer, parseHash32, parseHexBytes, parseUnsignedDecimal, parseUtcTimestamp, sourceReferenceSchema} from "../../src/core/index.js";
import {chainAnchorSchema} from "../../src/evm/primitives.js";
import {contractAnalysisSchema, createContractAnalysisSourceClaim} from "../../src/intelligence/analysis-contract.js";
import {dynamicFeeRequestCommitment} from "../../src/evm/transaction-request.js";
import {keccak256FromHex} from "../../src/evm/keccak256.js";
import {parseEvmAddress, type EvmAddress} from "../../src/evm/identities.js";
import {requiredErc8056ObservationSchema} from "../../src/evm/token-standards.js";
import {walletConnectionDataSchema} from "../../src/wallet/connection-contract.js";
import { createChainInvocationLifecycle, createEvmAbiCodec } from "../../src/chain/index.js";
import { normalizeRpcTransaction } from "../../src/chain/normalization.js";
import { serializeDynamicFeeRequest } from "../../src/chain/transaction-reads.js";
import {
  assertCommittedOfficialAssetSnapshot, officialAssetSnapshotRevisionSchema, officialAssetSourceDefinition,
  stockFactoryAdmissionManifest, stockFactoryVerificationSchema,
} from "../../src/registry/index.js";
import { officialAssetCandidateListDigest, officialAssetMemberSetDigest } from "../../src/registry/official-asset-contract.js";
import { observeExchange, type ExchangePreparationDependencies } from "../../src/review/preparation.js";
import { exchangeObservationInputSchema, exchangeObservationResultSchema } from "../../src/review/observation-contract.js";
import { requestReviewLimits } from "../../src/review/request-limits.js";
import { ExchangeCoordinator } from "../../src/review/coordinator.js";
import type { WalletRequestPort, WalletTransactionResponse } from "../../src/wallet/request-contract.js";
import type { ReceivedWalletTransaction, TransactionReceiptAdmissionPort, WalletReceiptReservation } from "../../src/receipt-activity/admission.js";
import { createReadyExchangeReview, exchangeDirectDecisionSchema, exchangeReviewSchema } from "../../src/review/contracts.js";
import { createRequestReviewMaterialStore } from "../../src/runtime/request-review-material.js";
import { createUniswapV4Evm } from "../../src/protocols/uniswap-v4/evm.js";
import { walletSessionRequirements } from "../../src/wallet/session-requirements.js";
import { uniswapV4PoolCatalog, uniswapV4ContractAddresses } from "../../src/protocols/uniswap-v4/client.js";
import { uniswapV4RequiredContractFunctions } from "../../src/protocols/uniswap-v4/contract-profile.js";

import { createExchangeFixture } from "./fixture.js";
const word = (value: bigint) => parseHexBytes(`0x${value.toString(16).padStart(64, "0")}`);

const coordinatorFixture = (kind: "swap" | "erc20_approval" | "permit2_approval" = "swap") => {
  const test = createExchangeFixture(kind);
  const materials = createRequestReviewMaterialStore(test.deps.clock);
  const trace: string[] = [];
  const recorded: ReceivedWalletTransaction[] = [];
  const reservations = new Set<WalletReceiptReservation>();
  let pending = false;
  let respond: ((value: WalletTransactionResponse) => void) | undefined;
  let notifySent!: () => void;
  const sent = new Promise<"sent">((done) => { notifySent = () => done("sent"); });
  const wallet: WalletRequestPort = {
    hasPendingRequest: () => pending,
    startRequest: vi.fn(async () => {
      if (pending) throw new Error("The fixture SDK lane is occupied.");
      pending = true;
      trace.push("wallet-request");
      notifySent();
      const response = new Promise<WalletTransactionResponse>((done) => { respond = (value) => { pending = false; done(value); }; });
      return { response };
    }),
  };
  const receipts: TransactionReceiptAdmissionPort = {
    reserveWalletTransaction: () => { const value = Object.freeze({}) as WalletReceiptReservation; reservations.add(value); trace.push("reserve-memory"); return value; },
    releaseWalletTransaction: (value) => { reservations.delete(value); },
    recordWalletTransaction: vi.fn((reservation, value) => {
      if (!reservations.delete(reservation)) throw new Error("Missing receipt reservation.");
      trace.push("record-hash"); recorded.push(value);
    }),
    inspectWalletTransaction: vi.fn(async () => { trace.push("inspect-receipt"); }),
    reconcileAccount: async (account) => ({ account, unresolved: [] }),
    currentDependencies: (account) => ({ account, unresolved: [] }),
  };
  const coordinator = new ExchangeCoordinator({ preparation: test.deps, materials, wallet, receipts });
  return { ...test, coordinator, materials, wallet, receipts, recorded, reservations, trace,
    reply(value: WalletTransactionResponse) { if (respond === undefined) throw new Error("No Wallet request."); respond(value); },
    async sent(result: Promise<unknown>) { expect(await Promise.race([sent, result.then(() => "finished")])).toBe("sent"); },
    async dispose() { await coordinator.close(); await test.close(); },
  };
};

describe("shared direct exchange flow", () => {
  for (const kind of ["swap", "erc20_approval", "permit2_approval"] as const) {
    it(`replaces only fees for an independently read pending ${kind} without inventing its earlier exchange intent`, async () => {
      const test = coordinatorFixture(kind);
      try {
        const original = await observeExchange(test.deps, test.input, new AbortController().signal);
        if (!original.ok) throw new Error("Original request fixture required.");
        const hash = parseHash32(`0x${"91".repeat(32)}`);
        const wire = serializeDynamicFeeRequest(original.privateRequest);
        const transaction = normalizeRpcTransaction({ ...wire, hash, input: wire.data,
          blockHash: null, blockNumber: null, transactionIndex: null }, original.privateRequest.chainId);
        const deps = { ...test.deps, transactions: { ...test.deps.transactions,
          nonce: async () => ({ confirmed: "1", pending: "2" }),
          readTransaction: vi.fn(async () => ({ status: "pending" as const, transaction })),
        } };
        const coordinator = new ExchangeCoordinator({ preparation: deps, wallet: test.wallet, receipts: test.receipts, materials: test.materials });
        try {
          const review = await coordinator.start({ kind: "replace_fees", account: test.input.request.account,
            transactionHash: hash, fees: { maxFeePerGas: parseUnsignedDecimal("11"), maxPriorityFeePerGas: parseUnsignedDecimal("2") } }, new AbortController().signal);
          expect(review.state, JSON.stringify(review)).toBe("ready_for_wallet_review");
          if (review.state !== "ready_for_wallet_review") return;
          expect(review.observation.data.intent).not.toHaveProperty("poolId");
          expect(review.expectedEffect.kind).toBe(kind);
          const result = coordinator.confirm({ review, initiatedBy: "cli" }, new AbortController().signal);
          await test.sent(result);
          const sentInput = vi.mocked(test.wallet.startRequest).mock.calls[0]![0];
          if (sentInput.kind !== "transaction") throw new Error("Expected transaction request.");
          const sent = sentInput.request;
          expect(sent).toEqual({ ...original.privateRequest, maxFeePerGas: "11", maxPriorityFeePerGas: "2" });
          test.reply({ status: "wallet_rejected" });
          expect(await result).toMatchObject({ kind: "wallet_result", outcome: { status: "wallet_rejected" } });
          expect(test.recorded).toEqual([]);
        } finally { await coordinator.close(); }
      } finally { await test.dispose(); }
    });
  }

  it("constructs a different supported call at the original nonce and refuses that nonce after inclusion", async () => {
    const test = coordinatorFixture();
    try {
      const original = await observeExchange(test.deps, test.input, new AbortController().signal);
      if (!original.ok || "kind" in test.input.request) throw new Error("Original exchange fixture required.");
      const hash = parseHash32(`0x${"92".repeat(32)}`);
      const wire = serializeDynamicFeeRequest(original.privateRequest);
      const transaction = normalizeRpcTransaction({ ...wire, hash, input: wire.data, blockHash: null, blockNumber: null, transactionIndex: null }, original.privateRequest.chainId);
      let consumed = false;
      const deps = { ...test.deps, transactions: { ...test.deps.transactions,
        nonce: async () => ({ confirmed: consumed ? "2" : "1", pending: "2" }),
        readTransaction: async () => ({ status: "pending" as const, transaction }),
      } };
      const coordinator = new ExchangeCoordinator({ preparation: deps, wallet: test.wallet, receipts: test.receipts, materials: test.materials });
      try {
        const request = { ...test.input.request, replaces: hash,
          conditions: { ...test.input.request.conditions, outputAmount: "18" },
          fees: { maxFeePerGas: parseUnsignedDecimal("11"), maxPriorityFeePerGas: parseUnsignedDecimal("2") } };
        const review = await coordinator.start(request, new AbortController().signal);
        expect(review.state, JSON.stringify(review)).toBe("ready_for_wallet_review");
        if (review.state !== "ready_for_wallet_review") return;
        const material = test.materials.read(review.observation.data.operationId)!;
        if (material.kind !== "transaction") throw new Error("Expected transaction material.");
        expect(material.request.nonce).toBe("1");
        expect(material.request.data).not.toBe(original.privateRequest.data);
        consumed = true;
        const result = await coordinator.confirm({ review, initiatedBy: "cli" }, new AbortController().signal);
        expect(result).toMatchObject({ kind: "review", review: { state: "refresh_required" } });
        expect(test.wallet.startRequest).not.toHaveBeenCalled();
      } finally { await coordinator.close(); }
    } finally { await test.dispose(); }
  });

  it("revalidates a newer canonical block, consumes one direct decision and records only the actual hash/reference", async () => {
    const test = coordinatorFixture();
    try {
      const review = await test.coordinator.start(test.input.request, new AbortController().signal);
      if (review.state !== "ready_for_wallet_review") throw new Error("Ready fixture required.");
      test.advanceBlock();
      test.estimate.mockResolvedValue("99999");
      const action = { review, initiatedBy: "cli" as const };
      const result = test.coordinator.confirm(action, new AbortController().signal);
      await expect(test.coordinator.confirm(action, new AbortController().signal)).rejects.toThrow();
      await test.sent(result);
      expect(test.materials.read(review.observation.data.operationId)).toBeNull();
      expect(test.trace).toEqual(["reserve-memory", "wallet-request"]);
      const transactionHash = parseHash32(`0x${"ef".repeat(32)}`);
      test.reply({ status: "hash_returned", transactionHash });
      expect(await result).toEqual({ kind: "wallet_result", outcome: { status: "hash_returned", transactionHash, recording: "recorded", lookup: "completed" } });
      expect(test.trace).toEqual(["reserve-memory", "wallet-request", "record-hash", "inspect-receipt"]);
      expect(test.recorded).toEqual([{
        transactionHash,
        reference: { account: review.observation.data.intent.account, encodingVersion: "1", walletRequestCommitment: review.observation.data.walletRequestCommitment },
        receivedAt: test.deps.clock.now(),
      }]);
      expect(test.wallet.startRequest).toHaveBeenCalledTimes(1);
      expect(test.reservations.size).toBe(0);
    } finally { await test.dispose(); }
  });

  it("discards changed authority before Wallet and starts another attempt only through a new command", async () => {
    const test = coordinatorFixture();
    try {
      const review = await test.coordinator.start(test.input.request, new AbortController().signal);
      if (review.state !== "ready_for_wallet_review") throw new Error("Ready fixture required.");
      test.replaceConnection();
      const result = await test.coordinator.confirm({ review, initiatedBy: "mcp_app" }, new AbortController().signal);
      expect(result).toMatchObject({ kind: "review", review: { state: "refresh_required", operationId: review.observation.data.operationId } });
      expect(test.coordinator.get(review.observation.data.operationId)).toBeNull();
      expect(test.wallet.startRequest).not.toHaveBeenCalled();
      const next = await test.coordinator.start(test.input.request, new AbortController().signal);
      if (next.state !== "ready_for_wallet_review") throw new Error("New ready fixture required.");
      const response = test.coordinator.confirm({ review: next, initiatedBy: "mcp_app" }, new AbortController().signal);
      await test.sent(response);
      test.reply({ status: "wallet_rejected" });
      expect(await response).toEqual({ kind: "wallet_result", outcome: { status: "wallet_rejected" } });
      expect(test.recorded).toEqual([]);
      expect(test.reservations.size).toBe(0);
      expect(test.wallet.startRequest).toHaveBeenCalledTimes(1);
    } finally { await test.dispose(); }
  });

  it("ends local waiting and records a later original hash without starting RPC work", async () => {
    const test = coordinatorFixture();
    try {
      const review = await test.coordinator.start(test.input.request, new AbortController().signal);
      if (review.state !== "ready_for_wallet_review") throw new Error("Ready fixture required.");
      const wait = new AbortController();
      const result = test.coordinator.confirm({ review, initiatedBy: "cli" }, wait.signal);
      await test.sent(result);
      wait.abort();
      expect(await result).toEqual({ kind: "wallet_result", outcome: { status: "delivery_unknown" } });
      expect(test.wallet.hasPendingRequest()).toBe(true);
      test.reply({ status: "hash_returned", transactionHash: parseHash32(`0x${"ef".repeat(32)}`) });
      await new Promise<void>((done) => setImmediate(done));
      expect(test.recorded).toHaveLength(1);
      expect(test.receipts.inspectWalletTransaction).not.toHaveBeenCalled();
      expect(test.wallet.startRequest).toHaveBeenCalledTimes(1);
      expect(test.reservations.size).toBe(0);
    } finally { await test.dispose(); }
  });
});

describe("exchange observation production", () => {
  it("reserves bounded private material, consumes the exact Review once, and removes it on expiry or close", async () => {
    const test = createExchangeFixture();
    const store = createRequestReviewMaterialStore(test.deps.clock);
    try {
      const result = await observeExchange(test.deps, test.input, new AbortController().signal);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const review = createReadyExchangeReview(result.review);
      const first = store.reserve(test.input.operationId, test.input.createdAt, test.input.actionExpiresAt);
      store.publish(first, { kind: "transaction", review, request: result.privateRequest, command: test.input.request });
      const presentation = store.readPresentation(test.input.operationId);
      expect(presentation.status).toBe("available");
      if (presentation.status !== "available") throw new Error("Active Review presentation required.");
      expect(JSON.parse(new TextDecoder().decode(presentation.value.snapshot.resultBytes))).toEqual(review);
      expect(new TextDecoder().decode(presentation.value.snapshot.resultBytes)).not.toContain(result.privateRequest.data);
      const separate = await observeExchange(test.deps, test.input, new AbortController().signal);
      if (!separate.ok) throw new Error("Independent observation fixture failed.");
      expect(() => store.consume(createReadyExchangeReview(separate.review))).toThrow();
      expect(store.read(test.input.operationId)).toMatchObject({ kind: "transaction", request: result.privateRequest });
      expect(store.consume(review)).toEqual({
        kind: "transaction",
        request: result.privateRequest,
        reference: {
          account: review.observation.data.intent.account,
          encodingVersion: "1",
          walletRequestCommitment: review.observation.data.walletRequestCommitment,
        },
      });
      expect(store.read(test.input.operationId)).toBeNull();
      expect(store.readPresentation(test.input.operationId)).toEqual({ status: "unavailable", reason: "snapshot_missing" });
      expect(() => store.consume(review)).toThrow();
      const reservations = Array.from({ length: requestReviewLimits.liveReviews }, (_, index) => store.reserve(
        Buffer.alloc(32, index + 1).toString("base64url"), test.input.createdAt, test.input.actionExpiresAt,
      ));
      expect(() => store.reserve(Buffer.alloc(32, 100).toString("base64url"), test.input.createdAt, test.input.actionExpiresAt)).toThrow();
      store.release(reservations[0]!);
      const replacement = store.reserve(test.input.operationId, test.input.createdAt, test.input.actionExpiresAt);
      store.publish(replacement, { kind: "transaction", review, request: result.privateRequest, command: test.input.request });
      test.expire();
      expect(store.read(test.input.operationId)).toBeNull();
      expect(() => store.publish(replacement, { kind: "transaction", review, request: result.privateRequest, command: test.input.request })).toThrow();
      store.close();
      expect(() => store.read(test.input.operationId)).toThrow();
    } finally { store.close(); await test.close(); }
  });

  it("retains both source roles for proxied tokens within the complete Review envelope", async () => {
    const test = createExchangeFixture("swap");
    try {
      const result = await observeExchange(test.deps, test.input, new AbortController().signal);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.review.data.contracts[0]?.facts.sources).toHaveLength(2);
      expect(result.review.data.contracts[1]?.facts.sources).toHaveLength(2);
      expect(Buffer.byteLength(JSON.stringify(result.review))).toBeLessThanOrEqual(requestReviewLimits.reviewUtf8Bytes);
      expect(exchangeDirectDecisionSchema.safeParse({ review: createReadyExchangeReview(result.review), initiatedBy: "cli" }).success).toBe(true);
    } finally { await test.close(); }
  });
  it("fits a transaction Review when the admitted session also approves unrelated methods and events", async () => {
    const test = createExchangeFixture("swap", true);
    try {
      const result = await observeExchange(test.deps, test.input, new AbortController().signal);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(exchangeDirectDecisionSchema.safeParse({ review: createReadyExchangeReview(result.review), initiatedBy: "cli" }).success).toBe(true);
    } finally { await test.close(); }
  });

  it("blocks a deployment whose exact interface lacks a required native function", async () => {
    const test = createExchangeFixture();
    const inspect = test.inspect.getMockImplementation()!;
    test.inspect.mockImplementationOnce(async (...args) => {
      const result = await inspect(...args);
      if (result.analysis.declaredFunctions.status !== "observed") throw new Error("Fixture interface must be observed.");
      return { ...result, analysis: contractAnalysisSchema.parse({
        ...result.analysis, declaredFunctions: { status: "observed", signatures: result.analysis.declaredFunctions.signatures.slice(1) },
      }) };
    });
    try {
      const result = await observeExchange(test.deps, test.input, new AbortController().signal);
      expect(result).toMatchObject({ ok: false, error: { code: "exchange_contract_unavailable" } });
      expect(test.estimate).not.toHaveBeenCalled();
    } finally { await test.close(); }
  });

  it("binds displayed effects to the admitted native transaction", async () => {
    const test = createExchangeFixture();
    try {
      const result = await observeExchange(test.deps, test.input, new AbortController().signal);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const review = createReadyExchangeReview(result.review);
      expect(exchangeReviewSchema.safeParse({ ...review, expectedEffect: { ...review.expectedEffect, recipient: `0x${"ab".repeat(20)}` } }).success).toBe(false);
    } finally { await test.close(); }
  });
  it.each(["swap", "erc20_approval", "permit2_approval"] as const)("produces complete %s evidence and a separate exact request", async (kind) => {
    const test = createExchangeFixture(kind);
    try {
      const result = await observeExchange(test.deps, test.input, new AbortController().signal);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.review.data.kind).toBe(kind);
      if ("replacement" in result.review.data) throw new Error("Exchange observation fixture required.");
      expect(result.review.data.intent.input.raw).toBe("10");
      expect(result.review.data.displayScaling[0].values?.currentMultiplier).toBe("2000000000000000000");
      expect(result.review.data.walletRequestCommitment).toBe(dynamicFeeRequestCommitment(result.privateRequest));
      expect(exchangeObservationResultSchema.parse(result.review)).toEqual(result.review);
      expect(Buffer.byteLength(JSON.stringify(result.review))).toBeLessThanOrEqual(requestReviewLimits.reviewUtf8Bytes);
      expect(JSON.stringify(result.review)).not.toContain(result.privateRequest.data);
      expect(test.estimate).toHaveBeenCalledOnce();
      expect(test.simulate).toHaveBeenCalledOnce();
      expect(test.inspect).toHaveBeenCalledTimes(7);
    } finally { await test.close(); }
  });

  it("refuses nonce disagreement before estimating or simulating", async () => {
    const test = createExchangeFixture();
    try {
      const result = await observeExchange({ ...test.deps, transactions: { ...test.deps.transactions, nonce: async () => ({ confirmed: "1", pending: "2" }) } }, test.input, new AbortController().signal);
      expect(result).toMatchObject({ ok: false, error: { code: "exchange_conditions_unmet" } });
      expect(test.estimate).not.toHaveBeenCalled();
      expect(test.simulate).not.toHaveBeenCalled();
    } finally { await test.close(); }
  });

  it("refuses an unmet output condition before constructing the request", async () => {
    const test = createExchangeFixture();
    try {
      if ("kind" in test.input.request) throw new Error("Exchange request fixture required.");
      const input = exchangeObservationInputSchema.parse({ ...test.input, request: { ...test.input.request, conditions: { ...test.input.request.conditions, outputAmount: "21" } } });
      const result = await observeExchange(test.deps, input, new AbortController().signal);
      expect(result).toMatchObject({ ok: false, error: { code: "exchange_conditions_unmet" } });
      expect(test.estimate).not.toHaveBeenCalled();
    } finally { await test.close(); }
  });

  it("does not treat a false ERC-20 approve return as a successful approval simulation", async () => {
    const test = createExchangeFixture("erc20_approval");
    try {
      test.simulate.mockResolvedValue({ status: "returned", data: word(0n) });
      const result = await observeExchange(test.deps, test.input, new AbortController().signal);
      expect(result).toMatchObject({ ok: false, error: { code: "exchange_conditions_unmet" } });
    } finally { await test.close(); }
  });

  it.each(["expiry", "connection"] as const)("does not publish a result after %s changes during the final call", async (change) => {
    const test = createExchangeFixture();
    try {
      test.simulate.mockImplementation(async () => {
        if (change === "expiry") test.expire(); else test.replaceConnection();
        return { status: "returned", data: parseHexBytes("0x") };
      });
      const result = await observeExchange(test.deps, test.input, new AbortController().signal);
      expect(result).toMatchObject({ ok: false, error: { code: change === "expiry" ? "review_expired" : "wallet_session_unusable" } });
    } finally { await test.close(); }
  });
});
