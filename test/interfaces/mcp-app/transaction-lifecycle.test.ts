import {stockTokenTradeHistoryAvailableFixture, stockTokenTradeHistoryGapFixture} from "../stock-token-trade-history-fixture.js";
import {stockTokenTradeHistoryHumanSummary} from "../../../src/interfaces/stock-token-trade-history-presentation.js";
import { normalizeRpcTransaction } from "../../../src/chain/normalization.js";
import { transactionRecordSections, transactionSectionsText } from "../../../src/interfaces/exchange-presentation.js";
import { presentationContracts } from "../../../src/interfaces/mcp-app/registry.js";
import { renderPresentation } from "../../../src/interfaces/mcp-app/view/renderers.js";
import {PresentationWorkBudget} from "../../../src/interfaces/presentation-work.js";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { fireEvent } from "@testing-library/dom";
import { createInterfaceFailure } from "../../../src/interfaces/http-client.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {createOwnerInstanceId} from "../../../src/runtime/runtime-identity.js";
import { createReceiptFixture } from "../../receipt-activity/fixture.js";
import { createReviewApplication } from "../../../src/review/application.js";
import { createSigningCodec } from "../../../src/chain/evm-standard.js";
import { exchangeReviewSchema } from "../../../src/review/contracts.js";
import { captureCanonicalJson } from "../../../src/core/index.js";
import { PresentationCardApplication } from "../../../src/interfaces/mcp-app/card-application.js";
import { cardActionEnvelopeSchema, cardControlContracts, serializeCardActionPresentation, cardPresentationMetadataKey, presentationCardMetadataKey } from "../../../src/interfaces/mcp-app/card-contract.js";
import { cardToolContracts } from "../../../src/interfaces/mcp-app/card-tool-contracts.js";
import {canonicalBase64FromBytes, presentationSnapshotChunkSchema, snapshotIdFromUri} from "../../../src/interfaces/mcp-app/contracts.js";
import {presentationSnapshotLimits} from "../../../src/runtime/presentation-snapshot.js";
import { withCardReference } from "../../../src/interfaces/mcp-app/server.js";
import { admitPresentationToolResult } from "../../../src/interfaces/mcp-app/view/lifecycle.js";
import { mountCard, createCardOpenRequestId } from "../../../src/interfaces/mcp-app/view/card-lifecycle.js";
import { activityToolContracts } from "../../../src/interfaces/exchange-tool-contracts.js";
import type { WalletRequestResponse } from "../../../src/wallet/request-contract.js";
import { receiptApplicationContracts } from "../../../src/receipt-activity/application-contracts.js";
import { createMcpToolResult } from "../../../src/interfaces/mcp-result.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: Pick<Window, "document" | "close"> & { HTMLElement: typeof HTMLElement; Event: typeof Event } };
};
let dom: InstanceType<typeof JSDOM>;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  vi.stubGlobal("document", dom.window.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

const fixture = async (options: { tools?: boolean; loseReply?: boolean; detailFailure?: "known" | "changed" | "missing" } = {}) => {
  const base = await createReceiptFixture();
  base.database.ownerStore().publishOwner(createOwnerInstanceId(), Buffer.alloc(32, 7).toString("base64url"), base.deps.clock.now());
  let reply!: (value: WalletRequestResponse) => void;
  let sent!: () => void;
  const walletResponse = new Promise<WalletRequestResponse>((resolve) => { reply = resolve; });
  const sentRequest = new Promise<void>((resolve) => { sent = resolve; });
  const send = vi.fn(async () => { sent(); return { response: walletResponse, settlement: walletResponse }; });
  const application = createReviewApplication({ preparation: { ...base.deps, transactions: base.transactions },
    receiptInvocationPorts: base.invocationPorts, nativeUnitAuthority: base.nativeUnitAuthority,
    codec: base.codec, signingCodec: createSigningCodec(), walletRequests: { hasPendingRequest: () => false, startRequest: send },
    ledger: base.database.transactionLedgerStore() });
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected domain call."); };
  const cards = new PresentationCardApplication({work: new PresentationWorkBudget(), ownerSignal: new AbortController().signal, readExecution: { execute: async () => { throw new Error("No chart read expected."); } }, clock: base.deps.clock, store: base.database.presentationCardStore(),
    snapshots: base.database.presentationSnapshotStore(), reviews: application.presentations,
    domains: { signing: application.signing, exchange: application.exchange,
      wallet: { prepareReview: unexpected, discardPreparedReview: () => {}, getReviewSource: () => { throw new Error("Unexpected wallet Review source."); }, getAccountSelection: unexpected, selectAccount: unexpected, review: unexpected, decide: unexpected, get: unexpected, getPresentation: unexpected, cancel: unexpected },
      token: { prepareReview: unexpected, discardPreparedReview: () => {}, getReviewSource: () => { throw new Error("Unexpected Token Review source."); }, review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected Token read."); } },
    } });
  const signal = new AbortController();
  const pendingActions: Promise<unknown>[] = [];
  cleanup.push(async () => { signal.abort(); reply({ status: "wallet_rejected" }); await cards.close();
    await Promise.allSettled(pendingActions); await application.close(); await base.close(); });
  const created = await cards.startDecision({kind: "transaction", source: {kind: "new", input: base.input.request}}, signal.signal);
  const record = base.database.presentationCardStore().read(created.cardId);
  if (record?.kind !== "transaction") throw new Error("Transaction card required.");
  const review = exchangeReviewSchema.parse(application.exchange.get(record.operationId));
  if (review.state !== "ready_for_wallet_review") throw new Error("Ready transaction required.");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.observation.data.createdAt));
  const creating = withCardReference({content: [], structuredContent: captureCanonicalJson(created) as Record<string, unknown>,
    _meta: {[presentationCardMetadataKey]: {kind: "card", cardId: created.cardId}}});
  let rejectReply: (error: Error) => void = () => { throw new Error("No pending response."); };
  const calls = vi.fn(async (request: { name: string; arguments?: Record<string, unknown> }, requestOptions?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number; resetTimeoutOnProgress?: boolean }): Promise<CallToolResult> => {
    let value: unknown;
    let metadata: Record<string, unknown> = {};
    const key = (Object.keys(cardToolContracts) as (keyof typeof cardToolContracts)[]).find((key) => request.name === cardToolContracts[key].mcp.name);
    if (key !== undefined) {
      const input = cardControlContracts[key].parseInput(request.arguments);
      const delivery = key === "read" ? await cards.get(input) : key === "open" ? await cards.open(input)
        : key === "discard" ? await cards.cancelDecision(input) : await cards.cancelWait(input);
      value = delivery.presentation;
    } else if (request.name === "presentation_get_snapshot_chunk") {
      const source = application.presentations.readPresentation(record.operationId);
      if (source.status !== "available" || snapshotIdFromUri(request.arguments?.["snapshotUri"]) !== source.value.snapshot.snapshotId) throw new Error("Exact temporary source required.");
      const index = request.arguments?.["index"];
      if (typeof index !== "number") throw new Error("Chunk index required.");
      value = presentationSnapshotChunkSchema.parse({kind: "presentation_snapshot_chunk", snapshotId: source.value.snapshot.snapshotId, index,
        canonicalBase64: canonicalBase64FromBytes(source.value.snapshot.resultBytes.slice(index * presentationSnapshotLimits.resultChunkBytes,
          (index + 1) * presentationSnapshotLimits.resultChunkBytes))});
    } else if (request.name === "exchange_request_transaction") {
      const envelope = cardActionEnvelopeSchema.parse(request.arguments);
      const pending = cards.action({ cardId: envelope.cardId, cardOpenRequestId: envelope.cardOpenRequestId }, envelope.decision, requestOptions?.signal ?? signal.signal);
      pendingActions.push(pending);
      if (options.loseReply) {
        void pending.catch(() => undefined);
        return new Promise((_resolve, reject) => { rejectReply = reject; });
      }
      const delivery = await pending;
      value = delivery.result;
      metadata = { [cardPresentationMetadataKey]: serializeCardActionPresentation(delivery.presentation) };
    } else if (request.name === activityToolContracts.get.mcp.name) {
      if (options.detailFailure !== undefined && options.detailFailure !== "missing") {
        const failure = createInterfaceFailure("runtime_state_unavailable");
        return { isError: true, content: [], structuredContent: captureCanonicalJson(options.detailFailure === "known" ? failure
          : { ...failure, error: { ...failure.error, message: "untrusted detail error" } }) as Record<string, unknown> };
      }
      value = options.detailFailure === "missing" ? null : application.activity.get(receiptApplicationContracts.get.parseInput(request.arguments));
    }
    else throw new Error("No unrelated query or Wallet request is allowed.");
    return { ...createMcpToolResult(request.name, captureCanonicalJson(value), false), _meta: metadata };
  });
  const app = { getHostCapabilities: () => options.tools === false ? {} : { serverTools: {} },
    getHostVersion: () => ({ name: "standard", version: "1" }), callServerTool: calls,
    readServerResource: unexpected };
  const admission = await admitPresentationToolResult(app, creating, signal.signal);
  if (admission.status !== "card") throw new Error("Card admission required.");
  await mountCard(app, admission.card, createCardOpenRequestId(), document.body, signal.signal);
  return { base, application, cards, calls, send, sentRequest, reply,
    rejectReply: () => rejectReply(new Error("Lost response")),
    accept: () => fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Request wallet approval")!),
  };
};

describe("transaction card View", () => {
  it.each(["known", "changed", "missing"] as const)("preserves the received hash when its detail read is %s", async (detailFailure) => {
    const test = await fixture({ detailFailure });
    test.accept(); await test.sentRequest;
    test.reply({ status: "hash_returned", transactionHash: test.base.hash });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Details unavailable"));
    expect(document.body.textContent).toContain("Not confirmed");
    expect(document.body.textContent).toContain("A transaction hash was received. Execution has not been confirmed.");
    expect(document.body.textContent).toContain("Some details could not be displayed. The confirmed information is still shown.");
    expect(document.body.textContent).not.toMatch(/Request failed|Succeeded|Transaction failed/u);
    expect(document.body.textContent).toContain(test.base.hash);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelectorAll("article.card article.card")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("untrusted detail error");
    if (detailFailure === "known") {
      expect(document.body.textContent).toContain("runtime_state_unavailable");
      expect(document.body.textContent).toContain("Local runtime state is unavailable.");
    } else expect(document.body.textContent).not.toContain("runtime_state_unavailable");
    expect(test.send).toHaveBeenCalledOnce();
    expect(test.calls.mock.calls.filter(([call]) => call.name === "activity_get_transaction")).toHaveLength(1);
  });

  it("shows the original recorded result after one decision using only the local activity read", async () => {
    const test = await fixture();
    expect(test.send).not.toHaveBeenCalled(); test.accept(); await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce());
    test.reply({ status: "hash_returned", transactionHash: test.base.hash });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Request check: Matches. Effect check: Matches."));
    expect(document.body.textContent).toContain("Gas charged:");
    expect(test.calls.mock.calls.filter(([call]) => call.name === "exchange_request_transaction")).toHaveLength(1);
    expect(test.calls.mock.calls.filter(([call]) => call.name === "activity_get_transaction")).toHaveLength(1);
    expect(test.send).toHaveBeenCalledOnce();
  });
  it("uses the owned response window and preserves admitted work when only its direct response is lost", async () => {
    const test = await fixture({ loseReply: true });
    test.accept(); await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce());
    expect(document.body.textContent).toContain("Submitting…");
    expect(document.body.textContent).not.toContain("Waiting for wallet approval");
    const call = test.calls.mock.calls.find(([call]) => call.name === "exchange_request_transaction")!;
    // The Review's five minutes plus the separately owned 89-second initial lookup.
    expect(call[1]).toMatchObject({ timeout: 389_000, maxTotalTimeout: 389_000, resetTimeoutOnProgress: false });
    test.rejectReply();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Reload saved card"]));
    expect(test.calls.mock.calls.filter(([call]) => call.name === "presentation_cancel_wait")).toHaveLength(0);
    const cardId = cardActionEnvelopeSchema.parse(call[0].arguments).cardId;
    expect((await test.cards.get({ kind: "card", cardId })).presentation.state.record).toMatchObject({ inputState: "input_closed", closeReason: "submitted", outcome: null });
    [...document.querySelectorAll("button")].find(button => button.textContent === "Reload saved card")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Checking result…"));
    expect(document.body.textContent).toContain("Your request was accepted. Its result has not been confirmed yet.");
    expect(document.body.textContent).not.toMatch(/Completed|Request ended|Waiting for wallet approval/u);
    expect(test.send).toHaveBeenCalledOnce();
    test.reply({ status: "wallet_rejected" });
    await vi.waitFor(async () => expect((await test.cards.get({ kind: "card", cardId })).presentation.state.record)
      .toMatchObject({ inputState: "input_closed", outcome: { kind: "transaction", result: { status: "wallet_rejected" } } }));
    expect(test.send).toHaveBeenCalledOnce();
  });
  it("does not expose an action without the Host control capability", async () => {
    const test = await fixture({ tools: false });
    expect(test.calls).not.toHaveBeenCalled(); expect(test.send).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Unavailable");
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("stored results and user next actions", () => {
  it("distinguishes complete empty intervals from partial and unavailable gaps without inventing no trades", async () => {
    for (const value of [stockTokenTradeHistoryAvailableFixture(), await stockTokenTradeHistoryGapFixture()]) {
      const data = value.data;
      if (data.status !== "available") throw new Error("Available history fixture required.");
      const entry = presentationContracts.stockTokenTradeHistory;
      const admitted = entry.parseResult(entry.parseInput({symbol: data.symbol, period: data.period}), value);
      const before = captureCanonicalJson(admitted);
      const rendered = renderPresentation(entry, admitted).node;
      const details = [...rendered.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "Chart data")!;
      details.open = true; details.dispatchEvent(new dom.window.Event("toggle"));
      const rows = [...details.querySelectorAll("tbody tr")];
      const expectations = {
        complete: "No qualifying trades occurred in this complete interval.",
        partial: "Data is incomplete for this interval. No-trade status is not confirmed.",
        unavailable: "Published data is unavailable for this interval. No-trade status is not confirmed.",
      } as const;
      for (const coverage of ["complete", "partial", "unavailable"] as const) {
        const index = data.positions.findIndex(position => position.coverage === coverage && position.candle === null);
        if (index < 0) continue;
        expect(rows[index]?.textContent).toContain(expectations[coverage]);
        if (coverage !== "complete") expect(rows[index]?.textContent).not.toContain("No qualifying trades occurred");
      }
      if (data.period.unit === "year") {
        expect(data.positions.some(position => position.coverage === "partial" && position.candle === null)).toBe(true);
        expect(data.positions.some(position => position.coverage === "unavailable" && position.candle === null)).toBe(true);
        expect(data.positions.every(position => position.candle === null)).toBe(true);
        expect(stockTokenTradeHistoryHumanSummary(data, value.meta.evaluatedAt)).toContain("No-trade status is not confirmed for the entire requested period.");
        expect(rendered.textContent).not.toContain("No qualifying trades occurred in the requested period.");
      } else expect(data.positions.some(position => position.coverage === "complete" && position.candle === null)).toBe(true);
      expect(captureCanonicalJson(admitted)).toEqual(before);
    }
  });

  it("offers pending-query guidance for the exact individual record without inspecting again or leaking App instructions to text", async () => {
    const fixture = await createReceiptFixture();
    try {
      const pending = normalizeRpcTransaction({...fixture.tx, blockHash: null, blockNumber: null, transactionIndex: null}, fixture.reference.account.chainId);
      let reads = 0;
      fixture.transactions.readTransaction = async () => { reads++; return {status: "pending", transaction: pending}; };
      fixture.receive();
      const subject = {account: fixture.reference.account, transactionHash: fixture.hash};
      const controller = new AbortController();
      const query = fixture.activity.inspect(subject.account, subject.transactionHash, controller.signal);
      await vi.waitFor(() => expect(fixture.activity.get(subject.account, subject.transactionHash)?.inspection?.data.status).toBe("pending"));
      controller.abort();
      await query;
      const record = fixture.activity.get(subject.account, subject.transactionHash);
      const before = captureCanonicalJson(record);
      const entry = presentationContracts.activityTransaction;
      const admitted = entry.parseResult(entry.parseInput(subject), record);
      const readCount = reads;
      for (let view = 0; view < 2; view++) {
        const rendered = renderPresentation(entry, admitted);
        expect(rendered.node.textContent).toContain("The transaction is pending according to the recorded network response.");
        expect(rendered.node.textContent).toContain("Ask in chat to check the current result for this transaction.");
        expect(rendered.node.textContent).toContain(fixture.hash);
        expect(rendered.node.textContent).toContain(subject.account.address);
        expect(rendered.node.querySelectorAll("button")).toHaveLength(0);
      }
      expect(reads).toBe(readCount);
      expect(captureCanonicalJson(fixture.activity.get(subject.account, subject.transactionHash))).toEqual(before);
      expect(transactionSectionsText(transactionRecordSections(record))).not.toContain("Ask in chat");
      const page = fixture.activity.list(subject.account);
      const listed = renderPresentation(presentationContracts.activityTransactions, captureCanonicalJson(page));
      expect(listed.node.textContent).not.toContain("Ask in chat");
      expect(listed.node.textContent).toContain("Pending");
    } finally { await fixture.close(); }
  });
});
