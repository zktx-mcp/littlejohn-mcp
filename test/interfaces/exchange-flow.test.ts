import {PresentationWorkBudget} from "../../src/interfaces/presentation-work.js";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createProcessTerminal } from "../../src/cli.js";
import { createRequire } from "node:module";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolRequest, CallToolResult, ReadResourceRequest } from "@modelcontextprotocol/sdk/types.js";
import { mountCard, createCardOpenRequestId } from "../../src/interfaces/mcp-app/view/card-lifecycle.js";
import { admitPresentationToolResult, readPresentationResource } from "../../src/interfaces/mcp-app/view/lifecycle.js";
import { signingReviewSchema, type SigningReview } from "../../src/review/signing-contracts.js";
import { signingSignatureMetadataKey } from "../../src/interfaces/signing-result.js";
import { exchangeReviewSchema } from "../../src/review/contracts.js";
import { cardReferenceSchema, presentationCardMetadataKey, cardPresentationDeliverySchema, admitCardActionDelivery, cardActionResponseLimitBytes, cardCreationResultSchema, cardDecisionStartContract, cardPresentationSchema } from "../../src/interfaces/mcp-app/card-contract.js";
import type { RuntimeOwnerResponsePacket, RuntimeOwnerSession } from "../../src/runtime/owner-session.js";
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
import { createSigningFixture, command as signingCommand, signer, message } from "../review/signing-fixture.js";
import { parseSigningCliCommand, runSigningCliCommand } from "../../src/interfaces/cli-signing.js";
import { signingResources } from "../../src/interfaces/signing-bindings.js";
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
import { captureCanonicalJson, canonicalJsonStringify, canonicalSha256 } from "../../src/core/index.js";
import { admitOperationToolResultDescriptor, operationToolResultMetadataKey } from "../../src/interfaces/mcp-app/contracts.js";
import { createMcpServer } from "../../src/interfaces/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import {createPresentationPublicationKeyOwner} from "../../src/runtime/presentation-publication-key.js";
import {tokenCatalogApplicationContracts} from "../../src/token-catalog/contracts.js";

const fixture = async (signing?: ReturnType<typeof createSigningFixture>, readExecution?: CardReadExecutionPort) => {
  const base = await createReceiptFixture();
  const send = vi.fn(async () => (() => { const response = Promise.resolve({ status: "hash_returned" as const, transactionHash: base.hash }); return { response, settlement: response }; })());
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
    applicationFactory: async ({ routes, signal }) => {
      cards = new PresentationCardApplication({work: new PresentationWorkBudget(), ownerSignal: signal, readExecution: readExecution ?? { execute: unexpected }, clock, store: base.database.presentationCardStore(),
        snapshots: base.database.presentationSnapshotStore(), reviews: { readPresentation },
        domains: { signing: application.signing, exchange: application.exchange,
          wallet: { prepareReview: unexpected, getReviewSource: () => {throw new Error("Unexpected Wallet source");}, discardPreparedReview: () => {}, getAccountSelection: unexpected, selectAccount: unexpected, review: unexpected, decide: unexpected, get: unexpected, getPresentation: unexpected, cancel: unexpected },
          token: { prepareReview: unexpected, getReviewSource: () => {throw new Error("Unexpected Token source");}, discardPreparedReview: () => {}, review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected Token read"); } },
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
  });
  return { ...base, application, cards, owner, client, presentation, send, readPresentation,
    publicationKeys: createPresentationPublicationKeyOwner({credential, profileId: base.database.ownerStore().readProfile().profileId}),
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

const connectCardMcp = async (test: Awaited<ReturnType<typeof fixture>>, operationClient: LocalOperationClient = test.client) => {
  const server = createMcpServer({
    dispatchRuntimeRequest: test.owner.dispatchRuntimeRequest.bind(test.owner),
    openOwnerSession: test.owner.openOwnerSession.bind(test.owner),
    presentationSnapshotStore: () => test.database.presentationSnapshotStore(),
    presentationPublicationKeys: () => test.publicationKeys,
  }, operationClient, createMcpAppResource("<!doctype html><title>Card controls</title>"));
  const client = new Client({ name: "littlejohn-test", version: "1.0.0" }, { capabilities: {
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await Promise.allSettled([client.close(), server.close()]); } };
};

const createNativeSigningCard = async (test: Awaited<ReturnType<typeof fixture>>, session: RuntimeOwnerSession) => {
  const input = cardDecisionStartContract.parseInput({kind: "signing", source: {kind: "new", input: signingCommand}});
  const created = cardCreationResultSchema.parse(await invokeNativeControl(session, cardControlResources.startDecision, captureCanonicalJson({input, publicationKey: null})));
  const reference = {kind: "card" as const, cardId: created.cardId};
  const state = (await test.cards.get(reference)).presentation.state;
  if (state.record?.kind !== "signing") throw new Error("Exact signing card required.");
  const review = signingReviewSchema.parse(test.application.signing.get(state.record.operationId).review);
  return {created, reference, review};
};
const publishDecision = async (mcp: Awaited<ReturnType<typeof connectCardMcp>>, kind: "signing" | "transaction", input: unknown) =>
  CallToolResultSchema.parse(await mcp.client.callTool({name: "presentation_start_decision", arguments: {kind, source: {kind: "new", input}}}));
const openMcpCard = async (mcp: Awaited<ReturnType<typeof connectCardMcp>>, cardId: string) =>
  cardPresentationSchema.parse((await mcp.client.callTool({name: "presentation_start_view", arguments: {cardId, cardOpenRequestId: createCardOpenRequestId()}})).structuredContent);
const signingSource = (test: Awaited<ReturnType<typeof fixture>>, cardId: string) => {
  const record = test.database.presentationCardStore().read(cardId);
  if (record?.kind !== "signing") throw new Error("Saved signing source required.");
  return signingReviewSchema.parse(test.application.signing.get(record.operationId).review);
};
const transactionSource = (test: Awaited<ReturnType<typeof fixture>>, cardId: string) => {
  const record = test.database.presentationCardStore().read(cardId);
  if (record?.kind !== "transaction") throw new Error("Saved transaction source required.");
  return exchangeReviewSchema.parse(test.application.exchange.get(record.operationId));
};

const signingActionCloseBarrier = (owner: FixedHttpOwner) => {
  let entered!: () => void;
  const closing = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const permitted = new Promise<void>((resolve) => { release = resolve; });
  const paths: string[] = [];
  let packet: RuntimeOwnerResponsePacket | undefined;
  let review: SigningReview | undefined;
  let actionClosed = false;
  const client = new LocalOperationClient({ownerSessions: {async openOwnerSession(signal) {
    const actual = await owner.openOwnerSession(signal);
    let actionSession = false;
    return Object.freeze({identity: actual.identity, get usable() {return actual.usable;},
      async send(request, callerSignal) {
        paths.push(request.path);
        actionSession = request.path === signingResources.request;
        if (actionSession) review = signingReviewSchema.parse((request.body as {review: unknown}).review);
        const result = await actual.send(request, callerSignal);
        if (actionSession && result.status === "response_received") packet = result.response;
        return result;
      },
      async close() {
        if (actionSession) { entered(); await permitted; }
        await actual.close();
        if (actionSession) actionClosed = true;
      },
    } satisfies RuntimeOwnerSession);
  }}});
  return {client, closing, release, paths, get packet() {return packet;}, get review() {return review;}, get actionClosed() {return actionClosed;}};
};

describe("card native controls", () => {
  it("keeps a domain Review data-only and publishes the same immutable source only on explicit creation", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing); const mcp = await connectCardMcp(test);
    try {
      const data = CallToolResultSchema.parse(await mcp.client.callTool({name: "signing_start_review", arguments: signingCommand}));
      const review = signingReviewSchema.parse(data.structuredContent);
      expect(data._meta?.[presentationCardMetadataKey]).toBeUndefined();
      expect(data._meta?.["ui"]).toBeUndefined();
      expect(data.content.some((item) => item.type === "resource_link")).toBe(false);
      const refused = await mcp.client.callTool({name: "signing_request_signature", arguments: {review, initiatedBy: "mcp_app"}});
      expect(refused).toMatchObject({isError: true});
      expect(signing.startRequest).not.toHaveBeenCalled();
      const created = CallToolResultSchema.parse(await mcp.client.callTool({name: "presentation_start_decision",
        arguments: {kind: "signing", source: {kind: "existing", operationId: review.operationId}}}));
      const reference = cardReferenceSchema.parse(created._meta?.[presentationCardMetadataKey]);
      if (reference.kind !== "card") throw new Error("Exact publication reference required.");
      expect(signingSource(test, reference.cardId)).toEqual(review);
      expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({resultDigest: canonicalSha256(captureCanonicalJson(review)), inputState: "input_pending"});
      const opened = await openMcpCard(mcp, reference.cardId);
      expect(opened.actions).toEqual(["confirm", "discard"]);
      expect(signing.startRequest).not.toHaveBeenCalled();
    } finally {await mcp.close(); await test.closeAll(); await signing.close();}
  });

  it("retains an omitted-cursor canonical read through MCP, authenticated HTTP, execution and immutable snapshot publication", async () => {
    const account = {chainId: "eip155:4663", address: `0x${"1".repeat(40)}`};
    const publicInput = {account: {kind: "address", address: account.address}, limit: 1};
    const normalizedInput = tokenCatalogApplicationContracts.selections.parseInput(publicInput);
    const canonical = tokenCatalogApplicationContracts.selections.parsePublicSuccess(normalizedInput, {account, selections: [], nextCursor: null});
    const execute = vi.fn<CardReadExecutionPort["execute"]>(async (request) => {
      expect(request).toEqual({capabilityId: "token.selections", input: normalizedInput});
      return captureCanonicalJson(canonical);
    });
    const test = await fixture(undefined, {execute}); const mcp = await connectCardMcp(test);
    try {
      expect(publicInput).not.toHaveProperty("cursor");
      expect(normalizedInput.cursor).toBeNull();
      const created = cardCreationResultSchema.parse((await mcp.client.callTool({name: "presentation_start_read",
        arguments: {capabilityId: "token.selections", input: publicInput}})).structuredContent);
      await vi.waitFor(() => expect(test.database.presentationCardStore().read(created.cardId)).toMatchObject({kind: "read", preparationState: "completed"}));
      const saved = test.database.presentationCardStore().read(created.cardId);
      if (saved?.kind !== "read" || saved.snapshotId === null) throw new Error("Completed read snapshot required.");
      const expectedInputText = JSON.stringify({account: {address: account.address, kind: "address"}, cursor: null, limit: 1});
      expect(saved.inputDigest).toBe(createHash("sha256").update(expectedInputText).digest("hex"));
      const snapshot = test.database.presentationSnapshotStore().read(saved.snapshotId);
      if (snapshot.status !== "available") throw new Error("Exact retained data required.");
      expect(new TextDecoder().decode(snapshot.value.inputBytes)).toBe(expectedInputText);
      expect(JSON.parse(new TextDecoder().decode(snapshot.value.inputBytes))).toEqual(normalizedInput);
      expect(JSON.parse(new TextDecoder().decode(snapshot.value.resultBytes))).toEqual(canonical);
      expect(execute).toHaveBeenCalledOnce();
    } finally {await mcp.close(); await test.closeAll();}
  });

  it("keeps an acknowledged signature outcome exact after its native response is lost and never recovers or resends private material", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    let decisions = 0;
    const client = new LocalOperationClient({ownerSessions: {async openOwnerSession(signal) {
      const actual = await test.owner.openOwnerSession(signal);
      return Object.freeze({identity: actual.identity, get usable() {return actual.usable;}, close: () => actual.close(),
        async send(request, callerSignal) {
          const response = await actual.send(request, callerSignal);
          if (request.path === cardControlResources.action) {
            decisions += 1;
            if (response.status !== "response_received") throw new Error("An actual authenticated response must precede this loss fixture.");
            expect(response.response.statusCode).toBe(200);
            return {status: "response_unavailable_after_send_began" as const};
          }
          return response;
        },
      } satisfies RuntimeOwnerSession);
    }}});
    const mcp = await connectCardMcp(test, client);
    try {
      const creating = await publishDecision(mcp, "signing", signingCommand);
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      if (reference.kind !== "card") throw new Error("Exact card required.");
      const review = signingSource(test, reference.cardId);
      const context = {cardId: reference.cardId, cardOpenRequestId: createCardOpenRequestId()};
      await mcp.client.callTool({name: "presentation_start_view", arguments: context});
      const pending = mcp.client.callTool({name: "signing_request_signature", arguments: {...context, decision: {review, initiatedBy: "mcp_app"}}});
      await signing.sent;
      const signature = await signer.signMessage({message}); signing.reply({status: "signature_returned", signature});
      const lost = CallToolResultSchema.parse(await pending);
      expect(lost.structuredContent).toMatchObject({status: "delivery_unknown", operationId: review.operationId});
      expect(lost._meta?.[signingSignatureMetadataKey]).toBeUndefined();
      expect(JSON.stringify(lost)).not.toContain(signature);
      const saved = CallToolResultSchema.parse(await mcp.client.callTool({name: "presentation_get_card", arguments: reference}));
      expect(saved.structuredContent).toMatchObject({state: {record: {inputState: "input_closed", outcome: {kind: "signing", status: "verified"}}}, actions: []});
      expect(JSON.stringify(saved)).not.toContain(signature);
      expect(JSON.stringify(saved)).not.toContain(message);
      expect(test.application.signing.get(review.operationId).review).toBeNull();
      expect(decisions).toBe(1); expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally {await mcp.close(); await client.close(); await test.closeAll(); await signing.close();}
  });

  it("drains an actual App request on owner termination before the Wallet responds", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    const session = await test.owner.openOwnerSession();
    try {
      const {reference, review} = await createNativeSigningCard(test, session);
      const context = { cardId: reference.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      await invokeNativeControl(session, cardControlResources.open, context);
      const request = session.send({ method: "POST", path: cardControlResources.action,
        body: captureCanonicalJson({ ...context, decision: { review, initiatedBy: "mcp_app" } }),
        maximumResponseBytes: cardActionResponseLimitBytes,
        responseDeadlineMilliseconds: requestReviewLimits.reviewLifetimeMilliseconds }).finally(() => session.close());
      await signing.sent;
      // No response release and no clock advance can make the route settle here.
      const shutdown = await test.owner.closeApplication();
      expect(shutdown.outcome).toEqual(runtimeReleased);
      expect(test.database.presentationCardStore().read(context.cardId)).toMatchObject({ inputState: "input_closed",
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
      expect(creating.structuredContent).toEqual({kind: "card", cardId: reference.cardId, disposition: "created"});
      expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({ kind: "read", preparationState: "pending", outcome: null });
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
      expect(opened).toMatchObject({ structuredContent: { state: { mode: "static", record: { preparationState: "pending" } }, display: { kind: "summary" } } });
      expect(executionSignal?.aborted).toBe(false);
      release();
      await vi.waitFor(() => expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({ preparationState: "completed", outcome: { kind: "snapshot" } }));
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

  it.each(["signing", "transaction"] as const)("reads %s snapshot data independently of its exact card without restoring consumed material", async (kind) => {
    const signing = kind === "signing" ? createSigningFixture() : undefined;
    const test = await fixture(signing); const mcp = await connectCardMcp(test);
    try {
      const creating = await publishDecision(mcp, kind, kind === "signing" ? signingCommand : test.input.request);
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      if (reference.kind !== "card") throw new Error("Saved card required");
      const opened = await openMcpCard(mcp, reference.cardId);
      if (opened.display.kind !== "decision") throw new Error("Complete saved decision display required.");
      const resource = opened.display.resource;
      const replay = CallToolResultSchema.parse(await mcp.client.callTool({ name: "presentation_get_snapshot", arguments: { snapshotUri: resource.descriptor.snapshotUri } }));
      expect(replay._meta?.[presentationCardMetadataKey]).toBeUndefined();
      expect(replay.structuredContent).toMatchObject({ kind: "presentation_snapshot_reference" });
      expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({ inputState: "input_pending" });
      await mcp.client.callTool({ name: "presentation_cancel_decision", arguments: { cardId: reference.cardId } });
      const reopened = CallToolResultSchema.parse(await mcp.client.callTool({ name: "presentation_start_view", arguments: { cardId: reference.cardId, cardOpenRequestId: createCardOpenRequestId() } }));
      expect(reopened.structuredContent).toMatchObject({ state: { record: { inputState: "input_closed", closeReason: "discarded", outcome: null } }, display: { kind: "summary" }, actions: [] });
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
      const creating = await publishDecision(mcp, "signing", signingCommand);
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      const first = (await test.cards.get(reference)).presentation.state;
      if (first.record === null || first.record.kind === "read") throw new Error("Stateful card required.");
      const { cardId } = first.record;
      const context = { cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      const read = await mcp.client.callTool({ name: "presentation_get_card", arguments: { kind: "card", cardId } });
      expect(read).toMatchObject({ structuredContent: { state: { mode: "interactive", record: { cardId, inputState: "input_pending" } } } });
      expect(test.database.presentationCardStore().read(cardId)).toEqual(first.record);
      for (const input of [context, { ...context }]) {
        const opened = await mcp.client.callTool({ name: "presentation_start_view", arguments: input });
        expect(opened).toMatchObject({ structuredContent: { state: { mode: "interactive", record: { cardId, inputState: "input_pending" } } } });
      }
      const result = CallToolResultSchema.parse(await mcp.client.callTool({ name: "presentation_cancel_decision", arguments: { cardId } }));
      expect(result).toMatchObject({ structuredContent: { state: { mode: "static", record: { cardId, inputState: "input_closed", closeReason: "discarded", outcome: null } } } });
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
      const {reference, review} = await createNativeSigningCard(test, session);
      const first = await invoke(cardControlResources.read, reference);
      const context = { cardId: first.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      await invoke(cardControlResources.open, context);
      signing.disconnect();
      for (const [path, body, code] of [
        [cardControlResources.startDecision, {input: cardDecisionStartContract.parseInput({kind: "signing", source: {kind: "new", input: signingCommand}}), publicationKey: null}, "wallet_not_connected"],
        [cardControlResources.action, { ...context, decision: { review, initiatedBy: "mcp_app" } }, "wallet_session_unusable"],
      ] as const) {
        const sent = await session.send({ method: "POST", path, body: captureCanonicalJson(body), maximumResponseBytes: internalResponseLimitBytes,
          responseDeadlineMilliseconds: requestReviewLimits.reviewLifetimeMilliseconds });
        if (sent.status !== "response_received") throw new Error("Native failure response required");
        expect(sent.response.statusCode).toBe(409);
        expect(JSON.parse(new TextDecoder().decode(sent.response.bytes))).toMatchObject({ code });
        expect(cardControlContracts.read.parseFailure(createSigningFailure(code))).toEqual(createSigningFailure(code));
      }
      expect(await invoke(cardControlResources.read, { kind: "card", cardId: context.cardId })).toMatchObject({
        mode: "static", record: {inputState: "input_closed", closeReason: "invalidated", outcome: null},
      });
      expect(signing.startRequest).not.toHaveBeenCalled();
    } finally { await session.close(); await test.closeAll(); await signing.close(); }
  });

  it("carries one actual signature through authenticated native controls and reads only its saved outcome on reopen", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    const session = await test.owner.openOwnerSession();
    const invoke = (path: string, body: CanonicalJson) => invokeNativeControl(session, path, body);
    try {
      const refused = await fetch(`${fixedOrigin}${cardControlResources.startDecision}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({input: cardDecisionStartContract.parseInput({kind: "signing", source: {kind: "new", input: signingCommand}}), publicationKey: null}),
      });
      expect(refused.status).toBe(401); await refused.arrayBuffer();
      expect(signing.startRequest).not.toHaveBeenCalled();
      const {reference, review} = await createNativeSigningCard(test, session);
      const first = await invoke(cardControlResources.read, reference);
      const context = { cardId: first.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      expect(await invoke(cardControlResources.open, context)).toMatchObject({ mode: "interactive" });
      expect(await invoke(cardControlResources.open, context)).toMatchObject({ record: { inputState: "input_pending" } });
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
      const {reference, review} = await createNativeSigningCard(test, session);
      const first = await invoke(cardControlResources.read, reference);
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
      const creating = await publishDecision(mcp, "signing", signingCommand);
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      if (reference.kind !== "card") throw new Error("Saved card reference required.");
      const review = signingSource(test, reference.cardId);
      expect(test.database.presentationCardStore().read(reference.cardId)).toMatchObject({ operationId: review.operationId });
      const admission = await admitPresentationToolResult(app, creating, firstView.signal);
      if (admission.status !== "card") throw new Error("State-first card admission required.");
      await mountCard(app, admission.card, createCardOpenRequestId(), document.body, firstView.signal);
      expect(signing.startRequest).not.toHaveBeenCalled();
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Request signature")!.click();
      await vi.waitFor(() => expect(signing.startRequest).toHaveBeenCalledOnce());
      const signature = await signer.signMessage({ message }); signing.reply({ status: "signature_returned", signature });
      await vi.waitFor(() => expect(document.body.textContent).toContain(signature));
      expect(directResponse?._meta?.[signingSignatureMetadataKey]).toBe(signature);
      expect(JSON.stringify(directResponse?.content)).not.toContain(signature);
      expect(JSON.stringify(directResponse?.structuredContent)).not.toContain(signature);
      expect(test.application.signing.get(review.operationId).review).toBeNull();
      expect(test.application.activity.list({ account: review.account, cursor: null }).records).toEqual([]);
      firstView.abort(); test.readPresentation.mockClear();
      await mountCard(app, admission.card, createCardOpenRequestId(), document.body, secondView.signal);
      expect(document.body.textContent).toContain("Verified");
      expect(document.body.textContent).not.toContain(signature);
      expect(document.querySelectorAll("button")).toHaveLength(0);
      expect(test.readPresentation).not.toHaveBeenCalled();
      const savedRecord = test.database.presentationCardStore().read(reference.cardId);
      if (savedRecord?.kind !== "signing") throw new Error("Saved signature classification required.");
      expect(savedRecord.outcome).toEqual({ kind: "signing", status: "verified" });
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally {
      firstView.abort(); secondView.abort(); await mcp.close(); await test.closeAll(); await signing.close();
      dom.window.close(); vi.unstubAllGlobals();
    }
  });

  const signingTerminal = (output: string[], errors: string[], signal: AbortSignal) => {
    const stdout = Object.assign(new Writable({write(chunk, _encoding, callback) { output.push(chunk.toString()); callback(); }}), {isTTY: true});
    const stderr = new Writable({write(chunk, _encoding, callback) { errors.push(chunk.toString()); callback(); }});
    const stdin = Object.assign(new PassThrough(), {isTTY: true});
    const host = Object.assign(new EventEmitter(), {stdin, stdout, stderr});
    const native = createProcessTerminal(host);
    let closeWork: Promise<void> | undefined;
    const terminal = {...native, inputIsTTY: true, outputIsTTY: true, interruptSignal: signal,
      readLine: vi.fn(async () => "y"),
      closeOutput(): Promise<void> {
        closeWork ??= (async () => {
          try { native.dispose(); await native.outputOwner.settle(); }
          finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); }
        })();
        return closeWork;
      }};
    Object.defineProperty(stdin, "isTTY", {get: () => terminal.inputIsTTY});
    Object.defineProperty(stdout, "isTTY", {get: () => terminal.outputIsTTY});
    return terminal;
  };

  it("delivers the exact usable signature only after the independent TTY decision", async () => {
    const signing = createSigningFixture();
    const test = await fixture(signing);
    const output: string[] = [];
    const file = resolve(dirname(test.path), "message.json");
    const terminal = signingTerminal(output, output, new AbortController().signal);
    terminal.readLine.mockResolvedValue("n");
    try {
      await writeFile(file, JSON.stringify(signingCommand.payload));
      const command = parseSigningCliCommand(["signing", "start", "--active", "--file", file]);
      for (const extra of ["--json", "--yes", "--output"]) expect(() => parseSigningCliCommand(["signing", "start", "--active", "--file", file, extra])).toThrow();
      expect(await runSigningCliCommand(test.client, command, { ...terminal, inputIsTTY: false })).toBe(2);
      expect(signing.startRequest).not.toHaveBeenCalled();
      expect(terminal.readLine).not.toHaveBeenCalled();
      expect(await runSigningCliCommand(test.client, command, terminal)).toBe(0);
      expect(signing.startRequest).not.toHaveBeenCalled();
      terminal.readLine.mockResolvedValue("y");
      const pending = runSigningCliCommand(test.client, command, terminal);
      await signing.sent;
      const signature = await signer.signMessage({ message });
      signing.reply({ status: "signature_returned", signature });
      expect(await pending).toBe(0);
      await terminal.closeOutput();
      expect(output.join("\n")).toContain("Closed");
      expect(output.filter((line) => line.includes(signature))).toEqual([`Signature: ${signature}\n`]);
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally { await terminal.closeOutput(); await test.closeAll(); await signing.close(); }
  });

  it.each([
    {result: "verified", end: "interrupt", starts: 1, exit: 2,
      text: "The signature matches the data and account in your request."},
    {result: "verified", end: "expiry", starts: 1, exit: 2,
      text: "The signature matches the data and account in your request."},
    {result: "verified", end: "terminal_unavailable", starts: 1, exit: 2,
      text: "The signature matches the data and account in your request."},
    {result: "wallet_rejected", end: "interrupt", starts: 1, exit: 2,
      text: "Your wallet declined this request."},
    {result: "not_sent_before_handoff", end: "interrupt", starts: 0, exit: 2,
      text: "This request was not sent to your wallet."},
    {result: "not_sent_after_handoff", end: "expiry", starts: 1, exit: 2,
      text: "This request was not sent to your wallet."},
    {result: "failure", end: "interrupt", starts: 0, exit: 5,
      text: "Request failed\nThis wallet connection cannot provide the accounts or permissions required by this request.\nError details\nError code: wallet_session_unusable\nReported reason: The WalletConnect session cannot satisfy this request."},
    {result: "verification_failed", end: "expiry", starts: 1, exit: 2,
      text: "The signature did not match the data and account in your request. No usable signature is shown."},
    {result: "unsupported_signature", end: "interrupt", starts: 1, exit: 2,
      text: "Little John MCP could not verify this signature format. No usable signature is shown."},
  ] as const)("preserves an admitted $result after $end during actual action-session release", async (input) => {
    const signing = createSigningFixture();
    if (input.result === "not_sent_before_handoff") {
      // Permission changes after the last asynchronous check and before the
      // synchronous native admission. The real admission rejects before send.
      signing.wallet.hasPendingRequest = () => { signing.removeMethod(); return false; };
    } else if (input.result === "not_sent_after_handoff") {
      signing.startRequest.mockRejectedValueOnce(new Error("Synthetic Wallet handoff rejection."));
    }
    const test = await fixture(signing);
    const barrier = signingActionCloseBarrier(test.owner);
    const controller = new AbortController();
    const output: string[] = [], errors: string[] = [];
    const terminal = signingTerminal(output, errors, controller.signal);
    terminal.readLine.mockImplementation(async () => { if (input.result === "failure") signing.removeMethod(); return "y"; });
    const file = resolve(dirname(test.path), "message.json");
    const signature = input.result === "verified" || input.result === "verification_failed"
      ? await signer.signMessage({message: input.result === "verified" ? message : "Different synthetic message"}) : undefined;
    let pending: Promise<number> | undefined;
    let completed = false;
    let restoreDateNow: (() => void) | undefined;
    try {
      await writeFile(file, JSON.stringify(signingCommand.payload));
      pending = runSigningCliCommand(barrier.client, parseSigningCliCommand(["signing", "start", "--active", "--file", file]), terminal);
      void pending.then(() => {completed = true;}, () => {completed = true;});
      if (["verified", "verification_failed", "wallet_rejected", "unsupported_signature"].some((result) => result === input.result)) {
        await signing.sent;
        signing.reply(signature === undefined
          ? {status: input.result === "wallet_rejected" ? "wallet_rejected" : "unsupported_signature"}
          : {status: "signature_returned", signature});
      }
      await barrier.closing;
      expect(completed).toBe(false);
      expect(barrier.actionClosed).toBe(false);
      const packet = barrier.packet;
      const review = barrier.review;
      if (packet === undefined || review === undefined) throw new Error("The real admitted action response and original Review are required.");
      const body = JSON.parse(new TextDecoder().decode(packet.bytes));
      expect(packet.cacheControl).toBe("no-store");
      if (input.result === "failure") {
        expect(packet.statusCode).toBe(409);
        expect(packet.contentType).toBe("application/problem+json");
        expect(body).toMatchObject({code: "wallet_session_unusable", detail: "The WalletConnect session cannot satisfy this request."});
      } else {
        expect(packet.statusCode).toBe(200);
        expect(packet.contentType).toBe("application/json");
        expect(body.outcome).toMatchObject({status: input.result.startsWith("not_sent_") ? "not_sent" : input.result,
          operationId: review.operationId, account: review.account, method: "personal_sign", messageHash: review.messageHash});
        if (input.result === "verified") {
          expect(body.signature).toBe(signature);
          expect(body.outcome.signatureDigest).toBe(createHash("sha256").update(Buffer.from(signature!.slice(2), "hex")).digest("hex"));
        } else expect(body).not.toHaveProperty("signature");
      }
      if (input.end === "interrupt") controller.abort();
      else if (input.end === "expiry") {
        const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.actionExpiresAt));
        restoreDateNow = () => {dateNow.mockRestore();};
      }
      else terminal.outputIsTTY = false;
      barrier.release();
      expect(await pending).toBe(input.exit);
      await terminal.closeOutput();
      expect(barrier.actionClosed).toBe(true);
      expect([...output, ...errors].join("")).toContain(`${input.text}\n`);
      expect([...output, ...errors].join("")).not.toContain("Waiting ended without an established result.");
      expect(output.some((line) => line.startsWith("Signature:"))).toBe(false);
      if (input.result === "verified") {
        expect(errors).toEqual(["Signature unavailable. The verified signature could not be displayed here. No new signature request will be sent automatically.\n"]);
        expect([...output, ...errors].join("")).not.toContain(signature);
      } else if (input.result === "failure") expect(errors).toEqual([`${input.text}\n`]);
      else expect(errors).toEqual([]);
      expect(barrier.paths).toEqual([signingResources.start, signingResources.request]);
      expect(signing.startRequest).toHaveBeenCalledTimes(input.starts);
      expect(test.application.signing.get(review.operationId).review).toBeNull();
      expect(test.application.activity.list({account: review.account, cursor: null}).records).toEqual([]);
    } finally {
      barrier.release();
      await pending?.catch(() => undefined);
      restoreDateNow?.();
      await terminal.closeOutput(); await barrier.client.close(); await test.closeAll(); await signing.close();
    }
  });

  it("keeps an unobserved action response unknown and discards its late synthetic signature", async () => {
    const signing = createSigningFixture(); const test = await fixture(signing);
    const controller = new AbortController(); const output: string[] = [], errors: string[] = [];
    const terminal = signingTerminal(output, errors, controller.signal);
    const file = resolve(dirname(test.path), "message.json");
    let pending: Promise<number> | undefined;
    let replied = false;
    const signature = await signer.signMessage({message});
    try {
      await writeFile(file, JSON.stringify(signingCommand.payload));
      pending = runSigningCliCommand(test.client, parseSigningCliCommand(["signing", "start", "--active", "--file", file]), terminal);
      await signing.sent;
      controller.abort();
      expect(await pending).toBe(8);
      signing.reply({status: "signature_returned", signature}); replied = true;
      await terminal.closeOutput();
      expect(errors).toEqual(["Little John MCP stopped waiting without a confirmed wallet result. The request may still complete or may already have completed. It will not be repeated automatically.\n"]);
      expect(output.some((line) => line.startsWith("Signature:"))).toBe(false);
      expect([...output, ...errors].join("")).not.toContain(signature);
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally {
      if (!replied && signing.startRequest.mock.calls.length !== 0) signing.reply({status: "signature_returned", signature});
      controller.abort(); await pending?.catch(() => undefined);
      await terminal.closeOutput(); await test.closeAll(); await signing.close();
    }
  });
  it("carries a transaction through the real MCP card path and refuses duplicate or unwrapped App input", async () => {
    const test = await fixture(); const mcp = await connectCardMcp(test);
    try {
      const creating = await publishDecision(mcp, "transaction", test.input.request);
      const reference = cardReferenceSchema.parse(creating._meta?.[presentationCardMetadataKey]);
      if (reference.kind !== "card") throw new Error("Saved card required.");
      const context = { cardId: reference.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
      await mcp.client.callTool({ name: "presentation_start_view", arguments: context });
      const opened = await openMcpCard(mcp, reference.cardId);
      if (opened.display.kind !== "decision") throw new Error("Complete saved decision display required.");
      const resource = opened.display.resource;
      expect(resource.descriptor.source.kind).toBe("review_memory");
      expect(test.database.presentationSnapshotStore().read(resource.descriptor.snapshotId).status).toBe("unavailable");
      const review = transactionSource(test, reference.cardId);
      if (review.state !== "ready_for_wallet_review") throw new Error("Ready transaction required.");
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
      expect(output.join("\n")).toContain("Closed");
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
