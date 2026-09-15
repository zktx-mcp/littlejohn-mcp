import { createRequire } from "node:module";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolRequest, CallToolResult, ReadResourceRequest } from "@modelcontextprotocol/sdk/types.js";
import { mountCard, createCardOpenRequestId } from "../../src/interfaces/mcp-app/view/card-lifecycle.js";
import { admitPresentationToolResult, readPresentationResource } from "../../src/interfaces/mcp-app/view/lifecycle.js";
import { signingReviewSchema } from "../../src/review/signing-contracts.js";
import { signingSignatureMetadataKey } from "../../src/interfaces/signing-result.js";
import { exchangeReviewSchema } from "../../src/review/contracts.js";
import { cardReferenceSchema, presentationCardMetadataKey, cardPresentationDeliverySchema, admitCardActionDelivery, cardActionResponseLimitBytes } from "../../src/interfaces/mcp-app/card-contract.js";
import type { RuntimeOwnerSession } from "../../src/runtime/owner-session.js";
import { PresentationCardApplication, type CardReadExecutionPort } from "../../src/interfaces/mcp-app/card-application.js";
import { stockTokenTradeHistoryUnavailableFixture } from "./stock-token-trade-history-fixture.js";
import { cardControlResources } from "../../src/interfaces/mcp-app/card-controls.js";
import { cardControlContracts } from "../../src/interfaces/mcp-app/card-contract.js";
import { createSigningFailure } from "../../src/review/signing-errors.js";
import { extendCardRoutes } from "../../src/interfaces/mcp-app/card-controls.js";
import { internalResponseLimitBytes } from "../../src/runtime/http-limits.js";
import { requestReviewLimits } from "../../src/review/request-limits.js";
import { fixedOrigin } from "../../src/runtime/http-boundary.js";
import type { CanonicalJson } from "../../src/core/index.js";
import { extendReviewPresentationRoutes } from "../../src/interfaces/review-presentation-routes.js";
import { extendSigningRoutes } from "../../src/interfaces/signing-routes.js";
import { signingBindings } from "../../src/interfaces/signing-bindings.js";
import { signingApplicationContracts } from "../../src/review/signing-application-contracts.js";
import { createSigningFixture, command as signingCommand, signer, message } from "../review/signing-fixture.js";
import { parseSigningCliCommand, runSigningCliCommand } from "../../src/interfaces/cli-signing.js";
import { writeFile } from "node:fs/promises";
import { createSigningCodec } from "../../src/chain/evm-standard.js";
import { liveReviewPresentationIdentity } from "../../src/interfaces/review-presentation-binding.js";
import { dirname, resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createReceiptFixture } from "../receipt-activity/fixture.js";
import { createReviewApplication } from "../../src/review/application.js";
import { FixedHttpOwner } from "../../src/runtime/http-owner.js";
import { loadOrCreateControlCredential, deriveRuntimeConfigurationMac } from "../../src/runtime/control-credential.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { runtimeReleased } from "../../src/runtime/shutdown.js";
import { extendExchangeRoutes } from "../../src/interfaces/exchange-routes.js";
import { exchangeBindings, activityBindings } from "../../src/interfaces/exchange-bindings.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import { parseExchangeCliCommand, runExchangeCliCommand } from "../../src/interfaces/cli-exchange.js";
import { McpAppPresentationService, createMcpAppResource } from "../../src/interfaces/mcp-app/server.js";
import { captureCanonicalJson, canonicalJsonStringify } from "../../src/core/index.js";
import { exchangeApplicationContracts } from "../../src/review/application-contracts.js";
import { presentationSnapshotMetadataKey, admitPresentationSnapshotResource } from "../../src/interfaces/mcp-app/contracts.js";
import { admitOperationToolResultDescriptor, operationToolResultMetadataKey } from "../../src/interfaces/mcp-app/contracts.js";
import { createMcpServer } from "../../src/interfaces/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

const fixture = async (signing?: ReturnType<typeof createSigningFixture>, readExecution?: CardReadExecutionPort) => {
  const base = await createReceiptFixture();
  const send = vi.fn(async () => ({ response: Promise.resolve({ status: "hash_returned" as const, transactionHash: base.hash }) }));
  const clock = signing?.clock ?? base.deps.clock;
  const application = createReviewApplication({ preparation: { ...base.deps, clock, activeWallet: signing?.activeWallet ?? base.deps.activeWallet, transactions: base.transactions },
    receiptInvocationPorts: base.invocationPorts, nativeUnitAuthority: base.nativeUnitAuthority, codec: base.codec, signingCodec: createSigningCodec(),
    walletRequests: signing?.wallet ?? { hasPendingRequest: () => false, startRequest: send }, ledger: base.database.transactionLedgerStore() });
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected Wallet/Token operation in request fixture"); };
  const readPresentation = vi.fn(application.presentations.readPresentation);
  let cards!: PresentationCardApplication;
  const root = dirname(base.path);
  const credential = await loadOrCreateControlCredential(root, resolve(root, "control.key"));
  const owner = new FixedHttpOwner({ ownerStore: base.database.ownerStore(), credential,
    configurationMac: deriveRuntimeConfigurationMac(credential, readRuntimeConfiguration({})), now: () => clock.now(), onPortOwnershipAcquired: () => undefined,
    applicationFactory: ({ routes, signal }) => {
      cards = new PresentationCardApplication({ ownerSignal: signal, readExecution: readExecution ?? { execute: unexpected }, clock, store: base.database.presentationCardStore(),
        snapshots: base.database.presentationSnapshotStore(), reviews: { readPresentation },
        domains: { signing: application.signing, exchange: application.exchange,
          wallet: { review: unexpected, decide: unexpected, get: unexpected, getPresentation: unexpected, cancel: unexpected },
          token: { review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected Token read"); } },
        } });
      return { routes: extendCardRoutes(extendReviewPresentationRoutes(extendSigningRoutes(extendExchangeRoutes({ routes, exchange: application.exchange,
      activity: application.activity, cards }), application.signing, cards), application.presentations), cards),
      shutdown: async () => { await cards.close(); await application.close(); return runtimeReleased; }, close: async () => { await cards.close(); await application.close(); } };
    },
  });
  try { await owner.start(); }
  catch (error) {
    await application.close();
    const closed = await owner.closeApplication();
    if ("permit" in closed) await owner.releaseListener(closed.permit);
    await base.close();
    throw error;
  }
  const client = new LocalOperationClient({ ownerSessions: owner });
  const presentation = new McpAppPresentationService(base.database.presentationSnapshotStore(), createMcpAppResource("<!doctype html><title>Test</title>"), {
    async read(operationId) {
      const result = await client.invoke(liveReviewPresentationIdentity, { operationId });
      if ("status" in result || !result.ok) throw new Error("Live read failed.");
      return result.value;
    },
  }, async (input) => cards.getReference(input));
  return { ...base, application, cards, owner, client, presentation, send, readPresentation,
    async closeAll() {
      await client.close();
      const closed = await owner.closeApplication();
      if ("permit" in closed) await owner.releaseListener(closed.permit);
      await base.close();
    },
  };
};

const invokeNativeControl = async (session: RuntimeOwnerSession, path: string, body: CanonicalJson) => {
  const sent = await session.send({ method: "POST", path, body, maximumResponseBytes: path === cardControlResources.action ? cardActionResponseLimitBytes : internalResponseLimitBytes,
    responseDeadlineMilliseconds: requestReviewLimits.reviewLifetimeMilliseconds });
  if (sent.status !== "response_received") throw new Error("Native response required");
  expect(sent.response.statusCode).toBe(200);
  const result = JSON.parse(new TextDecoder().decode(sent.response.bytes));
  if (path === cardControlResources.action) return admitCardActionDelivery(result).result;
  return [cardControlResources.read, cardControlResources.open, cardControlResources.discard, cardControlResources.stop].some((resource) => resource === path)
    ? cardPresentationDeliverySchema.parse(result).presentation.state : result;
};

const connectCardMcp = async (test: Awaited<ReturnType<typeof fixture>>) => {
  const server = createMcpServer({
    dispatchRuntimeRequest: test.owner.dispatchRuntimeRequest.bind(test.owner),
    openOwnerSession: test.owner.openOwnerSession.bind(test.owner),
    presentationSnapshotStore: () => test.database.presentationSnapshotStore(),
  }, test.client, createMcpAppResource("<!doctype html><title>Card controls</title>"));
  const client = new Client({ name: "littlejohn-test", version: "1.0.0" }, { capabilities: {
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await Promise.allSettled([client.close(), server.close()]); } };
};

describe("card native controls", () => {
  it("drains an actual App request on owner termination before the Wallet responds", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    const session = await test.owner.openOwnerSession();
    try {
      const created = await invokeNativeControl(session, cardControlResources.review("signing"), captureCanonicalJson(signingCommand));
      const review = signingReviewSchema.parse(created.value);
      const context = { cardId: created.reference.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      await invokeNativeControl(session, cardControlResources.open, context);
      const request = session.send({ method: "POST", path: cardControlResources.action,
        body: captureCanonicalJson({ ...context, decision: { review, initiatedBy: "mcp_app" } }),
        maximumResponseBytes: cardActionResponseLimitBytes,
        responseDeadlineMilliseconds: requestReviewLimits.reviewLifetimeMilliseconds }).finally(() => session.close());
      await signing.sent;
      // No response release and no clock advance can make the route settle here.
      const shutdown = await test.owner.closeApplication();
      expect(shutdown.outcome).toEqual(runtimeReleased);
      expect(test.database.presentationCardStore().read(context.cardId)).toMatchObject({ phase: "closed",
        outcome: { kind: "signing", status: "delivery_unknown" } });
      session.close();
      await request;
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally {
      signing.reply({ status: "wallet_rejected" });
      session.close(); await test.closeAll(); await signing.close();
    }
  });

  it("keeps one admitted read running across MCP closure and publishes its snapshot to the same card", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let executionSignal: AbortSignal | undefined;
    const canonical = stockTokenTradeHistoryUnavailableFixture();
    const execute = vi.fn<CardReadExecutionPort["execute"]>(async (_input, signal) => {
      executionSignal = signal;
      await gate;
      return captureCanonicalJson(canonical);
    });
    const test = await fixture(undefined, { execute });
    const initial = await connectCardMcp(test);
    let returned: Awaited<ReturnType<typeof connectCardMcp>> | undefined;
    try {
      const creating = CallToolResultSchema.parse(await initial.client.callTool({ name: "presentation_start_read", arguments: {
        capabilityId: "market.stock_token_trade_history", input: { symbol: "AAPL", period: { count: 1, unit: "day" } },
      } }));
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      if (reference.kind !== "card") throw new Error("Saved read card required.");
      expect(creating.structuredContent).toEqual({ reference });
      expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({ kind: "read", phase: "pending", outcome: null });
      await initial.close();
      returned = await connectCardMcp(test);
      const client = returned.client;
      const app = { getHostCapabilities: () => ({ serverTools: {}, serverResources: {} }), getHostVersion: () => ({ name: "standard", version: "1" }),
        callServerTool: async (params: CallToolRequest["params"], options?: RequestOptions) => CallToolResultSchema.parse(await client.callTool(params, CallToolResultSchema, options)),
        readServerResource: (params: ReadResourceRequest["params"], options?: RequestOptions) => client.readResource(params, options),
      };
      const signal = new AbortController().signal;
      const admission = await admitPresentationToolResult(app, creating, signal);
      expect(admission).toMatchObject({ status: "card", card: { cardId: reference.cardId } });
      const opened = await app.callServerTool({ name: "presentation_start_view", arguments: { cardId: reference.cardId, cardOpenRequestId: createCardOpenRequestId() } });
      expect(opened).toMatchObject({ structuredContent: { state: { mode: "static", record: { phase: "pending" } }, display: { kind: "summary" } } });
      expect(executionSignal?.aborted).toBe(false);
      release();
      await vi.waitFor(() => expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({ phase: "closed", outcome: { kind: "snapshot" } }));
      const result = await app.callServerTool({ name: "presentation_get_card", arguments: reference });
      const display = result.structuredContent?.["display"] as { kind: string; resource: unknown };
      expect(display.kind).toBe("snapshot");
      const admitted = await readPresentationResource(app, display.resource, signal);
      expect(admitted).toMatchObject({ ok: true });
      if (!admitted.ok) throw new Error("Stored read data required.");
      expect(admitted.value.result).toEqual(canonical);
      expect(execute).toHaveBeenCalledOnce();
      expect(executionSignal?.aborted).toBe(false);
    } finally { release(); await initial.close(); await returned?.close(); await test.closeAll(); }
  });

  it.each(["signing", "transaction"] as const)("keeps %s snapshot replay attached to DB state without restoring consumed material", async (kind) => {
    const signing = kind === "signing" ? createSigningFixture() : undefined;
    const test = await fixture(signing); const mcp = await connectCardMcp(test);
    try {
      const creating = CallToolResultSchema.parse(await mcp.client.callTool({
        name: kind === "signing" ? "signing_start_review" : "exchange_start_review",
        arguments: captureCanonicalJson(kind === "signing" ? signingCommand : test.input.request) as Record<string, unknown>,
      }));
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      if (reference.kind !== "card") throw new Error("Saved card required");
      const resource = admitPresentationSnapshotResource(creating._meta?.[presentationSnapshotMetadataKey]);
      const replay = CallToolResultSchema.parse(await mcp.client.callTool({ name: "presentation_get_snapshot", arguments: { snapshotUri: resource.descriptor.snapshotUri } }));
      expect(replay._meta?.[presentationCardMetadataKey]).toEqual(reference);
      expect(replay.structuredContent).toMatchObject({ kind: "presentation_snapshot_reference" });
      expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({ phase: "ready", firstCardOpenRequestId: null });
      await mcp.client.callTool({ name: "presentation_cancel_decision", arguments: { cardId: reference.cardId } });
      const reopened = CallToolResultSchema.parse(await mcp.client.callTool({ name: "presentation_start_view", arguments: { cardId: reference.cardId, cardOpenRequestId: createCardOpenRequestId() } }));
      expect(reopened.structuredContent).toMatchObject({ state: { record: { phase: "closed", outcome: { reason: "discarded" } } }, display: { kind: "summary" }, actions: [] });
      const expiredReplay = CallToolResultSchema.parse(await mcp.client.callTool({ name: "presentation_get_snapshot", arguments: { snapshotUri: resource.descriptor.snapshotUri } }));
      expect(expiredReplay.structuredContent).toMatchObject({ kind: "presentation_unavailable" });
      expect(test.send).not.toHaveBeenCalled();
      expect(signing?.startRequest.mock.calls.length ?? 0).toBe(0);
    } finally { await mcp.close(); await test.closeAll(); await signing?.close(); }
  });

  it("carries MCP card admission and disposal through the authenticated owner to the same SQLite row", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    const mcp = await connectCardMcp(test);
    try {
      const creating = CallToolResultSchema.parse(await mcp.client.callTool({ name: "signing_start_review", arguments: signingCommand }));
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      const first = (await test.cards.get(reference)).presentation.state;
      if (first.record === null || first.record.kind === "read") throw new Error("Stateful card required.");
      const { cardId } = first.record;
      const context = { cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      const read = await mcp.client.callTool({ name: "presentation_get_card", arguments: { kind: "card", cardId } });
      expect(read).toMatchObject({ structuredContent: { state: { mode: "interactive", record: { cardId, firstCardOpenRequestId: null } } } });
      expect(test.database.presentationCardStore().read(cardId)).toMatchObject({ firstCardOpenRequestId: null });
      for (const input of [context, { ...context }]) {
        const opened = await mcp.client.callTool({ name: "presentation_start_view", arguments: input });
        expect(opened).toMatchObject({ structuredContent: { state: { mode: "interactive", record: { cardId, firstCardOpenRequestId: context.cardOpenRequestId, phase: "ready" } } } });
      }
      const result = CallToolResultSchema.parse(await mcp.client.callTool({ name: "presentation_cancel_decision", arguments: { cardId } }));
      expect(result).toMatchObject({ structuredContent: { state: { mode: "static", record: { cardId, outcome: { kind: "decision", reason: "discarded" } } } } });
      expect(admitOperationToolResultDescriptor(result._meta?.[operationToolResultMetadataKey])).toMatchObject({
        toolName: "presentation_cancel_decision", isError: false,
        inputSha256: createHash("sha256").update(JSON.stringify({ cardId })).digest("hex"),
      });
      expect(test.database.presentationCardStore().read(cardId)).toEqual((result.structuredContent as { state: { record: unknown } }).state.record);
      expect(await mcp.client.callTool({ name: "presentation_start_view", arguments: context })).toMatchObject({ structuredContent: result.structuredContent });
      const missing = await mcp.client.callTool({ name: "presentation_get_card", arguments: { kind: "card", cardId: Buffer.alloc(32, 79).toString("base64url") } });
      expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: "presentation_not_found" } } });
      expect(signing.startRequest).not.toHaveBeenCalled();
    } finally { await mcp.close(); await test.closeAll(); await signing.close(); }
  });

  it("preserves the owning failure through creation, dispatch, HTTP and card-state admission", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    const session = await test.owner.openOwnerSession();
    const invoke = (path: string, body: CanonicalJson) => invokeNativeControl(session, path, body);
    try {
      const created = await invoke(cardControlResources.review("signing"), captureCanonicalJson(signingCommand));
      const review = created.value;
      const first = await invoke(cardControlResources.read, created.reference);
      const context = { cardId: first.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      await invoke(cardControlResources.open, context);
      signing.disconnect();
      for (const [path, body] of [
        [cardControlResources.review("signing"), signingCommand],
        [cardControlResources.action, { ...context, decision: { review, initiatedBy: "mcp_app" } }],
      ] as const) {
        const sent = await session.send({ method: "POST", path, body: captureCanonicalJson(body), maximumResponseBytes: internalResponseLimitBytes,
          responseDeadlineMilliseconds: requestReviewLimits.reviewLifetimeMilliseconds });
        if (sent.status !== "response_received") throw new Error("Native failure response required");
        expect(sent.response.statusCode).toBe(409);
        expect(JSON.parse(new TextDecoder().decode(sent.response.bytes))).toMatchObject({ code: "wallet_not_connected" });
      }
      expect(cardControlContracts.read.parseFailure(createSigningFailure("wallet_not_connected"))).toEqual(createSigningFailure("wallet_not_connected"));
      expect(await invoke(cardControlResources.read, { kind: "card", cardId: context.cardId })).toMatchObject({
        mode: "static", record: { outcome: { kind: "failure", failureCode: "wallet_not_connected" } },
      });
      expect(signing.startRequest).not.toHaveBeenCalled();
    } finally { await session.close(); await test.closeAll(); await signing.close(); }
  });

  it("carries one actual signature through authenticated native controls and reads only its saved outcome on reopen", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    const session = await test.owner.openOwnerSession();
    const invoke = (path: string, body: CanonicalJson) => invokeNativeControl(session, path, body);
    try {
      const refused = await fetch(`${fixedOrigin}${cardControlResources.review("signing")}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signingCommand),
      });
      expect(refused.status).toBe(401); await refused.arrayBuffer();
      expect(signing.startRequest).not.toHaveBeenCalled();
      const created = await invoke(cardControlResources.review("signing"), captureCanonicalJson(signingCommand));
      const review = created.value;
      const first = await invoke(cardControlResources.read, created.reference);
      const context = { cardId: first.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      expect(await invoke(cardControlResources.open, context)).toMatchObject({ mode: "interactive" });
      expect(await invoke(cardControlResources.open, context)).toMatchObject({ record: { phase: "ready" } });
      const pending = invoke(cardControlResources.action, captureCanonicalJson({ ...context, decision: { review, initiatedBy: "mcp_app" } }));
      await signing.sent;
      const signature = await signer.signMessage({ message }); signing.reply({ status: "signature_returned", signature });
      expect(await pending).toMatchObject({ outcome: { status: "verified" }, signature });
      const reopened = await invoke(cardControlResources.open, { cardId: context.cardId, cardOpenRequestId: Buffer.alloc(32, 88).toString("base64url") });
      expect(reopened).toMatchObject({ mode: "static", record: { outcome: { kind: "signing", status: "verified" } } });
      expect(JSON.stringify(reopened)).not.toContain(signature);
      expect(JSON.stringify(reopened)).not.toContain(message);
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally { await session.close(); await test.closeAll(); await signing.close(); }
  });

  it("ends the existing native request through an independent MCP control without resending", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    const session = await test.owner.openOwnerSession();
    const mcp = await connectCardMcp(test);
    const invoke = (path: string, body: CanonicalJson) => invokeNativeControl(session, path, body);
    let pending: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      const created = await invoke(cardControlResources.review("signing"), captureCanonicalJson(signingCommand));
      const review = created.value;
      const first = await invoke(cardControlResources.read, created.reference);
      const context = { cardId: first.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      await invoke(cardControlResources.open, context);
      pending = invoke(cardControlResources.action, captureCanonicalJson({ ...context, decision: { review, initiatedBy: "mcp_app" } }))
        .then((value) => ({ status: "fulfilled" as const, value }), (reason: unknown) => ({ status: "rejected" as const, reason }));
      await signing.sent;
      expect(await mcp.client.callTool({ name: "presentation_cancel_wait", arguments: { cardId: context.cardId } })).toMatchObject({ structuredContent: { state: { mode: "static", record: { outcome: { status: "delivery_unknown" } } } } });
      expect(await pending).toMatchObject({ status: "fulfilled", value: { outcome: { status: "delivery_unknown" } } });
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally {
      if (signing.startRequest.mock.calls.length !== 0) signing.reply({ status: "wallet_rejected" });
      await mcp.close(); session.close();
      await pending; await test.closeAll(); await signing.close();
    }
  });
});

describe("exchange interface handoff", () => {
  it("reopens a real MCP signature card from SQLite after its temporary Review is consumed", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    const mcp = await connectCardMcp(test);
    const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
      JSDOM: new (html: string) => { window: Pick<Window, "document" | "close"> & { HTMLElement: typeof HTMLElement } };
    };
    const dom = new JSDOM("<!doctype html><body></body>");
    vi.stubGlobal("document", dom.window.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    const firstView = new AbortController(); const secondView = new AbortController();
    let directResponse: CallToolResult | undefined;
    const app = { getHostCapabilities: () => ({ serverTools: {}, serverResources: {} }), getHostVersion: () => ({ name: "standard", version: "1" }),
      callServerTool: async (params: CallToolRequest["params"], options?: RequestOptions): Promise<CallToolResult> => {
        const result = CallToolResultSchema.parse(await mcp.client.callTool(params, CallToolResultSchema, options));
        if (params.name === "signing_request_signature") directResponse = result;
        return result;
      },
      readServerResource: (params: ReadResourceRequest["params"], options?: RequestOptions) => mcp.client.readResource(params, options),
    };
    try {
      const creating = CallToolResultSchema.parse(await mcp.client.callTool({ name: "signing_start_review", arguments: signingCommand }));
      const review = signingReviewSchema.parse(creating.structuredContent);
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      if (reference.kind !== "card") throw new Error("Saved card reference required.");
      expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({ operationId: review.operationId });
      const admission = await admitPresentationToolResult(app, creating, firstView.signal);
      if (admission.status !== "card") throw new Error("State-first card admission required.");
      await mountCard(app, admission.card, creating, createCardOpenRequestId(), document.body, firstView.signal);
      expect(signing.startRequest).not.toHaveBeenCalled();
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Request signature in Wallet")!.click();
      await vi.waitFor(() => expect(signing.startRequest).toHaveBeenCalledOnce());
      const signature = await signer.signMessage({ message }); signing.reply({ status: "signature_returned", signature });
      await vi.waitFor(() => expect(document.body.textContent).toContain(signature));
      expect(directResponse?._meta?.[signingSignatureMetadataKey]).toBe(signature);
      expect(JSON.stringify(directResponse?.content)).not.toContain(signature);
      expect(JSON.stringify(directResponse?.structuredContent)).not.toContain(signature);
      expect(test.application.signing.get(review.operationId).review).toBeNull();
      expect(test.application.activity.list({ account: review.account, cursor: null }).records).toEqual([]);
      firstView.abort(); test.readPresentation.mockClear();
      await mountCard(app, admission.card, creating, createCardOpenRequestId(), document.body, secondView.signal);
      expect(document.body.textContent).toContain("Signature verified");
      expect(document.body.textContent).not.toContain(signature);
      expect(document.querySelectorAll("button")).toHaveLength(0);
      expect(test.readPresentation).not.toHaveBeenCalled();
      expect(test.database.presentationCardStore().read(reference.cardId)?.outcome).toEqual({ kind: "signing", status: "verified" });
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally {
      firstView.abort(); secondView.abort(); await mcp.close(); await test.closeAll(); await signing.close();
      dom.window.close(); vi.unstubAllGlobals();
    }
  });

  it("delivers the exact usable signature only after the independent TTY decision", async () => {
    const signing = createSigningFixture();
    const test = await fixture(signing);
    const output: string[] = [];
    const file = resolve(dirname(test.path), "message.json");
    const terminal = { inputIsTTY: true, outputIsTTY: true, interruptSignal: new AbortController().signal,
      writeOutput: (value: string) => { output.push(value); }, writeError: (value: string) => { output.push(value); }, readLine: vi.fn(async () => "n") };
    try {
      await writeFile(file, JSON.stringify(signingCommand.payload));
      const command = parseSigningCliCommand(["signing", "start", "--active", "--file", file]);
      for (const extra of ["--json", "--yes", "--output"]) expect(() => parseSigningCliCommand(["signing", "start", "--active", "--file", file, extra])).toThrow();
      expect(await runSigningCliCommand(test.client, command, { ...terminal, inputIsTTY: false })).toBe(2);
      expect(signing.startRequest).not.toHaveBeenCalled();
      expect(terminal.readLine).not.toHaveBeenCalled();
      expect(await runSigningCliCommand(test.client, command, terminal)).toBe(0);
      expect(output.join("\n")).toContain("Decision discarded");
      expect(signing.startRequest).not.toHaveBeenCalled();
      terminal.readLine.mockResolvedValue("y");
      const pending = runSigningCliCommand(test.client, command, terminal);
      await signing.sent;
      const signature = await signer.signMessage({ message });
      signing.reply({ status: "signature_returned", signature });
      expect(await pending).toBe(0);
      expect(output.filter((line) => line.includes(signature))).toEqual([`Signature: ${signature}\n`]);
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally { await test.closeAll(); await signing.close(); }
  });
  it("carries a transaction through the real MCP card path and refuses duplicate or unwrapped App input", async () => {
    const test = await fixture(); const mcp = await connectCardMcp(test);
    try {
      const creating = CallToolResultSchema.parse(await mcp.client.callTool({ name: "exchange_start_review", arguments: test.input.request }));
      const review = exchangeReviewSchema.parse(creating.structuredContent);
      if (review.state !== "ready_for_wallet_review") throw new Error("Ready decision required.");
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      if (reference.kind !== "card") throw new Error("Saved card required.");
      const context = { cardId: reference.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      await mcp.client.callTool({ name: "presentation_start_view", arguments: context });
      const resource = admitPresentationSnapshotResource(creating._meta?.[presentationSnapshotMetadataKey]);
      expect(resource.descriptor.source.kind).toBe("review_memory");
      expect(test.database.presentationSnapshotStore().read(resource.descriptor.snapshotId).status).toBe("unavailable");
      const input = { ...context, decision: { review, initiatedBy: "mcp_app" } };
      const result = await mcp.client.callTool({ name: "exchange_request_transaction", arguments: input });
      expect(result).toMatchObject({ structuredContent: { kind: "wallet_result", outcome: { status: "hash_returned", recording: "recorded", lookup: "completed" } } });
      expect(test.send).toHaveBeenCalledOnce();
      expect((await test.presentation.getSnapshotResult(resource.descriptor.snapshotUri)).structuredContent).toMatchObject({ kind: "presentation_unavailable" });
      const duplicate = await mcp.client.callTool({ name: "exchange_request_transaction", arguments: input });
      expect(duplicate).toMatchObject({ isError: true });
      const unwrapped = await test.client.invoke(exchangeBindings.request.identity, { review, initiatedBy: "mcp_app" });
      expect(unwrapped).not.toMatchObject({ ok: true, value: { kind: "wallet_result" } });
      expect(test.send).toHaveBeenCalledOnce();
      const response = await test.owner.dispatchRuntimeRequest({ requestClass: "public_read", method: "POST", path: activityBindings.get.path,
        body: captureCanonicalJson({ account: test.reference.account, transactionHash: test.hash }) });
      expect(response.body).toMatchObject({ inspection: { data: { execution: "success", requestComparison: "matched", effectComparison: "matched" } } });
    } finally { await mcp.close(); await test.closeAll(); }
  });

  it("uses the independent TTY decision path, discards decline and never sends for a non-TTY call", async () => {
    const test = await fixture();
    vi.spyOn(Date, "now").mockImplementation(() => Date.parse(test.deps.clock.now()));
    const output: string[] = [];
    const terminal = { inputIsTTY: true, outputIsTTY: true, interruptSignal: new AbortController().signal,
      writeOutput: (text: string) => { output.push(text); }, writeError: (text: string) => { output.push(text); }, readLine: vi.fn(async () => "n") };
    try {
      const command = { kind: "start" as const, input: test.input.request, json: false as const };
      expect(await runExchangeCliCommand(test.owner, test.client, command, { ...terminal, inputIsTTY: false })).not.toBe(0);
      expect(test.send).not.toHaveBeenCalled();
      expect(terminal.readLine).not.toHaveBeenCalled();
      expect(await runExchangeCliCommand(test.owner, test.client, command, terminal)).toBe(0);
      expect(output.join("\n")).toContain("Decision discarded");
      expect(test.send).not.toHaveBeenCalled();
      terminal.readLine.mockResolvedValue("y");
      expect(await runExchangeCliCommand(test.owner, test.client, command, terminal)).toBe(0);
      expect(test.send).toHaveBeenCalledTimes(1);
      expect(output.join("\n")).toContain(test.hash);
      const parsed = parseExchangeCliCommand(["activity", "get", test.hash, "--address", test.reference.account.address, "--json"]);
      expect(await runExchangeCliCommand(test.owner, test.client, parsed, terminal)).toBe(0);
      expect(output.at(-1)).toContain('"requestComparison":"matched"');
    } finally { await test.closeAll(); }
  });
});
