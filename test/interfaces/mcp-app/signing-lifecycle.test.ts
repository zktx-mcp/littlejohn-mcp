import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fireEvent } from "@testing-library/dom";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createSigningFixture, command, signer, message } from "../../review/signing-fixture.js";
import { captureCanonicalJson } from "../../../src/core/index.js";
import { signingDirectDecisionSchema } from "../../../src/review/signing-contracts.js";
import { signingSignatureMetadataKey } from "../../../src/interfaces/signing-result.js";
import { presentationContracts } from "../../../src/interfaces/mcp-app/registry.js";
import { mountSigningReview } from "../../../src/interfaces/mcp-app/view/signing-lifecycle.js";
import { renderPresentation } from "../../../src/interfaces/mcp-app/view/renderers.js";

// Keep the real Node backend and its entropy in Node's realm. Only the App's
// document is browser-owned; values cross as admitted JSON, as in the product.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: Pick<Window, "document" | "navigator" | "close"> & { HTMLElement: typeof HTMLElement } };
};
let dom: InstanceType<typeof JSDOM>;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

const fixture = async (carriage: "intact" | "missing" | "changed" = "intact") => {
  const source = createSigningFixture();
  const signal = new AbortController();
  const review = await source.coordinator.start(command, signal.signal);
  const admitted = { entry: presentationContracts.signingReview, normalizedInput: captureCanonicalJson(command), result: captureCanonicalJson(review) };
  const rendered = renderPresentation(admitted.entry, admitted.result);
  document.body.replaceChildren(rendered.node);
  const calls = vi.fn(async (request: { name: string; arguments?: unknown }): Promise<CallToolResult> => {
    if (request.name === "signing_get_review") return { content: [], structuredContent: captureCanonicalJson({ operationId: review.operationId, review: source.coordinator.get(review.operationId) }) as Record<string, unknown> };
    if (request.name === "signing_request_signature") {
      const completion = await source.coordinator.confirm(signingDirectDecisionSchema.parse(request.arguments), signal.signal);
      return { content: [], structuredContent: captureCanonicalJson(completion.outcome) as Record<string, unknown>,
        ...("signature" in completion && carriage !== "missing" ? { _meta: {
          [signingSignatureMetadataKey]: carriage === "changed" ? `0x${"11".repeat(64)}1b` : completion.signature,
        } } : {}),
      };
    }
    throw new Error("No signature lookup or unrelated tool is permitted.");
  });
  const app = { getHostCapabilities: () => ({ serverTools: {} }), getHostVersion: () => ({ name: "standard", version: "1" }),
    callServerTool: calls, readServerResource: async (): Promise<never> => { throw new Error("No snapshot read during signing."); } };
  await mountSigningReview(app, admitted, rendered.node, signal.signal);
  return { source, signal, calls, review, app, admitted,
    accept: () => fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Request signature in Wallet")!),
    close: async () => { signal.abort(); await source.close(); document.body.replaceChildren(); vi.restoreAllMocks(); },
  };
};

describe("direct App signature delivery", () => {
  it("requires a click, checks the private pair, supports manual copy and erases the dismissed panel", async () => {
    const test = await fixture();
    try {
      expect(test.source.startRequest).not.toHaveBeenCalled();
      test.accept();
      await test.source.sent;
      const signature = await signer.signMessage({ message });
      test.source.reply({ status: "signature_returned", signature });
      await vi.waitFor(() => expect(document.body.textContent).toContain(signature));
      expect(document.querySelector(".operation-region .status-pending")).toBeNull();
      const copy = [...document.querySelectorAll("button")].find((node) => node.textContent === "Copy signature")!;
      const writeText = vi.fn(async () => { throw new Error("Clipboard unavailable."); });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      fireEvent.click(copy);
      await vi.waitFor(() => expect(document.body.textContent).toContain("copy it manually"));
      expect(writeText).toHaveBeenCalledWith(signature);
      const dismiss = [...document.querySelectorAll("button")].find((node) => node.textContent === "Dismiss signature")!;
      fireEvent.click(dismiss);
      expect(document.body.textContent).not.toContain(signature);
      expect(test.source.startRequest).toHaveBeenCalledOnce();
      const reopened = renderPresentation(test.admitted.entry, test.admitted.result);
      document.body.replaceChildren(reopened.node);
      await mountSigningReview(test.app, test.admitted, reopened.node, test.signal.signal);
      expect(document.body.textContent).toContain("Decision unavailable");
      expect(document.body.textContent).not.toContain(signature);
    } finally { Reflect.deleteProperty(navigator, "clipboard"); await test.close(); }
  });

  it.each(["missing", "changed"] as const)("refuses %s private carriage with the public verification fixed", async (carriage) => {
    const test = await fixture(carriage);
    try {
      test.accept(); await test.source.sent;
      const signature = await signer.signMessage({ message });
      test.source.reply({ status: "signature_returned", signature });
      await vi.waitFor(() => expect(document.body.textContent).toContain("Signature delivery unavailable"));
      expect(document.body.textContent).not.toContain(signature);
      expect(document.querySelectorAll("button")).toHaveLength(0);
      expect(test.source.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });

  it.each(["stop", "teardown"] as const)("cannot repopulate after %s and a later signature", async (ending) => {
    const test = await fixture();
    try {
      test.accept(); await test.source.sent;
      if (ending === "stop") fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Stop waiting")!);
      else test.signal.abort();
      const signature = await signer.signMessage({ message });
      test.source.reply({ status: "signature_returned", signature });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(document.body.textContent).not.toContain(signature);
      expect(test.source.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });
});
