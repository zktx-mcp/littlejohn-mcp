import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceiptFixture } from "../../receipt-activity/fixture.js";
import { createReviewApplication } from "../../../src/review/application.js";
import { createSigningCodec } from "../../../src/chain/evm-standard.js";
import { exchangeReviewSchema } from "../../../src/review/contracts.js";
import {createOwnerInstanceId} from "../../../src/runtime/runtime-identity.js";
import { PresentationCardApplication } from "../../../src/interfaces/mcp-app/card-application.js";
import type { CardDomains } from "../../../src/interfaces/mcp-app/card-sources.js";
import type { WalletRequestResponse } from "../../../src/wallet/request-contract.js";
import type {CardPresentation} from "../../../src/interfaces/mcp-app/card-contract.js";
import {ChainOperationError} from "../../../src/chain/errors.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const unexpected = async (): Promise<never> => { throw new Error("Unexpected domain call"); };
const setup = async (blocked = false) => {
  const base = await createReceiptFixture();
  base.database.ownerStore().publishOwner(createOwnerInstanceId(), Buffer.alloc(32, 7).toString("base64url"), base.deps.clock.now());
  let reply!: (value: WalletRequestResponse) => void;
  const response = new Promise<WalletRequestResponse>((resolve) => { reply = resolve; });
  let sent!: () => void;
  const started = new Promise<void>((resolve) => { sent = resolve; });
  const request = vi.fn(async () => { sent(); return { response, settlement: response }; });
  const readTransaction = vi.fn(base.transactions.readTransaction);
  const transactions = { ...base.transactions, readTransaction, ...(blocked ? { balance: async () => "0" } : {}) };
  const application = createReviewApplication({ preparation: { ...base.deps, transactions },
    receiptInvocationPorts: base.invocationPorts, nativeUnitAuthority: base.nativeUnitAuthority,
    codec: base.codec, signingCodec: createSigningCodec(), walletRequests: { hasPendingRequest: () => false, startRequest: request },
    ledger: base.database.transactionLedgerStore() });
  const createReview = vi.fn(application.exchange.start);
  const domains: CardDomains = { exchange: {...application.exchange, start: createReview}, signing: application.signing,
    wallet: { prepareReview: unexpected, getReviewSource: () => {throw new Error("Unexpected Wallet source");}, discardPreparedReview: () => {},
      getAccountSelection: unexpected, selectAccount: unexpected, review: unexpected, decide: unexpected, get: unexpected, getPresentation: unexpected, cancel: unexpected },
    token: { prepareReview: unexpected, getReviewSource: () => {throw new Error("Unexpected Token source");}, discardPreparedReview: () => {},
      review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected Token read"); } } };
  const readPresentation = vi.fn(application.presentations.readPresentation);
  const cards = new PresentationCardApplication({ ownerSignal: new AbortController().signal, clock: base.deps.clock, store: base.database.presentationCardStore(),
    snapshots: base.database.presentationSnapshotStore(), reviews: { readPresentation }, domains, readExecution: { execute: unexpected } });
  await cards.initialize();
  closes.push(async () => { reply({ status: "wallet_rejected" }); await cards.close(); await application.close(); await base.close(); });
  const start = async () => {
    const created = await cards.startDecision({kind: "transaction", source: {kind: "new", input: base.input.request}}, new AbortController().signal);
    const state = await cards.get({kind: "card", cardId: created.cardId}).then((delivery) => delivery.presentation.state);
    if (state.record === null || state.record.kind !== "transaction") throw new Error("Transaction card required");
    const review = exchangeReviewSchema.parse(blocked ? await createReview.mock.results[0]!.value : application.exchange.get(state.record.operationId));
    return { review, record: state.record, context: { cardId: state.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") } };
  };
  return { base, cards, application, request, started, reply, response, readTransaction, readPresentation, transactions, start };
};

describe("transaction card handoff", () => {
  it("retains the original transaction source after a temporary RPC denial and sends only after fresh explicit input", async () => {
    const test = await setup(); const {review, record, context} = await test.start();
    if (review.state !== "ready_for_wallet_review") throw new Error("Ready fixture required.");
    vi.spyOn(test.transactions, "balance").mockRejectedValueOnce(new ChainOperationError("chain_response_unavailable"));
    await expect(test.cards.action(context, {review, initiatedBy: "mcp_app"}, new AbortController().signal))
      .rejects.toMatchObject({failure: {error: {code: "chain_response_unavailable"}}});
    expect(test.base.database.presentationCardStore().read(record.cardId)).toEqual(record);
    expect(test.application.exchange.get(record.operationId)).toEqual(review);
    expect(test.request).not.toHaveBeenCalled();
    void test.started.then(() => test.reply({status: "wallet_rejected"}));
    expect(await test.cards.action(context, {review, initiatedBy: "mcp_app"}, new AbortController().signal))
      .toMatchObject({result: {kind: "wallet_result", outcome: {status: "wallet_rejected"}}});
    expect(test.request).toHaveBeenCalledOnce();
  });

  it("retains a real blocked decision's state without its response-only request or a live slot", async () => {
    const test = await setup(true); const { review, record } = await test.start();
    expect(review.state).toBe("blocked");
    expect(record).toMatchObject({ inputState: "input_closed", closeReason: "invalidated", outcome: { kind: "review", state: "blocked" }, snapshotId: null });
    expect(record).not.toHaveProperty("request");
    expect(JSON.stringify(record)).not.toContain('"conditions":');
    const raw = new Database(test.base.path, { readonly: true });
    try { expect(raw.prepare("SELECT count(*) AS count FROM presentation_snapshot").get()).toEqual({ count: 0 }); }
    finally { raw.close(); }
    test.readPresentation.mockClear();
    expect(await test.cards.open({ cardId: record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static" });
    expect(test.readPresentation).not.toHaveBeenCalled(); expect(test.request).not.toHaveBeenCalled();
  });

  it("adopts an actual refresh-required response without enabling the old decision", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    if (review.state !== "ready_for_wallet_review") throw new Error("Ready fixture required");
    await test.cards.open(context).then((delivery) => delivery.presentation.state); test.base.replaceConnection();
    expect(await test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal).then((delivery) => delivery.result))
      .toMatchObject({ kind: "review", review: { state: "refresh_required" } });
    expect(test.base.database.presentationCardStore().read(record.cardId)).toMatchObject({inputState: "input_closed", closeReason: "invalidated", dispatchId: null,
      outcome: {kind: "review", state: "refresh_required"}});
    test.readPresentation.mockClear();
    expect(await test.cards.open({ cardId: record.cardId, cardOpenRequestId: Buffer.alloc(32, 89).toString("base64url") }).then((delivery) => delivery.presentation.state))
      .toMatchObject({ mode: "static", record: { outcome: { kind: "review", state: "refresh_required" } } });
    expect(test.readPresentation).not.toHaveBeenCalled(); expect(test.request).not.toHaveBeenCalled();
  });

  it("ends only the original wait, then records a late hash without receipt lookup or card resurrection", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    if (review.state !== "ready_for_wallet_review") throw new Error("Ready fixture required");
    await test.cards.open(context).then((delivery) => delivery.presentation.state);
    const result = test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal).then((delivery) => delivery.result);
    expect(await Promise.race([test.started.then(() => ({status: "started"})), result.then((value) => ({status: "result", value}))])).toEqual({status: "started"});
    expect((await test.cards.get({kind: "card", ...context})).presentation.actions).toEqual(["stop"]);
    let savedEnd: CardPresentation["state"] | undefined;
    const ending = test.cards.cancelWait({cardId: record.cardId}).then((delivery) => {savedEnd = delivery.presentation.state; return savedEnd;});
    void ending.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { expect(savedEnd).toMatchObject({mode: "static", record: {outcome: {kind: "transaction", result: {status: "delivery_unknown"}}}}); }
    catch (error) {test.reply({status: "wallet_rejected"}); await Promise.allSettled([ending, result]); throw error;}
    const ended = await ending;
    expect(await result).toMatchObject({ kind: "wallet_result", outcome: { status: "delivery_unknown" } });
    const readsBefore = test.readTransaction.mock.calls.length;
    const account = review.observation.data.intent.account;
    expect(test.base.database.transactionLedgerStore().read(account, test.base.hash)).toBeNull();
    test.reply({ status: "hash_returned", transactionHash: test.base.hash });
    await test.response; await new Promise<void>((resolve) => setImmediate(resolve));
    expect(test.base.database.transactionLedgerStore().read(account, test.base.hash)).not.toBeNull();
    expect(test.readTransaction).toHaveBeenCalledTimes(readsBefore);
    expect(await test.cards.get({ kind: "card", cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toEqual(ended);
    expect(test.request).toHaveBeenCalledOnce();
  });
});
