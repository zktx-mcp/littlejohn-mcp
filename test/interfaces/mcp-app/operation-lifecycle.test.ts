import { CardError } from "../../../src/interfaces/mcp-app/card-errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonStringify, captureCanonicalJson, createCanonicalClock, parseUtcTimestamp, type CanonicalJson } from "../../../src/core/index.js";
import { walletOperationQrMetadataKey, presentationSnapshotMetadataKey, admitPresentationSnapshotResource } from "../../../src/interfaces/mcp-app/contracts.js";
import { presentationContracts } from "../../../src/interfaces/mcp-app/registry.js";
import { operationReviewContext } from "../../../src/interfaces/mcp-app/view/operation-lifecycle.js";
import { mountCard, createCardOpenRequestId } from "../../../src/interfaces/mcp-app/view/card-lifecycle.js";
import { admitPresentationToolResult } from "../../../src/interfaces/mcp-app/view/lifecycle.js";
import { operationToolContracts } from "../../../src/interfaces/operation-tool-contracts.js";
import { createDeliveryUnknown } from "../../../src/interfaces/operation-delivery.js";
import { parseWalletManagementOperation, parseWalletReview, walletOperationIdByteLength, walletReviewDigest, type WalletManagementOperation } from "../../../src/wallet/contracts.js";
import { WalletOperationError } from "../../../src/wallet/errors.js";
import { walletManagementContracts } from "../../../src/wallet/management-contracts.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import { PresentationCardApplication } from "../../../src/interfaces/mcp-app/card-application.js";
import { presentationCardMetadataKey, cardPresentationMetadataKey, cardReferenceSchema } from "../../../src/interfaces/mcp-app/card-contract.js";
import { stockTokenTradeHistoryUnavailableFixture } from "../stock-token-trade-history-fixture.js";
import { McpAppPresentationService, createMcpAppResource } from "../../../src/interfaces/mcp-app/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../../../src/interfaces/mcp.js";
import { LocalOperationClient } from "../../../src/interfaces/operation-client.js";
import type { RuntimeDispatchPort } from "../../../src/interfaces/http-client.js";
import { extendCardRoutes, cardControlResources } from "../../../src/interfaces/mcp-app/card-controls.js";
import { createRuntimeRouteRegistry } from "../../../src/runtime/http-routing.js";
import { loadOrCreateControlCredential, createControlCredentialVerifier } from "../../../src/runtime/control-credential.js";
import { openTestOwnerSession } from "../owner-session-harness.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: Pick<Window, "document" | "close"> & { HTMLElement: typeof HTMLElement } };
};
let dom: InstanceType<typeof JSDOM>;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(createdAt));
  dom = new JSDOM("<!doctype html><body></body>");
  vi.stubGlobal("document", dom.window.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers();
});

const createdAt = "2026-08-12T00:00:00.000Z";
const actionExpiresAt = "2026-08-12T00:05:00.000Z";
const operationId = Buffer.alloc(walletOperationIdByteLength, 17).toString("base64url");

const reviewWithoutDigest = Object.freeze({
  contractVersion: "1" as const,
  domain: "wallet" as const,
  operationId,
  kind: "connect" as const,
  createdAt,
  actionExpiresAt,
  target: { chainId: "eip155:4663" as const },
  decision: {
    requiredMethods: ["eth_sendTransaction"] as const,
    optionalMethods: ["personal_sign", "eth_signTypedData_v4"] as const,
    requiredEvents: ["accountsChanged", "chainChanged"] as const,
  },
  precondition: {
    connectionRevision: "0",
    connection: { status: "disconnected" as const, reason: "no_session" as const },
  },
  fixedEvidence: { sessionSourceIds: [] as const },
});

const review = parseWalletReview({
  ...reviewWithoutDigest,
  reviewDigest: walletReviewDigest(reviewWithoutDigest),
});
const reviewResult = walletManagementContracts.review.parsePublicSuccess(
  { kind: "connect" },
  { status: "review", review },
);

const noDecisionResult = walletManagementContracts.review.parsePublicSuccess(
  { kind: "disconnect" },
  {
    status: "already_disconnected",
    connectionRevision: "0",
    connection: { status: "disconnected", reason: "no_session" },
  },
);


const activeOperation = parseWalletManagementOperation({
  contractVersion: "1",
  domain: "wallet",
  operationId,
  kind: "connect",
  initiatedBy: "mcp_app",
  review,
  state: "awaiting_wallet_approval",
  terminationTarget: null,
  result: null,
  failure: null,
  peerRefusalCode: null,
});
const terminalOperation = parseWalletManagementOperation({
  ...activeOperation,
  state: "completed",
  result: {
    outcome: "connected",
    connectionRevision: "1",
    connection: {
      status: "connected",
      address: "0x1111111111111111111111111111111111111111",
      chainId: "eip155:4663",
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-08-13T00:00:00.000Z",
    },
  },
});
const qr = {
  size: 21,
  rows: Array.from({ length: 21 }, (_, index) =>
    index === 0 ? `1${"0".repeat(20)}` : "0".repeat(21)),
};

type ToolCall = Readonly<{ name: string; argumentsValue: Record<string, unknown> }>;

const toolResult = (value: unknown, extra: Partial<CallToolResult> = {}): CallToolResult => ({
  content: [{
    type: "text",
    text: canonicalJsonStringify(captureCanonicalJson(value)),
  }],
  structuredContent: captureCanonicalJson(value) as Record<string, unknown>,
  ...extra,
});

const withoutObjectNullProperties = (value: CanonicalJson): CanonicalJson => {
  if (Array.isArray(value)) return value.map(withoutObjectNullProperties);
  if (value === null || typeof value !== "object") return value;
  return captureCanonicalJson(Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== null)
    .map(([key, entry]) => [key, withoutObjectNullProperties(entry)])));
};



const fixture = async (options: { tools?: boolean; codex?: boolean; invalidQr?: boolean; changedResult?: boolean; noDecision?: boolean; lostResult?: boolean; mountInitial?: boolean;
  loseOpeningReply?: boolean; terminalReply?: boolean; omitState?: boolean;
  failureCarriage?: "changed" | "conflicting_text" } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "littlejohn-operation-card-"));
  const database = await ProductDatabase.open(join(directory, "product.sqlite3"), parseUtcTimestamp(createdAt));
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected domain call."); };
  let stored: WalletManagementOperation | undefined;
  let completeAfterRead = false;
  const decide = vi.fn(async () => { stored = options.terminalReply ? terminalOperation : activeOperation; return stored; });
  const get = vi.fn(async (id: string) => {
    expect(id).toBe(operationId);
    if (stored === undefined) throw new WalletOperationError("wallet_operation_not_found");
    const value = stored;
    if (completeAfterRead) {
      stored = terminalOperation; completeAfterRead = false;
      const current = database.presentationCardStore().find("wallet", operationId);
      if (current !== null && current.kind === "wallet" && current.phase !== "closed") database.presentationCardStore().replace(current, { ...current, phase: "closed", outcome: { kind: "operation" } });
    }
    return value;
  });
  const cancel = vi.fn(async () => { stored = parseWalletManagementOperation({ ...activeOperation, state: "cancelled" }); return stored; });
  let referenceFailure: string | undefined;
  let controlFailure: string | undefined;
  let presentationFailure = false;
  let snapshotFailure = false;
  let openingReplyLost = false;
  let interruptedControl: { path: string; delivery: "not_sent" | "reply_lost" } | undefined;
  let failedHostCall: string | undefined;
  const readExecution = vi.fn(async () => captureCanonicalJson(stockTokenTradeHistoryUnavailableFixture()));
  const cardStore = database.presentationCardStore();
  const sourceStore = { ...cardStore, read(id: string) {
    if (controlFailure !== undefined) throw new CardError(controlFailure);
    return cardStore.read(id);
  }, find(kind: Parameters<typeof cardStore.find>[0], id: string) {
    if (referenceFailure !== undefined) throw new CardError(referenceFailure);
    return cardStore.find(kind, id);
  } };
  const cards = new PresentationCardApplication({ ownerSignal: new AbortController().signal, readExecution: { execute: readExecution }, clock: createCanonicalClock(() => new Date().toISOString()),
    store: sourceStore, snapshots: database.presentationSnapshotStore(),
    reviews: { readPresentation: () => { throw new Error("A durable Review does not read request memory."); } },
    domains: {
      wallet: { review: async () => options.noDecision ? noDecisionResult : reviewResult, decide, get, cancel, getPresentation: async () => {
        if (presentationFailure) throw new WalletOperationError("runtime_state_unavailable");
        return { operation: await get(operationId), ...(stored?.state === "awaiting_wallet_approval" ? { qr } : {}) };
      } },
      token: { review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected Token read."); } },
      signing: { start: unexpected, confirm: unexpected, get: () => { throw new Error("Unexpected signing read."); }, cancel: () => { throw new Error("Unexpected signing cancel."); } },
      exchange: { start: unexpected, confirm: unexpected, get: () => { throw new Error("Unexpected transaction read."); }, cancel: () => { throw new Error("Unexpected transaction cancel."); } },
    } });
  const controllers: AbortController[] = [];
  cleanup.push(async () => { controllers.forEach((controller) => controller.abort()); await cards.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const input = { kind: options.noDecision ? "disconnect" : "connect" };
  const created = await cards.startReview("wallet", input, new AbortController().signal);
  const service = new McpAppPresentationService(database.presentationSnapshotStore(), createMcpAppResource("<!doctype html><title>Test</title>"), { read: unexpected }, async (input) => cards.getReference(input));
  const presented = await service.present(presentationContracts.walletReview.contract, input,
    toolResult(created.value, { _meta: { [presentationCardMetadataKey]: created.reference } }));
  if (presented.status !== "available") throw new Error("Card presentation required.");
  const result = presented.delivery.result;
  const calls: ToolCall[] = [];
  const nativePaths: string[] = [];
  const credential = await loadOrCreateControlCredential(directory, join(directory, "control.key"));
  const routes = extendCardRoutes(createRuntimeRouteRegistry({ controlVerifier: createControlCredentialVerifier(credential) }), cards);
  const runtime: RuntimeDispatchPort = { async dispatchRuntimeRequest(request) {
    nativePaths.push(request.path);
    const signal = request.signal;
    if (signal === undefined) throw new Error("Native card request signal is required.");
    const match = routes.match(request.method, request.path);
    if (match.status !== "matched") throw new Error("Unexpected native card route.");
    const result = routes.normalizeResult(match.route, await match.route.handler({ params: match.params, query: "",
      body: request.method === "POST" ? request.body : undefined, signal }));
    return result.ok ? { status: match.route.successStatus, body: result.body }
      : { status: result.problem.status, body: captureCanonicalJson(result.problem) };
  } };
  const ownerSessions = { async openOwnerSession(signal?: AbortSignal) {
    const session = await openTestOwnerSession(runtime, signal);
    return { identity: session.identity, get usable() { return session.usable; }, close: () => session.close(),
      async send(request: Parameters<typeof session.send>[0], callerSignal?: AbortSignal) {
        const interruption = interruptedControl?.path === request.path ? interruptedControl : undefined;
        if (interruption !== undefined) interruptedControl = undefined;
        if (interruption?.delivery === "not_sent") return { status: "request_not_sent" as const, reason: "owner_unavailable" as const };
        const sent = await session.send(request, callerSignal);
        return interruption?.delivery === "reply_lost" ? { status: "response_unavailable_after_send_began" as const } : sent;
      } };
  } };
  const local = new LocalOperationClient({ ownerSessions });
  const snapshots = database.presentationSnapshotStore();
  const snapshotReads = vi.fn(snapshots.read);
  const chunkReads = vi.fn((input: Parameters<typeof snapshots.readResultChunk>[0]) => snapshotFailure
    ? { status: "unavailable" as const, reason: "snapshot_missing" as const } : snapshots.readResultChunk(input));
  const server = createMcpServer({ ...runtime, ...ownerSessions, presentationSnapshotStore: () => ({ ...snapshots, read: snapshotReads, readResultChunk: chunkReads }) }, local,
    createMcpAppResource("<!doctype html><title>Test</title>"));
  const client = new Client({ name: "card-view-test", version: "1" }, { capabilities: {
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(async () => { controllers.forEach((controller) => controller.abort()); await client.close(); await server.close(); await local.close(); });
  const app = { getHostCapabilities: () => options.tools === false ? {} : { serverTools: {} },
    getHostVersion: () => ({ name: options.codex ? "chatgpt" : "standard", version: "1" }),
    readServerResource: async (): Promise<never> => { throw new Error("Creating durable metadata is already present."); },
    callServerTool: async (request: { name: string; arguments?: Record<string, unknown> }, config?: { signal?: AbortSignal }): Promise<CallToolResult> => {
      const call: ToolCall = { name: request.name, argumentsValue: request.arguments ?? {} }; calls.push(call);
      if (failedHostCall === request.name) { failedHostCall = undefined; throw new Error("The Host did not deliver the call."); }
      let response = CallToolResultSchema.parse(await client.callTool(request, CallToolResultSchema, config));
      if (request.name === "presentation_start_view" && options.loseOpeningReply && !openingReplyLost) {
        openingReplyLost = true;
        throw new Error("The admitted opening response was lost.");
      }
      if (request.name === operationToolContracts.walletConnect.mcp.name && options.omitState) {
        const metadata = { ...response._meta }; delete metadata[cardPresentationMetadataKey];
        response = { ...response, _meta: metadata };
      }
      if (request.name === operationToolContracts.walletConnect.mcp.name && options.lostResult) {
        return toolResult({ delivery: createDeliveryUnknown("decide", operationId),
          recovery: { arguments: { operationId }, tool: operationToolContracts.walletOperation.mcp.name } }, { isError: true });
      }
      if (response.isError === true && options.failureCarriage === "conflicting_text") {
        response = { ...response, content: [{ type: "text", text: "not the canonical failure" }] };
      }
      if (response.isError === true && options.failureCarriage === "changed") {
        const value = response.structuredContent as { error: Record<string, unknown> };
        response = { ...response, content: [], structuredContent: { ...value, error: { ...value.error, message: "untrusted failure message" } } };
      }
      const privateQr = response._meta?.[walletOperationQrMetadataKey];
      if (options.invalidQr && privateQr !== undefined) response = { ...response, _meta: { ...response._meta,
        [walletOperationQrMetadataKey]: { ...privateQr as Record<string, unknown>, resultSha256: "0".repeat(64) } } };
      if (options.codex) response = CallToolResultSchema.parse(withoutObjectNullProperties(captureCanonicalJson(response)));
      return options.changedResult && request.name === operationToolContracts.walletConnect.mcp.name
        ? { ...response, structuredContent: { ...response.structuredContent, state: "failed" } } : response;
    },
  };
  const mount = async (creating = result, root: HTMLElement = document.body) => {
    if (root === document.body) controllers.forEach((previous) => previous.abort());
    const controller = new AbortController(); controllers.push(controller);
    const admission = await admitPresentationToolResult(app, creating, controller.signal);
    if (admission.status === "card") await mountCard(app, admission.card, creating, admission.card.entry === "decision" ? createCardOpenRequestId() : undefined, root, controller.signal);
    else if (admission.status === "presentation") expect(operationReviewContext(admission.presentation)).toBeNull();
    else throw new Error("Successful creating result required.");
  };
  if (options.mountInitial !== false) await mount();
  const resource = admitPresentationSnapshotResource(result._meta?.[presentationSnapshotMetadataKey]);
  return { cards, created, creating: result, calls, nativePaths, decide, get, cancel, mount, snapshotReads, chunkReads, resource, database, readExecution,
    interruptNextControl: (key: "discard" | "stop" | "action", delivery: "not_sent" | "reply_lost") => { interruptedControl = { path: cardControlResources[key], delivery }; },
    failNextHostCall: (name: string) => { failedHostCall = name; },
    failReferenceRead: (code: string) => { referenceFailure = code; },
    failCardControl: (code?: string) => { controlFailure = code; },
    failOperationPresentation: (failed: boolean) => { presentationFailure = failed; },
    failSnapshotChunks: (failed: boolean) => { snapshotFailure = failed; },
    startRead: () => app.callServerTool({ name: "presentation_start_read", arguments: {
      capabilityId: "market.stock_token_trade_history", input: { symbol: "AAPL", period: { count: 1, unit: "day" } },
    } }),
    replay: () => app.callServerTool({ name: "presentation_get_snapshot", arguments: { snapshotUri: resource.descriptor.snapshotUri } }),
    completeDuringNextRead: () => { completeAfterRead = true; }, complete: () => { stored = terminalOperation; },
    accept: () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Connect wallet")!.click(),
  };
};

describe("DB-owned operation cards", () => {
  it.each(["open", "read", "discard", "stop"] as const)("preserves an admitted %s failure through the actual card/native/MCP/View path", async (control) => {
    const test = await fixture({ codex: true, mountInitial: control !== "open", failureCarriage: "conflicting_text" });
    if (control === "stop" || control === "read") {
      test.accept();
      await vi.waitFor(() => expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).not.toBeNull());
    }
    const before = test.database.presentationCardStore().read(test.created.reference!.cardId);
    test.failCardControl("runtime_state_unavailable");
    if (control === "open") await test.mount();
    else if (control === "read") await vi.advanceTimersByTimeAsync(500);
    else [...document.querySelectorAll("button")].find((button) => button.textContent === (control === "discard" ? "Discard decision" : "Cancel connection attempt"))!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Request failed"));
    expect(document.body.textContent).toContain("runtime_state_unavailable");
    expect(document.body.textContent).toContain("Local runtime state is unavailable.");
    expect(document.body.textContent).not.toContain("not the canonical failure");
    expect(document.body.textContent).not.toContain("Operation unavailable");
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual([control === "open" ? "Retry opening" : "Read saved state again"]);
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual(before);
    expect(test.cancel).not.toHaveBeenCalled();
    const count = test.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.calls).toHaveLength(count);
    test.failCardControl();
    if (control === "open") {
      const unsubmitted = (await test.cards.get(test.created.reference)).presentation;
      expect(unsubmitted.actions).toEqual([]);
      expect(unsubmitted.state.record).toEqual(before);
    }
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Request failed"));
    if (control === "open") {
      expect(document.body.textContent).toContain("Choose an action");
      const openings = test.calls.filter((call) => call.name === "presentation_start_view");
      expect(openings).toHaveLength(2);
      expect(openings[1]!.argumentsValue).toEqual(openings[0]!.argumentsValue);
      expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual({ ...before,
        firstCardOpenRequestId: openings[0]!.argumentsValue["cardOpenRequestId"] });
    }
    expect(document.body.textContent).not.toContain("Operation unavailable");
    const expectedControl = control === "stop" || control === "read" ? "Cancel connection attempt" : "Discard decision";
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === expectedControl && !button.disabled)).toBe(true);
    if (control === "discard" || control === "stop") {
      [...document.querySelectorAll("button")].find((button) => button.textContent === expectedControl)!.click();
      await vi.waitFor(() => expect(test.database.presentationCardStore().read(test.created.reference!.cardId)?.phase).toBe("closed"));
      expect(test.cancel).toHaveBeenCalledTimes(control === "stop" ? 1 : 0);
    }
    expect(test.decide).toHaveBeenCalledTimes(control === "stop" || control === "read" ? 1 : 0);
  });

  it.each(["discard", "stop"] as const)("recovers an unsent %s through the same DB state and then admits one explicit control", async (control) => {
    const test = await fixture();
    if (control === "stop") {
      test.accept();
      await vi.waitFor(() => expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).not.toBeNull());
    }
    const before = test.database.presentationCardStore().read(test.created.reference!.cardId);
    const callsBefore = test.nativePaths.filter((path) => path === cardControlResources[control]).length;
    expect(test.chunkReads).not.toHaveBeenCalled();
    test.interruptNextControl(control, "not_sent");
    const label = control === "discard" ? "Discard decision" : "Cancel connection attempt";
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent === label)!;
    button.click(); button.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("runtime_state_unavailable"));
    expect(test.nativePaths.filter((path) => path === cardControlResources[control])).toHaveLength(callsBefore);
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual(before);
    expect(test.cancel).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((node) => node.textContent === label && !node.disabled)).toBe(true));
    expect(document.body.textContent).not.toContain("Operation unavailable");
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual(before);
    if (control === "discard") {
      expect(document.body.textContent).toContain(operationId);
      expect(document.body.textContent).toContain(actionExpiresAt);
      expect(test.chunkReads).toHaveBeenCalled();
    }
    [...document.querySelectorAll("button")].find((node) => node.textContent === label)!.click();
    await vi.waitFor(() => expect(test.database.presentationCardStore().read(test.created.reference!.cardId)?.phase).toBe("closed"));
    expect(test.nativePaths.filter((path) => path === cardControlResources[control])).toHaveLength(callsBefore + 1);
    expect(test.decide).toHaveBeenCalledTimes(control === "stop" ? 1 : 0);
    expect(test.cancel).toHaveBeenCalledTimes(control === "stop" ? 1 : 0);
  });

  it.each(["discard", "stop"] as const)("reads the committed %s after losing its reply without repeating the control", async (control) => {
    const test = await fixture();
    if (control === "stop") {
      test.accept();
      await vi.waitFor(() => expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).not.toBeNull());
    }
    test.interruptNextControl(control, "reply_lost");
    [...document.querySelectorAll("button")].find((node) => node.textContent === (control === "discard" ? "Discard decision" : "Cancel connection attempt"))!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("runtime_state_unavailable"));
    const saved = test.database.presentationCardStore().read(test.created.reference!.cardId);
    expect(saved).toMatchObject({ phase: "closed" });
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(control === "discard" ? "discarded locally" : "Cancelled"));
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual(saved);
    expect(test.nativePaths.filter((path) => path === cardControlResources[control])).toHaveLength(1);
    expect(test.decide).toHaveBeenCalledTimes(control === "stop" ? 1 : 0);
  });

  it.each(["not_sent", "host_error"] as const)("retains the unconfirmed submission notice after a ready read (%s)", async (failure) => {
    const test = await fixture();
    const before = test.database.presentationCardStore().read(test.created.reference!.cardId);
    if (failure === "not_sent") test.interruptNextControl("action", "not_sent");
    else test.failNextHostCall(operationToolContracts.walletConnect.mcp.name);
    test.accept();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Read saved state again")).toBe(true));
    expect(test.nativePaths).not.toContain(cardControlResources.action);
    expect(test.decide).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Decision delivery not confirmed"));
    expect(document.body.textContent).toContain("The saved card has no accepted decision at this read.");
    if (failure === "not_sent") expect(document.body.textContent).toContain("runtime_state_unavailable");
    expect([...document.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["Read saved state again"]);
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual(before);
    const notice = document.querySelector(".operation-region")!.firstElementChild;
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false));
    expect(document.querySelector(".operation-region")!.firstElementChild).toBe(notice);
    await vi.advanceTimersByTimeAsync(Date.parse(actionExpiresAt) - Date.parse(createdAt));
    await vi.waitFor(() => expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toMatchObject({ phase: "closed", outcome: { kind: "decision", reason: "expired" } }));
    expect(test.decide).not.toHaveBeenCalled();
  });

  it.each(["ready", "expired", "returned"] as const)("retries a lost opening with the same identity after the DB becomes %s", async (state) => {
    const test = await fixture({ loseOpeningReply: true });
    const first = test.calls.find((call) => call.name === "presentation_start_view")!.argumentsValue;
    const stored = test.database.presentationCardStore().read(test.created.reference!.cardId);
    expect(stored).toMatchObject({ phase: "ready", firstCardOpenRequestId: first["cardOpenRequestId"] });
    expect(document.querySelector("button")?.textContent).toBe("Retry opening");
    if (state === "expired") await vi.advanceTimersByTimeAsync(300_000);
    if (state === "returned") await test.cards.open({ cardId: test.created.reference!.cardId, cardOpenRequestId: createCardOpenRequestId() });
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(state === "ready" ? "Choose an action" : state === "expired" ? "Decision expired" : "Decision closed"));
    const openings = test.calls.filter((call) => call.name === "presentation_start_view");
    expect(openings).toHaveLength(2);
    expect(openings[1]!.argumentsValue).toEqual(first);
    const recovered = test.database.presentationCardStore().read(test.created.reference!.cardId);
    if (state === "ready") expect(recovered).toEqual(stored);
    else {
      expect(recovered).toMatchObject({ phase: "closed", firstCardOpenRequestId: first["cardOpenRequestId"], outcome: { kind: "decision", reason: state } });
      expect(document.querySelectorAll("button")).toHaveLength(0);
    }
    expect(test.decide).not.toHaveBeenCalled();
    expect(test.cancel).not.toHaveBeenCalled();
  });

  it("keeps a received pending Wallet result through presentation failure and adopts the later stored completion", async () => {
    const test = await fixture();
    test.failOperationPresentation(true);
    test.accept();
    await vi.waitFor(() => expect(document.body.textContent).toContain("The backend could not provide the saved card state"));
    expect(document.body.textContent).toContain("Waiting for approval in the external wallet");
    expect(document.querySelector("svg")).toBeNull();
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Read saved state again"]);
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toMatchObject({ phase: "pending", outcome: null });
    test.failOperationPresentation(false); test.complete();
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Wallet connected"));
    expect(document.body.textContent).not.toContain("Waiting for approval");
    expect(document.body.textContent).not.toContain("Operation unavailable");
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toMatchObject({ phase: "closed", outcome: { kind: "operation" } });
    expect(test.decide).toHaveBeenCalledOnce();
    expect(test.cancel).not.toHaveBeenCalled();
  });

  it("shows the admitted terminal Wallet result when its presentation carrier is missing", async () => {
    const test = await fixture({ terminalReply: true, omitState: true });
    test.accept();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Wallet connected"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Operation unavailable"));
    const stored = test.database.presentationCardStore().read(test.created.reference!.cardId);
    expect(stored).toMatchObject({ phase: "closed", outcome: { kind: "operation" } });
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Operation unavailable"));
    expect(document.body.textContent).toContain("Wallet connected");
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual(stored);
    expect(test.decide).toHaveBeenCalledOnce();
  });

  it("preserves a stored read completion when its details are unavailable, then reads those same details", async () => {
    const test = await fixture({ mountInitial: false });
    const creating = await test.startRead();
    const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
    if (reference.kind !== "card") throw new Error("Saved read card required.");
    await vi.waitFor(() => expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({ phase: "closed", outcome: { kind: "snapshot" } }));
    const stored = test.database.presentationCardStore().read(reference.cardId);
    if (stored?.kind !== "read" || stored.outcome?.kind !== "snapshot") throw new Error("Completed read snapshot required.");
    test.failSnapshotChunks(true);
    await test.mount(creating);
    expect(test.chunkReads).toHaveBeenCalledExactlyOnceWith({ snapshotId: stored.outcome.snapshotId, index: 0 });
    expect(document.body.textContent).toContain("Result ready");
    expect(document.body.textContent).toContain("snapshot_missing");
    expect(document.querySelector("button")?.textContent).toBe("Read saved state again");
    test.failSnapshotChunks(false);
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Trades in USDG"));
    expect(document.body.textContent).not.toContain("snapshot_missing");
    expect(test.database.presentationCardStore().read(reference.cardId)).toEqual(stored);
    expect(test.calls.some((call) => call.name === "presentation_start_view")).toBe(false);
    expect(test.readExecution).toHaveBeenCalledOnce();
    expect(test.decide).not.toHaveBeenCalled();
  });

  it("does not present an unadmitted control failure as a known product error", async () => {
    const test = await fixture({ mountInitial: false, failureCarriage: "changed" });
    const before = test.database.presentationCardStore().read(test.created.reference!.cardId);
    test.failCardControl("runtime_state_unavailable");
    await test.mount();
    expect(document.body.textContent).toContain("Operation unavailable");
    expect(document.body.textContent).not.toContain("untrusted failure message");
    expect(document.body.textContent).not.toContain("runtime_state_unavailable");
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual(before);
    expect(test.decide).not.toHaveBeenCalled();
  });

  it.each([
    ["presentation_not_found", "snapshot_missing"],
    ["presentation_inconsistent", "snapshot_inconsistent"],
    ["presentation_capacity_exceeded", "capacity_exceeded"],
    ["runtime_state_unavailable", "runtime_unavailable"],
  ])("preserves %s through native/MCP snapshot delivery", async (failureCode, reason) => {
    const test = await fixture({ mountInitial: false });
    const before = test.database.presentationCardStore().read(test.created.reference!.cardId);
    test.failReferenceRead(failureCode);
    expect((await test.replay()).structuredContent).toMatchObject({ kind: "presentation_unavailable", reason });
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual(before);
    expect(test.decide).not.toHaveBeenCalled();
    expect(test.calls.some((call) => call.name === "presentation_start_view")).toBe(false);
  });

  it("keeps a reference-read abort as a failed call without a snapshot", async () => {
    const test = await fixture({ mountInitial: false }); test.failReferenceRead("request_aborted");
    expect(await test.replay()).toMatchObject({ isError: true, structuredContent: { error: { code: "request_aborted" } } });
    expect(test.decide).not.toHaveBeenCalled();
  });

  it.each([false, true])("replays a decision through its existing DB card (initial View already opened: %s)", async (mountInitial) => {
    const test = await fixture({ codex: true, mountInitial });
    test.snapshotReads.mockClear();
    const before = (await test.cards.get(test.created.reference)).presentation.state.record;
    const replay = await test.replay();
    expect(replay.structuredContent).toMatchObject({ kind: "presentation_snapshot_reference", snapshotUri: test.resource.descriptor.snapshotUri });
    expect(replay._meta?.[presentationCardMetadataKey]).toEqual(test.created.reference);
    expect(replay.content.filter((item) => item.type === "resource_link" && item.uri.startsWith("littlejohn://presentation/cards/"))).toHaveLength(1);
    expect(test.snapshotReads).toHaveBeenCalledOnce();
    expect((await test.cards.get(test.created.reference)).presentation.state.record).toEqual(before);
    await test.mount(replay);
    expect(document.body.textContent).not.toContain("unavailable");
    expect(document.body.textContent).toContain("Read-only review");
    expect(document.body.textContent).not.toContain("Choose an action");
    expect((await test.cards.get(test.created.reference)).presentation.state.record).toEqual(before);
    expect(test.calls.filter((call) => call.name === "presentation_start_view")).toHaveLength(mountInitial ? 1 : 0);
    expect(test.decide).not.toHaveBeenCalled();
  });

  it("keeps the original direct choice when another View reads its snapshot", async () => {
    const test = await fixture({ codex: true, mountInitial: false });
    const original = document.createElement("div"); const reading = document.createElement("div");
    document.body.append(original, reading);
    await test.mount(test.creating, original);
    const before = (await test.cards.get(test.created.reference)).presentation.state.record;
    await test.mount(await test.replay(), reading);
    expect(reading.textContent).toContain("Read-only review");
    expect([...reading.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Read saved state"]);
    expect((await test.cards.get(test.created.reference)).presentation.state.record).toEqual(before);
    const confirm = [...original.querySelectorAll("button")].find((button) => button.textContent === "Connect wallet")!;
    expect(confirm.disabled).toBe(false); confirm.click();
    await vi.waitFor(() => expect(test.decide).toHaveBeenCalledOnce());
    expect(test.calls.filter((call) => call.name === "presentation_start_view")).toHaveLength(1);
    test.complete(); await vi.advanceTimersByTimeAsync(500);
  });

  it("leaves the first opening for the original decision after an earlier snapshot display", async () => {
    const test = await fixture({ mountInitial: false });
    await test.mount(await test.replay());
    expect((await test.cards.get(test.created.reference)).presentation.state.record).toMatchObject({ phase: "ready", firstCardOpenRequestId: null });
    await test.mount();
    expect(document.body.textContent).toContain("Choose an action");
    expect(test.calls.filter((call) => call.name === "presentation_start_view")).toHaveLength(1);
    expect(test.decide).not.toHaveBeenCalled();
  });

  it("keeps pending and completed work attached when replaying its original decision snapshot", async () => {
    const test = await fixture(); test.accept();
    await vi.waitFor(() => expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).not.toBeNull());
    const replay = await test.replay();
    await test.mount(replay);
    expect(document.body.textContent).toContain("Waiting for approval in the external wallet");
    expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).toBeNull();
    test.complete(); await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Wallet connected"));
    const previousChunkReads = test.calls.filter((call) => call.name === "presentation_get_snapshot_chunk").length;
    await test.mount(replay);
    expect(document.body.textContent).toContain("Wallet connected");
    expect(test.calls.filter((call) => call.name === "presentation_get_snapshot_chunk")).toHaveLength(previousChunkReads);
    const alias = (await test.cards.get({ kind: "snapshot", snapshotId: test.resource.descriptor.snapshotId })).presentation;
    expect(alias.state.reference).toEqual(test.created.reference);
    expect(alias.state.record).toMatchObject({ phase: "closed", outcome: { kind: "operation" } });
    expect(test.decide).toHaveBeenCalledOnce(); expect(test.cancel).not.toHaveBeenCalled();
  });

  it("does not create a card or App action for a no-op result", async () => {
    const test = await fixture({ noDecision: true });
    expect(test.created.reference).toBeNull(); expect(test.calls).toEqual([]); expect(test.decide).not.toHaveBeenCalled();
    const replay = await test.replay();
    expect(replay._meta?.[presentationCardMetadataKey]).toBeUndefined();
    await test.mount(replay);
    expect(test.nativePaths).toEqual([]);
  });
  it("does not open or expose input without the Host control capability", async () => {
    const test = await fixture({ tools: false });
    expect(test.calls).toEqual([]); expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.body.textContent).toContain("Direct controls unavailable");
  });
  it("admits input from DB and closes an unsubmitted card on another opening", async () => {
    const test = await fixture();
    expect(test.calls.map((call) => call.name)).toEqual(["presentation_start_view"]);
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Connect wallet", "Discard decision"]);
    await test.mount();
    expect(document.body.textContent).toContain("Decision closed"); expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(test.decide).not.toHaveBeenCalled();
  });
  it("sends one complete decision, displays only its active QR, and stops reading after completion", async () => {
    const test = await fixture({ codex: true });
    test.accept();
    await vi.waitFor(() => expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).not.toBeNull());
    const sent = test.calls.find((call) => call.name === operationToolContracts.walletConnect.mcp.name)!;
    expect(sent.argumentsValue).toMatchObject({ cardId: test.created.reference!.cardId, decision: { review, initiatedBy: "mcp_app" } });
    expect(typeof sent.argumentsValue["cardOpenRequestId"]).toBe("string");
    expect(test.decide).toHaveBeenCalledOnce();
    expect(test.nativePaths).toEqual([
      "/api/v1/internal/control/presentation/card-openings",
      "/api/v1/internal/control/presentation/card-decisions",
    ]);
    test.complete();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Wallet connected"));
    expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).toBeNull();
    const completedCalls = test.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(test.calls).toHaveLength(completedCalls);
    await test.mount();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Wallet connected"));
    expect(test.decide).toHaveBeenCalledOnce();
  });
  it("does not let an earlier active result override a later terminal DB state", async () => {
    const test = await fixture(); test.accept();
    await vi.waitFor(() => expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).not.toBeNull());
    test.completeDuringNextRead();
    await vi.advanceTimersByTimeAsync(500);
    expect(document.body.textContent).toContain("Wallet connected");
    expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).toBeNull();
    expect(test.decide).toHaveBeenCalledOnce();
  });
  it("does not render a QR with a different operation digest", async () => {
    const test = await fixture({ invalidQr: true }); test.accept();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Waiting for approval in the external wallet"));
    expect(document.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).toBeNull();
  });
  it("does not adopt a changed Codex result or restore decision controls", async () => {
    const test = await fixture({ codex: true, changedResult: true }); test.accept();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Submitting decision"));
    expect(document.body.textContent).not.toContain("Wallet connected");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Connect wallet")).toBe(false);
    expect(test.decide).toHaveBeenCalledOnce();
  });
  it("preserves an admitted Wallet failure and reads saved state only on explicit request", async () => {
    const test = await fixture();
    test.decide.mockRejectedValueOnce(new WalletOperationError("state_conflict"));
    test.accept();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Local state changed before the request completed."));
    expect(document.body.textContent).not.toContain("Operation unavailable");
    expect(document.body.textContent).toContain("state_conflict");
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Read saved state again"]);
    expect(test.nativePaths).toEqual([
      "/api/v1/internal/control/presentation/card-openings",
      "/api/v1/internal/control/presentation/card-decisions",
    ]);
    const saved = test.database.presentationCardStore().read(test.created.reference!.cardId);
    expect(saved).toMatchObject({ phase: "closed", outcome: { kind: "failure", failureCode: "state_conflict" } });
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Decision ended"));
    expect(test.nativePaths).toEqual([
      "/api/v1/internal/control/presentation/card-openings",
      "/api/v1/internal/control/presentation/card-decisions",
      "/api/v1/internal/control/presentation/card-state",
    ]);
    expect(test.database.presentationCardStore().read(test.created.reference!.cardId)).toEqual(saved);
    expect(document.querySelectorAll("button")).toHaveLength(0);
    await test.mount();
    expect(document.body.textContent).toContain("Decision ended");
    expect(test.decide).toHaveBeenCalledOnce();
  });
  it("discards through the backend and keeps a later opening closed", async () => {
    const test = await fixture();
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Discard decision")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("discarded locally"));
    await test.mount(); expect(document.body.textContent).toContain("discarded locally"); expect(test.decide).not.toHaveBeenCalled();
  });

  it("allows only an explicit saved-state read after an uncertain action response", async () => {
    const test = await fixture({ lostResult: true }); test.accept();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Read saved state again"]));
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Read saved state again"]);
    const before = test.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.calls).toHaveLength(before);
    [...document.querySelectorAll("button")][0]!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Waiting for approval in the external wallet"));
    expect(test.decide).toHaveBeenCalledOnce();
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Connect wallet")).toBe(false);
  });
});
