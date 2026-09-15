import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductDatabase } from "../../../src/runtime/database.js";
import { PresentationCardApplication } from "../../../src/interfaces/mcp-app/card-application.js";
import { presentationCardMetadataKey, cardPresentationMetadataKey } from "../../../src/interfaces/mcp-app/card-contract.js";
import { McpAppPresentationService, createMcpAppResource } from "../../../src/interfaces/mcp-app/server.js";
import { mountCard, createCardOpenRequestId } from "../../../src/interfaces/mcp-app/view/card-lifecycle.js";
import { admitPresentationToolResult } from "../../../src/interfaces/mcp-app/view/lifecycle.js";
import { canonicalJsonStringify, parseUtcTimestamp } from "../../../src/core/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fireEvent } from "@testing-library/dom";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createSigningFixture, command, signer, message } from "../../review/signing-fixture.js";
import { captureCanonicalJson } from "../../../src/core/index.js";
import { signingReviewSchema } from "../../../src/review/signing-contracts.js";
import { signingSignatureMetadataKey } from "../../../src/interfaces/signing-result.js";
import { presentationContracts } from "../../../src/interfaces/mcp-app/registry.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../../src/interfaces/mcp.js";
import { LocalOperationClient } from "../../../src/interfaces/operation-client.js";
import type { RuntimeDispatchPort } from "../../../src/interfaces/http-client.js";
import { extendCardRoutes, cardControlResources } from "../../../src/interfaces/mcp-app/card-controls.js";
import { extendReviewPresentationRoutes } from "../../../src/interfaces/review-presentation-routes.js";
import { createRuntimeRouteRegistry } from "../../../src/runtime/http-routing.js";
import { loadOrCreateControlCredential, createControlCredentialVerifier } from "../../../src/runtime/control-credential.js";
import { openTestOwnerSession } from "../owner-session-harness.js";

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

const fixture = async (carriage: "intact" | "missing" | "changed" = "intact", options: {
  holdReply?: boolean; malformedFailure?: boolean;
  delayedReadFailure?: "known" | "transport"; missingState?: boolean; failTerminalWrite?: boolean; loseActionResponse?: boolean;
} = {}) => {
  const source = createSigningFixture();
  const directory = await mkdtemp(join(tmpdir(), "littlejohn-card-view-"));
  const database = await ProductDatabase.open(join(directory, "product.sqlite3"), parseUtcTimestamp(source.clock.now()));
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected domain call."); };
  const store = database.presentationCardStore();
  const cards = new PresentationCardApplication({ ownerSignal: new AbortController().signal, readExecution: { execute: async () => { throw new Error("No chart read expected."); } }, clock: source.clock,
    store: { ...store, replace(before, after) {
      if (options.failTerminalWrite && after.outcome?.kind === "signing") throw new Error("The terminal card write failed.");
      return store.replace(before, after);
    } },
    snapshots: database.presentationSnapshotStore(), reviews: source.materials,
    domains: {
      signing: { start: source.coordinator.start.bind(source.coordinator), confirm: source.coordinator.confirm.bind(source.coordinator),
        cancel: source.coordinator.cancel.bind(source.coordinator), get: (operationId) => ({ operationId, review: source.coordinator.get(operationId) }) },
      wallet: { review: unexpected, decide: unexpected, get: unexpected, getPresentation: unexpected, cancel: unexpected },
      token: { review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected Token read."); } },
      exchange: { start: unexpected, confirm: unexpected, get: () => { throw new Error("Unexpected transaction read."); }, cancel: () => { throw new Error("Unexpected transaction cancellation."); } },
    } });
  const signal = new AbortController();
  const controllers = [signal];
  const created = await cards.startReview("signing", command, signal.signal);
  const review = signingReviewSchema.parse(created.value);
  const service = new McpAppPresentationService(database.presentationSnapshotStore(), createMcpAppResource("<!doctype html><title>Test</title>"), {
    read: async () => { throw new Error("No temporary body read before card-state admission."); },
  }, async (input) => cards.getReference(input));
  const response = await service.present(presentationContracts.signingReview.contract, command, {
    content: [{ type: "text", text: canonicalJsonStringify(created.value) }], structuredContent: created.value as Record<string, unknown>,
    _meta: { [presentationCardMetadataKey]: created.reference },
  });
  if (response.status !== "available") throw new Error("Creating card delivery failed.");
  const creatingResult = response.delivery.result;
  const nativePaths: string[] = [];
  let interruptedControl: { path: string; delivery: "not_sent" | "reply_lost" } | undefined;
  let failedHostCall: string | undefined;
  const credential = await loadOrCreateControlCredential(directory, join(directory, "control.key"));
  const routes = extendCardRoutes(extendReviewPresentationRoutes(
    createRuntimeRouteRegistry({ controlVerifier: createControlCredentialVerifier(credential) }), source.materials), cards);
  const runtime: RuntimeDispatchPort = { async dispatchRuntimeRequest(request) {
    nativePaths.push(request.path);
    if (request.signal === undefined) throw new Error("Native card request signal is required.");
    const match = routes.match(request.method, request.path);
    if (match.status !== "matched") throw new Error("Unexpected native signing route.");
    const result = routes.normalizeResult(match.route, await match.route.handler({ params: match.params, query: "",
      body: request.method === "POST" ? request.body : undefined, signal: request.signal }));
    return result.ok ? { status: match.route.successStatus, body: result.body }
      : { status: result.problem.status, body: captureCanonicalJson(result.problem) };
  } };
  const ownerSessions = { async openOwnerSession(signal?: AbortSignal) {
    const session = await openTestOwnerSession(runtime, signal);
    return {
      identity: session.identity,
      get usable() { return session.usable; },
      close: () => session.close(),
      async send(request: Parameters<typeof session.send>[0], callerSignal?: AbortSignal) {
        const interruption = interruptedControl?.path === request.path ? interruptedControl : undefined;
        if (interruption !== undefined) interruptedControl = undefined;
        if (interruption?.delivery === "not_sent") return { status: "request_not_sent" as const, reason: "owner_unavailable" as const };
        const sent = await session.send(request, callerSignal);
        return interruption?.delivery === "reply_lost" || (options.loseActionResponse && request.path === cardControlResources.action)
          ? { status: "response_unavailable_after_send_began" as const } : sent;
      },
    };
  } };
  const local = new LocalOperationClient({ ownerSessions });
  const server = createMcpServer({ ...runtime, ...ownerSessions, presentationSnapshotStore: () => database.presentationSnapshotStore() }, local,
    createMcpAppResource("<!doctype html><title>Test</title>"));
  const client = new Client({ name: "signing-view-test", version: "1" }, { capabilities: {
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  let releaseReply!: () => void;
  const replyGate = new Promise<void>((resolve) => { releaseReply = resolve; });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  let readEntered!: (result: CallToolResult) => void;
  const delayedReadStarted = new Promise<CallToolResult>((resolve) => { readEntered = resolve; });
  let readHeld = false;
  const calls = vi.fn(async (request: { name: string; arguments?: Record<string, unknown> }, config?: { signal?: AbortSignal }): Promise<CallToolResult> => {
    if (failedHostCall === request.name) { failedHostCall = undefined; throw new Error("The Host did not deliver the call."); }
    let result = CallToolResultSchema.parse(await client.callTool(request, CallToolResultSchema, config));
    if (options.delayedReadFailure !== undefined && request.name === "presentation_get_card" && !readHeld) {
      readHeld = true; readEntered(result); await readGate;
      if (options.delayedReadFailure === "transport") throw new Error("The held response transport failed.");
      return { isError: true, content: [], structuredContent: { ok: false, error: {
        code: "runtime_state_unavailable", category: "runtime", message: "Local runtime state is unavailable.", retryable: false, issues: [],
      } } };
    }
    if (request.name !== "signing_request_signature") return result;
    if (options.holdReply) await replyGate;
    if (options.malformedFailure && result.isError) return { ...result, content: [], structuredContent: { invalid: true } };
    if (carriage !== "intact" && result._meta?.[signingSignatureMetadataKey] !== undefined) {
      const metadata = { ...result._meta };
      if (carriage === "missing") delete metadata[signingSignatureMetadataKey];
      else metadata[signingSignatureMetadataKey] = `0x${"11".repeat(64)}1b`;
      result = { ...result, _meta: metadata };
    }
    if (options.missingState) {
      const metadata = { ...result._meta }; delete metadata[cardPresentationMetadataKey];
      result = { ...result, _meta: metadata };
    }
    return result;
  });
  const app = { getHostCapabilities: () => ({ serverTools: {} }), getHostVersion: () => ({ name: "standard", version: "1" }),
    callServerTool: calls, readServerResource: async (): Promise<never> => { throw new Error("No snapshot read during signing."); } };
  const mount = async (controller: AbortController) => {
    const admission = await admitPresentationToolResult(app, creatingResult, controller.signal);
    if (admission.status !== "card") throw new Error("The creating result omitted card admission.");
    await mountCard(app, admission.card, creatingResult, createCardOpenRequestId(), document.body, controller.signal);
  };
  await mount(signal);
  return { source, signal, calls, review, app, cards, nativePaths, releaseReply, releaseRead, delayedReadStarted,
    interruptNextControl: (key: "discard" | "stop", delivery: "not_sent" | "reply_lost") => { interruptedControl = { path: cardControlResources[key], delivery }; },
    failNextHostCall: (name: string) => { failedHostCall = name; },
    storedCard: () => database.presentationCardStore().read(created.reference!.cardId),
    accept: () => fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Request signature in Wallet")!),
    reopen: async () => { signal.abort(); const next = new AbortController(); controllers.push(next); await mount(next); },
    close: async () => { releaseReply(); releaseRead(); for (const controller of controllers) controller.abort(); await cards.close(); await source.close();
      await client.close(); await server.close(); await local.close();
      database.close(); await rm(directory, { recursive: true, force: true }); document.body.replaceChildren(); vi.restoreAllMocks(); },
  };
};

describe("direct App signature delivery", () => {
  it.each(["ready", "source_consumed"] as const)("recovers failed discard from the original live Review only while %s", async (state) => {
    const test = await fixture();
    try {
      const before = test.storedCard();
      const livePath = `/api/v1/internal/control/reviews/presentations/${test.review.operationId}`;
      expect(test.nativePaths).not.toContain(livePath);
      test.interruptNextControl("discard", "not_sent");
      fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Discard decision")!);
      await vi.waitFor(() => expect(document.body.textContent).toContain("runtime_state_unavailable"));
      expect(test.storedCard()).toEqual(before);
      expect(test.nativePaths).not.toContain(cardControlResources.discard);
      expect(test.source.startRequest).not.toHaveBeenCalled();
      if (state === "source_consumed") test.source.coordinator.cancel(test.review.operationId);
      fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Read saved state again")!);
      if (state === "source_consumed") {
        await vi.waitFor(() => expect(test.storedCard()).toMatchObject({ phase: "closed", outcome: { kind: "decision", reason: "source_unavailable" } }));
        await vi.waitFor(() => expect(document.querySelectorAll("button")).toHaveLength(0));
        expect(test.source.startRequest).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Request signature in Wallet" && !node.disabled)).toBe(true));
        expect(test.nativePaths).toContain(livePath);
        expect(test.storedCard()).toEqual(before);
        expect(document.body.textContent).toContain(message);
        expect(document.body.textContent).not.toContain("Operation unavailable");
        test.accept(); await test.source.sent;
        const signature = await signer.signMessage({ message });
        test.source.reply({ status: "signature_returned", signature });
        await vi.waitFor(() => expect(document.body.textContent).toContain(signature));
        expect(test.source.startRequest).toHaveBeenCalledOnce();
        expect(test.storedCard()).toMatchObject({ cardId: before!.cardId, firstCardOpenRequestId: before!.kind !== "read" ? before!.firstCardOpenRequestId : undefined,
          phase: "closed", outcome: { kind: "signing", status: "verified" } });
      }
    } finally { await test.close(); }
  });

  it.each(["not_sent", "host_error"] as const)("allows the original verified response after a failed Stop (%s)", async (failure) => {
    const test = await fixture();
    try {
      test.accept(); await test.source.sent;
      await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Stop waiting")).toBe(true));
      const before = test.storedCard();
      if (failure === "not_sent") test.interruptNextControl("stop", "not_sent");
      else test.failNextHostCall("presentation_cancel_wait");
      fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Stop waiting")!);
      await vi.waitFor(() => expect([...document.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["Read saved state again"]));
      expect(test.nativePaths).not.toContain(cardControlResources.stop);
      expect(test.storedCard()).toEqual(before);
      fireEvent.click(document.querySelector("button")!);
      await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Stop waiting" && !node.disabled)).toBe(true));
      const signature = await signer.signMessage({ message });
      test.source.reply({ status: "signature_returned", signature });
      await vi.waitFor(() => expect(document.body.textContent).toContain(signature));
      expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Dismiss signature")).toBe(true);
      expect(test.storedCard()).toMatchObject({ phase: "closed", outcome: { kind: "signing", status: "verified" } });
      fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Dismiss signature")!);
      expect(document.body.textContent).not.toContain(signature);
      await test.reopen();
      expect(document.body.textContent).toContain("Signature verified");
      expect(document.body.textContent).not.toContain(signature);
      expect(test.source.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });

  it("keeps a completed original result when Stop precedes its delayed delivery", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const test = await fixture("intact", { holdReply: true });
    try {
      test.accept(); await test.source.sent;
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Stop waiting")).toBe(true));
      const signature = await signer.signMessage({ message });
      test.source.reply({ status: "signature_returned", signature });
      await vi.waitFor(() => expect(test.storedCard()).toMatchObject({ phase: "closed", outcome: { kind: "signing", status: "verified" } }));
      const stored = test.storedCard();
      fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Stop waiting")!);
      await vi.waitFor(() => expect(document.body.textContent).toContain("Signature verified"));
      test.releaseReply();
      await vi.waitFor(() => expect(document.body.textContent).toContain(signature));
      expect(test.storedCard()).toEqual(stored);
      expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Dismiss signature")).toBe(true);
      expect(test.source.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); vi.useRealTimers(); }
  });

  it("replaces an unknown delivery report with the DB result without recovering the lost signature", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const test = await fixture("intact", { loseActionResponse: true });
    try {
      test.accept(); await test.source.sent;
      const response = test.calls.mock.results[test.calls.mock.calls.findIndex(([request]) => request.name === "signing_request_signature")]!.value;
      const signature = await signer.signMessage({ message });
      test.source.reply({ status: "signature_returned", signature });
      await response; await vi.advanceTimersByTimeAsync(0);
      expect(document.body.textContent).toContain("Waiting ended without an established result.");
      expect(document.body.textContent).not.toContain(signature);
      expect(test.storedCard()).toMatchObject({ phase: "closed", outcome: { kind: "signing", status: "verified" } });
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Read saved state again")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Signature verified"));
      expect(document.body.textContent).not.toContain("Waiting ended without an established result.");
      expect(document.body.textContent).not.toContain(signature);
      expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Dismiss signature")).toBe(false);
      expect(test.source.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); vi.useRealTimers(); }
  });

  it.each(["stored", "storage_failed", "missing_carrier"] as const)("shows an admitted Wallet rejection with %s card presentation", async (state) => {
    const test = await fixture("intact", { failTerminalWrite: state === "storage_failed", missingState: state === "missing_carrier" });
    try {
      test.accept(); await test.source.sent;
      test.source.reply({ status: "wallet_rejected" });
      await vi.waitFor(() => expect(document.body.textContent).toContain("The Wallet rejected the signature request."));
      expect(document.body.textContent).toContain("Signature request ended");
      expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Dismiss signature")).toBe(false);
      const stored = test.storedCard();
      expect(stored).toMatchObject(state === "storage_failed" ? { phase: "pending", outcome: null }
        : { phase: "closed", outcome: { kind: "signing", status: "wallet_rejected" } });
      if (state !== "stored") {
        await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Read saved state again")).toBe(true));
        const resultNode = document.querySelector(".operation-region")!.firstElementChild;
        [...document.querySelectorAll("button")].find((button) => button.textContent === "Read saved state again")!.click();
        if (state === "storage_failed") await vi.waitFor(() => expect(document.body.textContent).toContain("runtime_state_unavailable"));
        else await vi.waitFor(() => expect(document.body.textContent).not.toContain("Operation unavailable"));
        expect(document.querySelector(".operation-region")!.firstElementChild).toBe(resultNode);
        expect(document.body.textContent).toContain("The Wallet rejected the signature request.");
        expect(test.storedCard()).toEqual(stored);
      }
      expect(test.source.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });

  it.each([
    { failure: "known", carriage: "intact", missingState: false },
    { failure: "transport", carriage: "intact", missingState: true },
    { failure: "known", carriage: "missing", missingState: false },
  ] as const)("preserves received facts after a delayed read failure ($failure, $carriage, $missingState)", async ({ failure, carriage, missingState }) => {
    const test = await fixture(carriage, { delayedReadFailure: failure, missingState });
    try {
      test.accept(); await test.source.sent;
      expect(await test.delayedReadStarted).toMatchObject({ structuredContent: { state: { record: { phase: "pending" } } } });
      const signature = await signer.signMessage({ message });
      test.source.reply({ status: "signature_returned", signature });
      await vi.waitFor(() => expect(document.body.textContent).toContain(carriage === "intact" ? signature : "Signature delivery unavailable"));
      const resultNode = document.querySelector(".operation-region")!.firstElementChild;
      const dismiss = [...document.querySelectorAll("button")].find((node) => node.textContent === "Dismiss signature");
      const stored = test.storedCard();
      test.releaseRead();
      await vi.waitFor(() => expect(document.body.textContent).toContain(failure === "known" ? "Request failed" : "The current saved state could not be read"));
      expect(document.querySelector(".operation-region")!.firstElementChild).toBe(resultNode);
      expect(test.storedCard()).toEqual(stored);
      expect(test.source.startRequest).toHaveBeenCalledOnce();
      if (carriage === "intact") {
        expect(document.body.textContent).toContain(signature);
        expect(dismiss?.isConnected).toBe(true);
        expect(dismiss?.disabled).toBe(false);
        expect(resultNode!.querySelector(".field-value")?.textContent).toBe(signature);
        dismiss!.click();
        expect(document.body.textContent).not.toContain(signature);
      } else {
        expect(dismiss).toBeUndefined();
        expect(document.body.textContent).toContain("Signature verified");
      }
      [...document.querySelectorAll("button")].find((node) => node.textContent === "Read saved state again")!.click();
      await vi.waitFor(() => expect(document.body.textContent).not.toContain(failure === "known" ? "Request failed" : "The current saved state could not be read"));
      expect(document.body.textContent).not.toContain(signature);
      if (carriage === "intact") expect(document.body.textContent).toContain("Signature dismissed");
      expect(test.source.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });

  it.each([false, true])("distinguishes a received application failure from malformed failure carriage (%s)", async (malformedFailure) => {
    const test = await fixture("intact", { malformedFailure });
    try {
      vi.spyOn(test.source.wallet, "hasPendingRequest").mockReturnValue(true);
      test.accept();
      await vi.waitFor(() => expect(document.body.textContent).toContain(malformedFailure
        ? "The direct response could not be confirmed" : "Local state changed before the request completed."));
      expect(document.body.textContent).not.toContain(malformedFailure ? "Request failed" : "Operation unavailable");
      expect(test.source.startRequest).not.toHaveBeenCalled();
      expect(test.nativePaths).toEqual([
        "/api/v1/internal/control/presentation/card-openings",
        "/api/v1/internal/control/presentation/card-decisions",
      ]);
      if (!malformedFailure) {
        expect(document.body.textContent).toContain("state_conflict");
        expect([...document.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["Read saved state again"]);
      }
      fireEvent.click(document.querySelector("button")!);
      await vi.waitFor(() => expect(document.body.textContent).toContain("Decision ended"));
      expect(test.source.startRequest).not.toHaveBeenCalled();
      await test.reopen();
      expect(document.body.textContent).toContain("Decision ended");
      expect(document.body.textContent).toContain("Local state changed before the request completed.");
    } finally { await test.close(); }
  });

  it.each([false, true])("keeps the terminal DB display when the direct failure arrives later (%s)", async (malformedFailure) => {
    const test = await fixture("intact", { holdReply: true, malformedFailure });
    try {
      vi.spyOn(test.source.wallet, "hasPendingRequest").mockReturnValue(true);
      test.accept();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Decision ended"));
      const saved = document.body.textContent;
      test.releaseReply();
      await Promise.all(test.calls.mock.results.map((result) => result.value));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(document.body.textContent).toBe(saved);
      expect(document.querySelectorAll("button")).toHaveLength(0);
      expect(test.source.startRequest).not.toHaveBeenCalled();
    } finally { await test.close(); }
  });

  it.each(["dismiss", "view_close"] as const)("keeps the complete value selectable without automatic copying and erases it on %s", async (disposal) => {
    const test = await fixture();
    const writeText = vi.fn();
    const execCommand = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    try {
      expect(test.source.startRequest).not.toHaveBeenCalled();
      test.accept();
      await vi.waitFor(() => expect(test.source.startRequest).toHaveBeenCalledOnce());
      const signature = await signer.signMessage({ message });
      test.source.reply({ status: "signature_returned", signature });
      await vi.waitFor(() => expect(document.body.textContent).toContain(signature));
      expect(document.querySelector(".operation-region .status-pending")).toBeNull();
      expect([...document.querySelectorAll(".operation-result button")].map((node) => node.textContent)).toEqual(["Dismiss signature"]);
      const value = document.querySelector(".operation-result .field-value")!;
      expect(value.textContent).toBe(signature);
      const range = document.createRange();
      range.selectNodeContents(value);
      const selection = document.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      expect(selection.toString()).toBe(signature);
      const stored = test.storedCard();
      if (disposal === "dismiss") {
        fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Dismiss signature")!);
        expect(document.body.textContent).toContain("Signature dismissed");
      } else test.signal.abort();
      expect(document.body.textContent).not.toContain(signature);
      expect(test.storedCard()).toEqual(stored);
      await test.reopen();
      expect(document.body.textContent).toContain("Signature verified");
      expect(document.body.textContent).not.toContain(signature);
      expect(test.source.startRequest).toHaveBeenCalledOnce();
      expect(writeText).not.toHaveBeenCalled();
      expect(execCommand).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
      Reflect.deleteProperty(document, "execCommand");
      await test.close();
    }
  });

  it.each(["missing", "changed"] as const)("refuses %s private carriage with the public verification fixed", async (carriage) => {
    const test = await fixture(carriage);
    try {
      test.accept(); await vi.waitFor(() => expect(test.source.startRequest).toHaveBeenCalledOnce());
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
      test.accept(); await vi.waitFor(() => expect(test.source.startRequest).toHaveBeenCalledOnce());
      if (ending === "stop") {
        await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Stop waiting")).toBe(true));
        fireEvent.click([...document.querySelectorAll("button")].find((node) => node.textContent === "Stop waiting")!);
        await vi.waitFor(() => expect(test.storedCard()).toMatchObject({ phase: "closed", outcome: { kind: "signing", status: "delivery_unknown" } }));
      }
      else test.signal.abort();
      const signature = await signer.signMessage({ message });
      test.source.reply({ status: "signature_returned", signature });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(document.body.textContent).not.toContain(signature);
      expect(test.source.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });
});
