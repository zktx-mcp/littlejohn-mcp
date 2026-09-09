// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent } from "@testing-library/dom";
import { createExchangeFixture } from "../../review/fixture.js";
import { createReceiptFixture } from "../../receipt-activity/fixture.js";
import { observeExchange } from "../../../src/review/preparation.js";
import { createReadyExchangeReview } from "../../../src/review/contracts.js";
import { captureCanonicalJson } from "../../../src/core/index.js";
import { presentationContracts } from "../../../src/interfaces/mcp-app/registry.js";
import { renderPresentation } from "../../../src/interfaces/mcp-app/view/renderers.js";
import { mountTransactionReview } from "../../../src/interfaces/mcp-app/view/transaction-lifecycle.js";
import { exchangeToolContracts, activityToolContracts } from "../../../src/interfaces/exchange-tool-contracts.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const fixture = async () => {
  const base = createExchangeFixture();
  const produced = await observeExchange(base.deps, base.input, new AbortController().signal);
  if (!produced.ok) throw new Error("Ready fixture required.");
  const review = createReadyExchangeReview(produced.review);
  const admitted = { entry: presentationContracts.transactionReview, normalizedInput: captureCanonicalJson(base.input.request), result: captureCanonicalJson(review) };
  const rendered = renderPresentation(admitted.entry, admitted.result);
  document.body.replaceChildren(rendered.node);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.observation.data.createdAt));
  return { base, review, admitted, rendered };
};
describe("temporary transaction View", () => {
  it("shows the recorded actual result after a hash using only the local activity read", async () => {
    const test = await createReceiptFixture();
    const signal = new AbortController();
    try {
      test.receive();
      await test.activity.inspect(test.reference.account, test.hash, signal.signal);
      const record = test.activity.get(test.reference.account, test.hash);
      const review = createReadyExchangeReview(test.original.review);
      const admitted = { entry: presentationContracts.transactionReview, normalizedInput: captureCanonicalJson(test.input.request), result: captureCanonicalJson(review) };
      const rendered = renderPresentation(admitted.entry, admitted.result);
      document.body.replaceChildren(rendered.node);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.observation.data.createdAt));
      const calls = vi.fn(async (request: { name: string }): Promise<CallToolResult> => {
        const value = request.name === exchangeToolContracts.get.mcp.name ? review :
          request.name === exchangeToolContracts.request.mcp.name ? { kind: "wallet_result", outcome: { status: "hash_returned", transactionHash: test.hash, recording: "recorded", lookup: "completed" } } :
            request.name === activityToolContracts.get.mcp.name ? record : undefined;
        if (value === undefined) throw new Error("No additional result query or Wallet request is allowed.");
        return { content: [], structuredContent: captureCanonicalJson(value) as Record<string, unknown> };
      });
      await mountTransactionReview({ getHostCapabilities: () => ({ serverTools: {} }), getHostVersion: () => ({ name: "standard", version: "1" }),
        callServerTool: calls, readServerResource: async (): Promise<never> => { throw new Error("No resource lookup."); } }, admitted, rendered.node, signal.signal);
      fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Request in Wallet")!);
      await vi.waitFor(() => expect(document.body.textContent).toContain("Reviewed request: matched. Reviewed effects: matched."));
      expect(document.body.textContent).toContain("Gas charged:");
      expect(calls.mock.calls.map(([request]) => request.name)).toEqual([
        "exchange_get_review", "exchange_request_transaction", "activity_get_transaction",
      ]);
    } finally { signal.abort(); await test.close(); vi.restoreAllMocks(); document.body.replaceChildren(); }
  });
  it("requires direct controls, sends once, uses the complete response window and never retries a lost result", async () => {
    const test = await fixture();
    const signal = new AbortController();
    let reject!: (reason: unknown) => void;
    const response = new Promise<CallToolResult>((_resolve, fail) => { reject = fail; });
    const calls = vi.fn(async (request: { name: string }, _options?: unknown): Promise<CallToolResult> => {
      if (request.name === exchangeToolContracts.get.mcp.name) return { content: [], structuredContent: captureCanonicalJson(test.review) as Record<string, unknown> };
      if (request.name === exchangeToolContracts.request.mcp.name) return response;
      throw new Error("Unexpected transaction action.");
    });
    const app = { getHostCapabilities: () => ({ serverTools: {} }), getHostVersion: () => ({ name: "standard", version: "1" }),
      callServerTool: calls, readServerResource: async (): Promise<never> => { throw new Error("No snapshot rediscovery."); } };
    try {
      await mountTransactionReview(app, test.admitted, test.rendered.node, signal.signal);
      const accept = [...document.querySelectorAll("button")].find((node) => node.textContent === "Request in Wallet")!;
      fireEvent.click(accept); fireEvent.click(accept);
      expect(calls.mock.calls.filter(([request]) => request.name === exchangeToolContracts.request.mcp.name)).toHaveLength(1);
      expect(calls.mock.calls.at(-1)?.[1]).toMatchObject({ timeout: 389000, maxTotalTimeout: 389000, resetTimeoutOnProgress: false });
      reject(new Error("Lost response"));
      await vi.waitFor(() => expect(document.body.textContent).toContain("Signing and broadcast are unknown"));
      expect(calls).toHaveBeenCalledTimes(2);
      expect(document.querySelectorAll("button")).toHaveLength(0);
    } finally { signal.abort(); await test.base.close(); vi.restoreAllMocks(); document.body.replaceChildren(); }
  });
  it("never offers an action without the Host control capability", async () => {
    const test = await fixture();
    const signal = new AbortController();
    const calls = vi.fn(async (): Promise<never> => { throw new Error("No Host tool authority."); });
    try {
      await mountTransactionReview({ getHostCapabilities: () => ({}), getHostVersion: () => ({ name: "standard", version: "1" }),
        callServerTool: calls, readServerResource: calls }, test.admitted, test.rendered.node, signal.signal);
      expect(calls).not.toHaveBeenCalled(); expect(document.querySelectorAll("button")).toHaveLength(0);
      expect(document.body.textContent).toContain("Direct controls unavailable");
    } finally { signal.abort(); await test.base.close(); vi.restoreAllMocks(); document.body.replaceChildren(); }
  });
});
