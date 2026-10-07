import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { fireEvent } from "@testing-library/dom";
import { createInterfaceFailure } from "../../../src/interfaces/http-client.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createReceiptFixture } from "../../receipt-activity/fixture.js";
import { createReviewApplication } from "../../../src/review/application.js";
import { createSigningCodec } from "../../../src/chain/evm-standard.js";
import { exchangeReviewSchema } from "../../../src/review/contracts.js";
import { captureCanonicalJson, canonicalJsonStringify } from "../../../src/core/index.js";
import { PresentationCardApplication } from "../../../src/interfaces/mcp-app/card-application.js";
import { cardActionEnvelopeSchema, cardControlContracts, serializeCardActionPresentation, cardPresentationMetadataKey, presentationCardMetadataKey } from "../../../src/interfaces/mcp-app/card-contract.js";
import { cardToolContracts } from "../../../src/interfaces/mcp-app/card-tool-contracts.js";
import { presentationContracts } from "../../../src/interfaces/mcp-app/registry.js";
import { McpAppPresentationService, createMcpAppResource } from "../../../src/interfaces/mcp-app/server.js";
import { admitPresentationToolResult } from "../../../src/interfaces/mcp-app/view/lifecycle.js";
import { mountCard, createCardOpenRequestId } from "../../../src/interfaces/mcp-app/view/card-lifecycle.js";
import { activityToolContracts } from "../../../src/interfaces/exchange-tool-contracts.js";
import type { WalletRequestResponse } from "../../../src/wallet/request-contract.js";
import { receiptApplicationContracts } from "../../../src/receipt-activity/application-contracts.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: Pick<Window, "document" | "close"> & { HTMLElement: typeof HTMLElement } };
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

const fixture = async (options: { tools?: boolean; loseReply?: boolean; detailFailure?: "known" | "changed" } = {}) => {
  const base = await createReceiptFixture();
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
  const cards = new PresentationCardApplication({ ownerSignal: new AbortController().signal, readExecution: { execute: async () => { throw new Error("No chart read expected."); } }, clock: base.deps.clock, store: base.database.presentationCardStore(),
    snapshots: base.database.presentationSnapshotStore(), reviews: application.presentations,
    domains: { signing: application.signing, exchange: application.exchange,
      wallet: { review: unexpected, decide: unexpected, get: unexpected, getPresentation: unexpected, cancel: unexpected },
      token: { review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected Token read."); } },
    } });
  const signal = new AbortController();
  const pendingActions: Promise<unknown>[] = [];
  cleanup.push(async () => { signal.abort(); reply({ status: "wallet_rejected" }); await cards.close();
    await Promise.allSettled(pendingActions); await application.close(); await base.close(); });
  const created = await cards.startReview("transaction", base.input.request, signal.signal);
  const review = exchangeReviewSchema.parse(created.value);
  if (review.state !== "ready_for_wallet_review") throw new Error("Ready transaction required.");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.observation.data.createdAt));
  const service = new McpAppPresentationService(base.database.presentationSnapshotStore(), createMcpAppResource("<!doctype html><title>Test</title>"), { read: unexpected }, async (input) => cards.getReference(input));
  const presented = await service.present(presentationContracts.transactionReview.contract, base.input.request,
    { content: [{ type: "text", text: canonicalJsonStringify(created.value) }], structuredContent: created.value as Record<string, unknown>,
      _meta: { [presentationCardMetadataKey]: created.reference } });
  if (presented.status !== "available") throw new Error("Creating card required.");
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
      if (options.detailFailure !== undefined) {
        const failure = createInterfaceFailure("runtime_state_unavailable");
        return { isError: true, content: [], structuredContent: captureCanonicalJson(options.detailFailure === "known" ? failure
          : { ...failure, error: { ...failure.error, message: "untrusted detail error" } }) as Record<string, unknown> };
      }
      value = application.activity.get(receiptApplicationContracts.get.parseInput(request.arguments));
    }
    else throw new Error("No unrelated query or Wallet request is allowed.");
    return { content: [], structuredContent: captureCanonicalJson(value) as Record<string, unknown>, _meta: metadata };
  });
  const app = { getHostCapabilities: () => options.tools === false ? {} : { serverTools: {} },
    getHostVersion: () => ({ name: "standard", version: "1" }), callServerTool: calls,
    readServerResource: unexpected };
  const creating = presented.delivery.result;
  const admission = await admitPresentationToolResult(app, creating, signal.signal);
  if (admission.status !== "card") throw new Error("Card admission required.");
  await mountCard(app, admission.card, creating, createCardOpenRequestId(), document.body, signal.signal);
  return { base, application, cards, calls, send, sentRequest, reply,
    rejectReply: () => rejectReply(new Error("Lost response")),
    accept: () => fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Request in Wallet")!),
  };
};

describe("transaction card View", () => {
  it.each(["known", "changed"] as const)("preserves the received hash when its detail read has a %s failure", async (detailFailure) => {
    const test = await fixture({ detailFailure });
    test.accept(); await test.sentRequest;
    test.reply({ status: "hash_returned", transactionHash: test.base.hash });
    await vi.waitFor(() => expect(document.body.textContent).toContain(detailFailure === "known" ? "Request failed" : "Stored result unavailable"));
    expect(document.body.textContent).toContain(test.base.hash);
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
    await vi.waitFor(() => expect(document.body.textContent).toContain("Reviewed request: matched. Reviewed effects: matched."));
    expect(document.body.textContent).toContain("Gas charged:");
    expect(test.calls.mock.calls.filter(([call]) => call.name === "exchange_request_transaction")).toHaveLength(1);
    expect(test.calls.mock.calls.filter(([call]) => call.name === "activity_get_transaction")).toHaveLength(1);
    expect(test.send).toHaveBeenCalledOnce();
  });
  it("uses the owned response window and preserves admitted work when only its direct response is lost", async () => {
    const test = await fixture({ loseReply: true });
    test.accept(); await vi.waitFor(() => expect(test.send).toHaveBeenCalledOnce());
    const call = test.calls.mock.calls.find(([call]) => call.name === "exchange_request_transaction")!;
    // The Review's five minutes plus the separately owned 89-second initial lookup.
    expect(call[1]).toMatchObject({ timeout: 389_000, maxTotalTimeout: 389_000, resetTimeoutOnProgress: false });
    test.rejectReply();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Read saved state again"]));
    expect(test.calls.mock.calls.filter(([call]) => call.name === "presentation_cancel_wait")).toHaveLength(0);
    const cardId = cardActionEnvelopeSchema.parse(call[0].arguments).cardId;
    expect((await test.cards.get({ kind: "card", cardId })).presentation.state.record).toMatchObject({ phase: "pending", outcome: null });
    test.reply({ status: "wallet_rejected" });
    await vi.waitFor(async () => expect((await test.cards.get({ kind: "card", cardId })).presentation.state.record)
      .toMatchObject({ phase: "closed", outcome: { kind: "transaction", result: { status: "wallet_rejected" } } }));
    expect(test.send).toHaveBeenCalledOnce();
  });
  it("does not expose an action without the Host control capability", async () => {
    const test = await fixture({ tools: false });
    expect(test.calls).not.toHaveBeenCalled(); expect(test.send).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Direct controls unavailable");
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
});
