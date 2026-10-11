import {immutableReadResultIdentity} from "../../src/interfaces/immutable-read-contracts.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createSigningFixture, command as signingCommand, signer, message } from "../review/signing-fixture.js";
import { cardActionEnvelopeSchema, presentationCardMetadataKey, cardCreationResultSchema, cardReadReferenceSchema } from "../../src/interfaces/mcp-app/card-contract.js";
import { normalizeCodexTurnContext } from "../../src/interfaces/mcp-app/publication-context.js";
import { createPresentationPublicationKeyOwner, type PresentationPublicationKeyOwner } from "../../src/runtime/presentation-publication-key.js";
import { loadOrCreateControlCredential } from "../../src/runtime/control-credential.js";
import { parseProfileId } from "../../src/runtime/runtime-identity.js";
import { cardErrorRegistry } from "../../src/interfaces/mcp-app/card-contract.js";
import { cardInterfaceErrorMappings } from "../../src/interfaces/mcp-app/card-errors.js";
import { signingDirectDecisionSchema } from "../../src/review/signing-contracts.js";
import { signingSignatureMetadataKey } from "../../src/interfaces/signing-result.js";
import { cardControlResources } from "../../src/interfaces/mcp-app/card-controls.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type ClientCapabilities,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {accountBalanceInputSchema} from "../../src/account-assets/balance-contract.js";
import {canonicalJsonStringify, canonicalSha256, captureCanonicalJson, createApplicationFailure, parseUtcTimestamp, projectCapabilities} from "../../src/core/index.js";
import {
  createDeliveryUnknown,
  declaredMcpToolNames,
  LocalOperationClient,
  operationInterfaceBindingList,
  parseMcpToolName,
} from "../../src/interfaces/index.js";
import { resolveLocalOperationIdentity } from "../../src/interfaces/local-operation.js";
import {
  admitMcpToolResultDeliveryError,
  admitMcpToolResultDeliveryErrorContent,
  admitMcpToolResultForDelivery,
} from "../../src/interfaces/mcp-result.js";
import {
  admitOperationToolResultDescriptor,
  admitPresentationSnapshotResource,
  operationToolResultMetadataKey,
} from "../../src/interfaces/mcp-app/contracts.js";
import { createMcpAppResource } from "../../src/interfaces/mcp-app/server.js";
import {
  createMcpServer,
  createMcpToolRegistry,
  type McpRuntimePort,
  type McpServerRuntimePort,
} from "../../src/interfaces/mcp.js";
import { stockTokenTradeHistoryInterface } from "../../src/interfaces/identities.js";
import { interfaceReadCapabilityRegistry } from "../../src/interfaces/identities.js";
import {stockTokenTradeHistoryHumanSummary} from "../../src/interfaces/stock-token-trade-history-presentation.js";
import {
  createStockTokenTradeHistoryFailure,
  stockTokenTradeHistoryInterfaceErrorMappings,
} from "../../src/stock-token-trade-history/errors.js";
import { tokenSelectionReviewRequestSchema } from "../../src/token-catalog/index.js";
import {
  toProblemDetails,
  type RuntimeDispatchRequest,
  type RuntimeDispatchResponse,
} from "../../src/runtime/index.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import type { PresentationSnapshotStore } from "../../src/runtime/presentation-snapshot.js";
import { openTestOwnerSession } from "./owner-session-harness.js";
import {
  stockTokenTradeHistoryAvailableFixture,
  stockTokenTradeHistoryUnavailableFixture,
} from
  "./stock-token-trade-history-fixture.js";
import { createTokenOperation } from "../token-catalog/harness.js";
import { createPriceFixture, oversizedCandidateResponse } from "../stock-token-prices/fixture.js";
import { stockTokenPricesCapability } from "../../src/stock-token-prices/contracts.js";
import { stockTokenPricesInterfaceErrorMappings } from "../../src/stock-token-prices/errors.js";
import { admitCreatingToolError } from "../../src/interfaces/mcp-app/view/creating-tool-error.js";
import { createReceiptFixture } from "../receipt-activity/fixture.js";
import { createReadyExchangeReview } from "../../src/review/contracts.js";
import { activityToolContracts, exchangeToolContracts } from "../../src/interfaces/exchange-tool-contracts.js";
import { exchangeResources } from "../../src/interfaces/exchange-bindings.js";

// Literal expectations follow the accepted invocation-effect table, including
// every admitted branch. They do not derive annotations from runtime metadata.
const expectedToolAnnotations: Readonly<Record<string, readonly [boolean, boolean, boolean, boolean]>> = Object.freeze({
  account_list_assets: [false, true, false, true],
  market_get_stock_token_prices: [false, true, false, true],
  market_get_stock_token_trade_history: [false, true, false, true],
  market_list_stock_tokens: [false, true, false, true],
  read_get_account_balance: [false, true, false, true],
  read_get_chain_status: [false, false, false, true],
  read_inspect_address: [false, true, false, true],
  read_inspect_transaction: [false, false, false, true],
  read_list_capabilities: [true, false, true, false],
  token_get_selection: [false, true, false, false],
  token_inspect_contract: [false, false, false, true],
  token_list_selections: [false, true, false, false],
  uniswap_v2_quote_exact_input: [false, false, false, true],
  uniswap_v4_list_pools: [false, true, false, true],
  wallet_get_connection: [false, true, false, false],
  wallet_start_connection_change_review: [false, true, false, false],
  wallet_start_connection: [false, true, true, true],
  wallet_start_disconnection: [false, true, true, true],
  wallet_get_operation: [false, true, true, true],
  wallet_cancel_operation: [false, true, true, true],
  wallet_get_account_selection: [false, true, true, false],
  wallet_select_account: [false, true, true, false],
  token_start_selection_change_review: [false, true, false, true],
  token_add_selection: [false, true, true, true],
  token_remove_selection: [false, true, true, false],
  token_get_operation: [true, false, true, false],
  exchange_start_review: [false, true, false, true],
  exchange_get_review: [true, false, true, false],
  exchange_cancel_review: [false, true, true, false],
  exchange_request_transaction: [false, true, false, true],
  activity_get_transaction: [true, false, true, false],
  activity_list_transactions: [false, false, false, false],
  activity_inspect_transaction: [false, true, false, true],
  signing_start_review: [false, true, false, false],
  signing_get_review: [true, false, true, false],
  signing_cancel_review: [false, true, true, false],
  signing_request_signature: [false, true, false, true],
  presentation_start_read: [false, true, false, true],
  presentation_start_decision: [false, true, false, true],
  presentation_get_card: [false, true, true, true],
  presentation_start_view: [false, true, true, true],
  presentation_cancel_decision: [false, true, true, true],
  presentation_cancel_wait: [false, true, true, true],
  presentation_get_snapshot: [true, false, true, false],
  presentation_get_snapshot_chunk: [true, false, true, false],
  presentation_get_result_part: [true, false, true, false],
} as const);

const expectToolAnnotations = (tool: Readonly<{name: string; annotations?: unknown}>): void => {
  const tuple = expectedToolAnnotations[tool.name];
  expect(tuple, tool.name).toBeDefined();
  if (tuple === undefined) throw new Error(`Missing effect expectation for ${tool.name}.`);
  const [readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = tuple;
  expect(tool.annotations, tool.name).toEqual({readOnlyHint, destructiveHint, idempotentHint, openWorldHint});
};

const unusedSnapshotStore: PresentationSnapshotStore = Object.freeze({
  prepare: () => { throw new Error("Ordinary MCP must not prepare a snapshot."); },
  commit: () => { throw new Error("Ordinary MCP must not commit a snapshot."); },
  read: () => { throw new Error("Ordinary MCP must not read a snapshot."); },
  readMetadata: () => {throw new Error("This fixture expects no snapshot metadata lookup.");},
  readResultChunk: () => { throw new Error("Ordinary MCP must not read a snapshot chunk."); },
});
const testAppResource = createMcpAppResource("<!doctype html><title>Little John test</title>");

class FakeRuntime implements McpServerRuntimePort {
  readonly requests: RuntimeDispatchRequest[] = [];
  handler: (request: RuntimeDispatchRequest) => RuntimeDispatchResponse | Promise<RuntimeDispatchResponse>;
  readonly snapshotStore: PresentationSnapshotStore;
  readonly publicationKeys: PresentationPublicationKeyOwner;

  constructor(
    handler?: FakeRuntime["handler"],
    snapshotStore: PresentationSnapshotStore = unusedSnapshotStore,
    publicationKeys: PresentationPublicationKeyOwner = {derive: () => { throw new Error("This call must not derive a publication key."); }},
  ) {
    this.handler = handler ?? (() => ({ status: 500, body: { ok: false } }));
    this.snapshotStore = snapshotStore;
    this.publicationKeys = publicationKeys;
  }

  async dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    this.requests.push(request);
    const result = await this.handler(request);
    // This fixture supplies admitted domain values. The native transport now
    // carries them in its declared inline branch; the real reference producer
    // is exercised by immutable-read.test.ts.
    return request.path === immutableReadResultIdentity.path && result.status === 200
      ? {status: 200, body: {kind: "inline", result: result.body}} : result;
  }

  openOwnerSession(signal?: AbortSignal) {
    return openTestOwnerSession(this, signal);
  }

  presentationSnapshotStore(): PresentationSnapshotStore { return this.snapshotStore; }
  presentationPublicationKeys(): PresentationPublicationKeyOwner { return this.publicationKeys; }
}

interface ConnectedMcp {
  readonly client: Client;
  readonly server: Server;
  readonly operationClient: LocalOperationClient;
  close(): Promise<void>;
}

const openConnections: ConnectedMcp[] = [];
const openDatabases: ProductDatabase[] = [];
const temporaryDirectories: string[] = [];

// The pinned SDK's ESM provider declaration uses the CommonJS Ajv namespace
// as a type under NodeNext. Load its supported CommonJS entry and retain the
// SDK's public validator interface without disabling dependency type checks.
const { AjvJsonSchemaValidator } = createRequire(import.meta.url)("@modelcontextprotocol/sdk/validation/ajv") as {
  AjvJsonSchemaValidator: new (ajv: Ajv2020) => jsonSchemaValidator;
};
const addFormats = createRequire(import.meta.url)("ajv-formats") as (ajv: Ajv2020) => Ajv2020;
// MCP 2025-11-25 defaults to 2020-12, as does the owning schema projection.
// The pinned SDK's Node default still uses draft-07 and misreads prefixItems.
// Its supported validator injection keeps tuple and format checks enabled.
const officialSchemaValidator = new AjvJsonSchemaValidator(addFormats(new Ajv2020({
  strict: false, validateFormats: true, validateSchema: true, allErrors: true,
})));
const compiledOutputSchemas = new Map<string, JsonSchemaValidator<unknown>>();
const outputSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType) {
    // In-memory clients receive fresh JSON copies of the same product schemas.
    // Reuse compilation by complete schema content; validation stays in the SDK.
    const key = JSON.stringify(schema);
    let validator = compiledOutputSchemas.get(key);
    if (validator === undefined) {
      validator = officialSchemaValidator.getValidator(schema);
      compiledOutputSchemas.set(key, validator);
    }
    return validator as JsonSchemaValidator<T>;
  },
};

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const connectMcp = async (
  runtime: McpServerRuntimePort,
  capabilities: ClientCapabilities,
  name = "littlejohn-test",
): Promise<ConnectedMcp> => {
  const operationClient = new LocalOperationClient({ ownerSessions: runtime });
  const server = createMcpServer(runtime, operationClient, testAppResource);
  const client = new Client({ name, version: "1.0.0" }, { capabilities, jsonSchemaValidator: outputSchemaValidator });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const connection = Object.freeze({
    client,
    server,
    operationClient,
    close: async (): Promise<void> => {
      await Promise.allSettled([client.close(), server.close(), operationClient.close()]);
    },
  });
  openConnections.push(connection);
  return connection;
};

const connectOrdinary = (runtime: McpServerRuntimePort): Promise<ConnectedMcp> =>
  connectMcp(runtime, {});

const appCapabilities: ClientCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};
const connectApp = (runtime: McpServerRuntimePort): Promise<ConnectedMcp> => connectMcp(runtime, appCapabilities);
const connectCodex = (runtime: McpServerRuntimePort): Promise<ConnectedMcp> => connectMcp(runtime, appCapabilities, "codex-mcp-client");
const publicationKeys = async (): Promise<PresentationPublicationKeyOwner> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-publication-context-"));
  temporaryDirectories.push(directory);
  return createPresentationPublicationKeyOwner({credential: await loadOrCreateControlCredential(directory, resolve(directory, "control.key")),
    profileId: parseProfileId(Buffer.alloc(16, 67).toString("base64url"))});
};
const turnMetadata = (turn = "turn-one") => ({"x-codex-turn-metadata": {thread_id: "thread-one", turn_id: turn}});

// Observe the production server's registered protocol handler so cancellation
// can occur after native admission without the SDK client discarding its own reply.
const invokeRegisteredTool = async (server: Server, name: string, argumentsValue: unknown, signal: AbortSignal,
  metadata?: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
  const handlers = (server as unknown as {_requestHandlers: Map<string, (request: unknown, extra: {signal: AbortSignal}) => Promise<unknown>>})._requestHandlers;
  const handler = handlers.get("tools/call");
  if (handler === undefined) throw new Error("Production tool handler required.");
  return CallToolResultSchema.parse(await handler({jsonrpc: "2.0", id: 101, method: "tools/call", params: {name, arguments: argumentsValue,
    ...(metadata === undefined ? {} : {_meta: metadata})}}, {signal}));
};

// The SDK deadline also bounds these real client calls. The runner must not
// cancel their setup/schema compilation at its shorter five-second default.
describe("MCP binding projection", { timeout: DEFAULT_REQUEST_TIMEOUT_MSEC }, () => {
  it("delivers nullable lookup successes through the SDK without changing canonical result evidence", async () => {
    const fixture = await createReceiptFixture();
    try {
      fixture.receive();
      const record = fixture.activity.get(fixture.reference.account, fixture.hash);
      const review = createReadyExchangeReview(fixture.original.review);
      expect(record).not.toBeNull();
      let present = false;
      const runtime = new FakeRuntime((request) => {
        if (request.path === immutableReadResultIdentity.path && (request.body as Record<string, unknown>)["contractId"] === "activity.get_transaction") return { status: 200, body: captureCanonicalJson(present ? record : null) };
        if (request.path === exchangeResources.review(review.observation.data.operationId)) return { status: 200, body: captureCanonicalJson(present ? review : null) };
        throw new Error("Only the exact readonly lookup is allowed.");
      });
      const { client } = await connectOrdinary(runtime);
      const tools = await client.listTools(); // The SDK validates each advertised output schema.
      const cases = [
        { name: activityToolContracts.get.mcp.name, arguments: { account: fixture.reference.account, transactionHash: fixture.hash }, value: record },
        { name: exchangeToolContracts.get.mcp.name, arguments: { operationId: review.observation.data.operationId }, value: review },
      ];
      for (const exists of [false, true]) {
        present = exists;
        for (const call of cases) {
          const original = exists ? call.value : null;
          const result = await client.callTool({ name: call.name, arguments: call.arguments });
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toEqual({ value: original });
          expect(result.content).toEqual([{ type: "text", text: canonicalJsonStringify(captureCanonicalJson({ value: original })) }]);
          const bytes = canonicalJsonStringify(captureCanonicalJson(original));
          const descriptor = admitOperationToolResultDescriptor(result._meta?.[operationToolResultMetadataKey]);
          expect(descriptor).toMatchObject({ toolName: call.name, isError: false,
            resultUtf8Bytes: Buffer.byteLength(bytes), resultSha256: createHash("sha256").update(bytes).digest("hex") });
        }
      }
      const reads = runtime.requests.length;
      expect(reads).toBe(4);
      const outputSchema = tools.tools.find((tool) => tool.name === exchangeToolContracts.get.mcp.name)!.outputSchema!;
      // Same tuple length and valid surrounding Review: the first entry alone
      // violates prefixItems. This rejects a validator that merely ignores it.
      const data = review.observation.data;
      if (!("displayScaling" in data)) throw new Error("The swap fixture requires display scaling.");
      const malformed = { value: { ...review, observation: { ...review.observation,
        data: { ...data, displayScaling: [null, data.displayScaling[1]] },
      } } };
      expect(outputSchemaValidator.getValidator(outputSchema as JsonSchemaType)(malformed).valid).toBe(false);
      for (const call of cases) {
        const rejected = await client.callTool({ name: call.name, arguments: {} });
        expect(rejected.isError).toBe(true);
        expect(rejected.structuredContent).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(rejected.structuredContent).not.toHaveProperty("value");
      }
      expect(runtime.requests).toHaveLength(reads);
    } finally { await fixture.close(); }
  });

  it.each(["received", "lost"] as const)("preserves committed selection meaning after MCP cancellation when the native response is %s", async (delivery) => {
    const caller = new AbortController();
    const cardId = Buffer.alloc(32, 85).toString("base64url");
    const selector = {connectionId: `wallet-session:${Buffer.alloc(32, 1).toString("base64url")}`, chainId: "eip155:4663",
      account: {chainId: "eip155:4663", address: `0x${"1".repeat(40)}`}, expectedConnectionRevision: "4", expectedSelectionRevision: "4"};
    const selected = {connectionId: selector.connectionId, connectionRevision: "4", chainId: selector.chainId, account: selector.account, selectionRevision: "5"};
    const runtime = new FakeRuntime((request) => {
      expect(request.path).toBe(cardControlResources.action);
      if (delivery === "lost") caller.abort();
      return {status: 200, body: captureCanonicalJson({result: selected, presentation: {status: "unavailable", cardId}})};
    });
    const connection = await connectApp(runtime);
    if (delivery === "received") {
      const invoke = connection.operationClient.invoke.bind(connection.operationClient);
      vi.spyOn(connection.operationClient, "invoke").mockImplementationOnce(async <Input, Result>(identity: import("../../src/interfaces/local-operation.js").LocalOperationIdentity<Input, Result>, inputValue: unknown, signal?: AbortSignal) => {
        const result = await invoke(identity, inputValue, signal);
        expect(result).toMatchObject({ok: true, value: {result: selected}});
        caller.abort();
        return result;
      });
    }
    const result = await invokeRegisteredTool(connection.server, "wallet_select_account", {cardId,
      cardOpenRequestId: Buffer.alloc(32, 86).toString("base64url"), decision: selector}, caller.signal);
    if (delivery === "received") {
      expect(result.isError).not.toBe(true); expect(result.structuredContent).toEqual(selected);
    } else {
      expect(result.structuredContent).toEqual({status: "delivery_unknown", action: "select_account", selector, cardId,
        recovery: {capabilityId: "wallet.account_selection", input: {chainId: selector.chainId}}, resendAllowed: false});
    }
    expect(JSON.stringify(result.structuredContent)).not.toContain("request_aborted");
    expect(runtime.requests.map((request) => request.path)).toEqual([cardControlResources.action]);
  });

  it("preserves the verified public outcome while disposing cancelled private signature carriage", async () => {
    const source = createSigningFixture();
    try {
      const review = await source.coordinator.start(signingCommand, new AbortController().signal);
      const cardId = Buffer.alloc(32, 85).toString("base64url");
      const runtime = new FakeRuntime(async (request) => ({status: 200, body: captureCanonicalJson({
        result: await source.coordinator.confirm(signingDirectDecisionSchema.parse(cardActionEnvelopeSchema.parse(request.body).decision), new AbortController().signal),
        presentation: {status: "unavailable", cardId}})}));
      const connection = await connectApp(runtime); const caller = new AbortController();
      const invoke = connection.operationClient.invoke.bind(connection.operationClient);
      vi.spyOn(connection.operationClient, "invoke").mockImplementationOnce(async <Input, Result>(identity: import("../../src/interfaces/local-operation.js").LocalOperationIdentity<Input, Result>, inputValue: unknown, signal?: AbortSignal) => {
        const result = await invoke(identity, inputValue, signal); caller.abort(); return result;
      });
      const pending = invokeRegisteredTool(connection.server, "signing_request_signature", {cardId,
        cardOpenRequestId: Buffer.alloc(32, 86).toString("base64url"), decision: {review, initiatedBy: "mcp_app"}}, caller.signal);
      await source.sent;
      const signature = await signer.signMessage({message}); source.reply({status: "signature_returned", signature});
      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({status: "verified", operationId: review.operationId,
        signatureDigest: createHash("sha256").update(Buffer.from(signature.slice(2), "hex")).digest("hex")});
      expect(result._meta).not.toHaveProperty(signingSignatureMetadataKey);
      expect(JSON.stringify(result)).not.toContain(signature); expect(source.startRequest).toHaveBeenCalledOnce();
    } finally {await source.close();}
  });

  it("normalizes only own thread and turn data properties without reading provider extras", () => {
    let extraReads = 0;
    const carrier = {thread_id: "thread-one", turn_id: "turn-one",
      get providerExtra(): never { extraReads += 1; throw new Error("Provider extras cannot grant authority."); }};
    expect(normalizeCodexTurnContext({"x-codex-turn-metadata": carrier})).toEqual({threadId: "thread-one", turnId: "turn-one"});
    expect(extraReads).toBe(0);
    let selectedReads = 0;
    const selectedAccessor = {get thread_id() {selectedReads += 1; return "thread-one";}, turn_id: "turn-one"};
    for (const metadata of [undefined, {}, {"x-codex-turn-metadata": JSON.stringify({thread_id: "thread-one", turn_id: "turn-one"})},
      {"x-codex-turn-metadata": Object.create({thread_id: "thread-one", turn_id: "turn-one"})},
      {"x-codex-turn-metadata": selectedAccessor}, {"x-codex-turn-metadata": {thread_id: "thread-one", turn_id: "bad\nturn"}}]) {
      expect(() => normalizeCodexTurnContext(metadata)).toThrow();
    }
    expect(selectedReads).toBe(0);
  });

  it("uses the same HMAC publication key for the same normalized Codex prompt and associates the committed card", async () => {
    const keys = await publicationKeys();
    const cards = new Map<string, string>();
    const runtime = new FakeRuntime((request) => {
      expect([cardControlResources.startRead, cardControlResources.startDecision]).toContain(request.path);
      const body = request.body as Readonly<{input: unknown; publicationKey: string}>;
      const previous = cards.get(body.publicationKey);
      const cardId = previous ?? Buffer.alloc(32, cards.size + 31).toString("base64url");
      cards.set(body.publicationKey, cardId);
      return {status: 200, body: {kind: "card", cardId, disposition: previous === undefined ? "created" : "existing"}};
    }, unusedSnapshotStore, keys);
    const {client} = await connectCodex(runtime);
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "presentation_start_read")?._meta?.["ui"]).toEqual({visibility: ["model"]});
    expect(tools.find((tool) => tool.name === "presentation_start_decision")?._meta?.["ui"]).toEqual({visibility: ["model"]});
    const argumentsValue = {capabilityId: "market.stock_tokens", input: {}};
    const created = CallToolResultSchema.parse(await client.callTool({name: "presentation_start_read", arguments: argumentsValue, _meta: turnMetadata()}));
    const extraMetadata = {"x-codex-turn-metadata": {thread_id: "thread-one", turn_id: "turn-one",
      session_id: "not-authority", providerExtra: "x".repeat(4096)}};
    const existing = CallToolResultSchema.parse(await client.callTool({name: "presentation_start_decision", arguments: {kind: "wallet_selection",
      source: {kind: "new", input: {chainId: "eip155:4663"}}}, _meta: extraMetadata}));
    const next = CallToolResultSchema.parse(await client.callTool({name: "presentation_start_read", arguments: argumentsValue, _meta: turnMetadata("turn-two")}));
    const createdCard = cardCreationResultSchema.parse(created.structuredContent);
    expect(created.structuredContent).toMatchObject({disposition: "created"});
    expect(existing.structuredContent).toEqual({...createdCard, disposition: "existing"});
    expect(created._meta?.["ui"]).toEqual({resourceUri: testAppResource.uri});
    expect(existing._meta?.["ui"]).toEqual({resourceUri: testAppResource.uri});
    expect(cardCreationResultSchema.parse(next.structuredContent).cardId).not.toBe(createdCard.cardId);
    const bodies = runtime.requests.map((request) => request.body as Record<string, unknown>);
    expect(bodies[0]?.["publicationKey"]).toBe(bodies[1]?.["publicationKey"]);
    expect(bodies[2]?.["publicationKey"]).not.toBe(bodies[0]?.["publicationKey"]);
    expect(JSON.stringify(bodies)).not.toContain("thread-one");
    expect(JSON.stringify(bodies)).not.toContain("providerExtra");
    expect(JSON.stringify(created)).not.toContain(String(bodies[0]?.["publicationKey"]));
  });

  it.each(["created", "existing"] as const)("retains %s card association after a late caller abort", async (disposition) => {
    const cardId = Buffer.alloc(32, 53).toString("base64url");
    const runtime = new FakeRuntime(() => ({status: 200, body: {kind: "card", cardId, disposition}}),
      unusedSnapshotStore, await publicationKeys());
    const connection = await connectCodex(runtime);
    const caller = new AbortController();
    const invoke = connection.operationClient.invoke.bind(connection.operationClient);
    vi.spyOn(connection.operationClient, "invoke").mockImplementationOnce(async <Input, Result>(
      identity: import("../../src/interfaces/local-operation.js").LocalOperationIdentity<Input, Result>,
      inputValue: unknown, signal?: AbortSignal,
    ) => {
      const result = await invoke(identity, inputValue, signal);
      caller.abort();
      return result;
    });
    const result = await invokeRegisteredTool(connection.server, "presentation_start_read",
      {capabilityId: "market.stock_tokens", input: {}}, caller.signal, turnMetadata());
    expect(caller.signal.aborted).toBe(true);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({kind: "card", cardId, disposition});
    expect(result._meta?.["ui"]).toEqual({resourceUri: testAppResource.uri});
    expect(result._meta?.[presentationCardMetadataKey]).toEqual({kind: "card", cardId});
    expect(runtime.requests).toHaveLength(1);
  });

  it("does not associate or invoke a card producer after a precommit caller abort", async () => {
    const runtime = new FakeRuntime(undefined, unusedSnapshotStore, await publicationKeys());
    const connection = await connectCodex(runtime);
    const caller = new AbortController();
    caller.abort();
    const result = await invokeRegisteredTool(connection.server, "presentation_start_read",
      {capabilityId: "market.stock_tokens", input: {}}, caller.signal, turnMetadata());
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({error: {code: "request_aborted"}});
    expect(result._meta?.["ui"]).toBeUndefined();
    expect(result._meta?.[presentationCardMetadataKey]).toBeUndefined();
    expect(runtime.requests).toHaveLength(0);
  });

  it("rejects missing or malformed Codex context only for general publication while data tools stay canonical", async () => {
    const runtime = new FakeRuntime(() => ({status: 200, body: captureCanonicalJson(stockTokenTradeHistoryUnavailableFixture())}));
    const {client} = await connectCodex(runtime);
    for (const _meta of [undefined, {}, {"x-codex-turn-metadata": "{\"thread_id\":\"thread-one\",\"turn_id\":\"turn-one\"}"},
      {"x-codex-turn-metadata": {thread_id: "thread-one"}}]) {
      const response = await client.callTool({name: "presentation_start_read", arguments: {capabilityId: "market.stock_tokens", input: {}}, ...(_meta === undefined ? {} : {_meta})});
      expect(response).toMatchObject({isError: true, structuredContent: {error: {code: "invalid_input"}}});
      expect(response._meta?.["ui"]).toBeUndefined();
    }
    expect(runtime.requests).toHaveLength(0);
    const data = CallToolResultSchema.parse(await client.callTool({name: "market_get_stock_token_trade_history", arguments: {symbol: "AAPL"}}));
    expect(data.isError).not.toBe(true);
    expect(data._meta?.["ui"]).toBeUndefined();
    expect(data.content.some((item) => item.type === "resource_link")).toBe(false);
    expect(runtime.requests).toHaveLength(1);
  });

  it("keeps creating and failed decision publications free of UI association", async () => {
    const cardId = Buffer.alloc(32, 52).toString("base64url");
    const problem = toProblemDetails(createApplicationFailure(cardErrorRegistry, "presentation_capacity_exceeded"), cardInterfaceErrorMappings);
    let creates = 0;
    const runtime = new FakeRuntime((request) => {
      expect(request.path).toBe(cardControlResources.startDecision);
      const envelope = request.body as Readonly<{input: unknown; publicationKey: unknown}>;
      expect(envelope.input).toEqual({kind: "wallet_selection", source: {kind: "new", input: {chainId: "eip155:4663"}}});
      expect(envelope.publicationKey).toEqual(expect.any(String));
      creates += 1;
      return creates === 1 ? {status: 200, body: {kind: "card", cardId, disposition: "creating"}}
        : {status: problem.status, body: captureCanonicalJson(problem)};
    }, unusedSnapshotStore, await publicationKeys());
    const {client} = await connectCodex(runtime);
    const input = {kind: "wallet_selection", source: {kind: "new", input: {chainId: "eip155:4663"}}};
    const creating = await client.callTool({name: "presentation_start_decision", arguments: input, _meta: turnMetadata()});
    expect(creating.structuredContent).toEqual({kind: "card", cardId, disposition: "creating"});
    expect(creating._meta?.[presentationCardMetadataKey]).toEqual({kind: "card", cardId});
    expect(creating._meta).not.toHaveProperty("ui");
    const failed = await client.callTool({name: "presentation_start_decision", arguments: input, _meta: turnMetadata("turn-two")});
    expect(failed).toMatchObject({isError: true, structuredContent: {error: {code: "presentation_capacity_exceeded"}}});
    expect(failed._meta).not.toHaveProperty("ui");
  });

  it("publishes separate chart resources from the same packaged HTML and rechecks each exact chart card", async () => {
    let charts = 0;
    let contractId = "market.stock_token_trade_history";
    const runtime = new FakeRuntime((request) => {
      if (request.path === cardControlResources.startRead) {
        expect((request.body as Record<string, unknown>)["publicationKey"]).toBeNull();
        return {status: 200, body: captureCanonicalJson({kind: "card", cardId: Buffer.alloc(32, ++charts + 70).toString("base64url"), disposition: "created"})};
      }
      expect(request.path).toBe(cardControlResources.read);
      const reference = cardReadReferenceSchema.parse(request.body);
      if (reference.kind !== "card") throw new Error("An exact chart card reference is required.");
      const cardId = reference.cardId;
      return {status: 200, body: captureCanonicalJson({presentation: {state: {mode: "static", reference: {kind: "card", cardId}, record: {
        kind: "read", cardId, contractVersion: "1", contractId, inputDigest: "1".repeat(64), snapshotId: null, preparationState: "pending", outcome: null}},
        display: {kind: "summary"}, actions: []}})};
    });
    const {client} = await connectCodex(runtime);
    const first = CallToolResultSchema.parse(await client.callTool({name: "presentation_start_read", arguments: {capabilityId: "market.stock_token_trade_history", input: {symbol: "AAPL"}}}));
    const second = CallToolResultSchema.parse(await client.callTool({name: "presentation_start_read", arguments: {capabilityId: "market.stock_token_trade_history", input: {symbol: "AAPL"}}}));
    const uri = (result: CallToolResult) => {
      const metadata = captureCanonicalJson(result._meta?.["ui"]);
      if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) || typeof metadata["resourceUri"] !== "string") throw new Error("A created chart requires resource association.");
      return metadata["resourceUri"];
    };
    expect(uri(first)).not.toBe(uri(second));
    expect(await client.listResourceTemplates()).toMatchObject({resourceTemplates: [{uriTemplate: `ui://littlejohn/presentation/${testAppResource.sha256}/cards/{cardId}.html`}]});
    const html = await client.readResource({uri: uri(first)});
    expect(html.contents[0]).toMatchObject({uri: uri(first), mimeType: "text/html;profile=mcp-app", text: testAppResource.html,
      _meta: {[presentationCardMetadataKey]: {kind: "card", cardId: cardCreationResultSchema.parse(first.structuredContent).cardId}}});
    contractId = "address.inspect";
    await expect(client.readResource({uri: uri(second)})).rejects.toThrow("does not belong to a chart card");
  });

  it("uses standard Apps capability for admission and keeps static association only on explicit standard publication tools", async () => {
    const ordinaryCodex = await connectMcp(new FakeRuntime(), {}, "codex-mcp-client");
    expect((await ordinaryCodex.client.listTools()).tools.map((tool) => tool.name)).not.toContain("presentation_start_decision");
    expect((await ordinaryCodex.client.listResources()).resources).toEqual([]);
    const standard = await connectApp(new FakeRuntime());
    const tools = (await standard.client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(expectedToolAnnotations).sort());
    tools.forEach(expectToolAnnotations);
    expect(tools.find((tool) => tool.name === "wallet_select_account")?.annotations).toEqual({
      readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false,
    });
    for (const name of ["presentation_start_read", "presentation_start_decision"]) {
      expect(tools.find((tool) => tool.name === name)?._meta?.["ui"]).toEqual({visibility: ["model"], resourceUri: testAppResource.uri});
    }
    for (const name of ["wallet_start_connection_change_review", "wallet_get_operation", "token_start_selection_change_review", "exchange_start_review", "signing_start_review", "presentation_get_snapshot"]) {
      expect(tools.find((tool) => tool.name === name)?._meta?.["ui"]).not.toHaveProperty("resourceUri");
    }
    expect(JSON.stringify(tools)).not.toContain("openai/outputTemplate");
  });

  it("preserves a candidate source failure in the MCP result and the shared App error admission", async () => {
    const fixture = createPriceFixture({ fetch: async () => oversizedCandidateResponse() });
    try {
      const runtime = new FakeRuntime(async (request) => {
        expect(request.requestClass).toBe("local_control");
        expect(request.path).toBe(immutableReadResultIdentity.path);
        const failure = await fixture.bindings.invoke(stockTokenPricesCapability, (request.body as Record<string, unknown>)["input"],
          { signal: request.signal ?? new AbortController().signal });
        if (failure.ok) throw new Error("Expected source failure.");
        const problem = toProblemDetails(failure, stockTokenPricesInterfaceErrorMappings);
        return { status: problem.status, body: captureCanonicalJson(problem) };
      });
      const connection = await connectApp(runtime);
      const result = CallToolResultSchema.parse(await connection.client.callTool({ name: "market_get_stock_token_prices", arguments: { symbol: "AAPL" } }));
      const failure = { ok: false, error: { code: "pool_candidate_response_too_large", category: "domain",
        message: "The pool candidate response exceeds the supported size.", retryable: false, issues: [] } };
      expect(result).toEqual({ isError: true, structuredContent: failure,
        content: [{ type: "text", text: canonicalJsonStringify(captureCanonicalJson(failure)) }] });
      expect(admitCreatingToolError("standard-host", result)).toEqual({ message: failure.error.message, failure });
      for (const field of ["category", "message", "retryable"] as const) {
        const altered = { ...failure, error: { ...failure.error, [field]: field === "retryable" ? true : field === "category" ? "source" : "Another failure." } };
        expect(admitCreatingToolError("standard-host", { isError: true, structuredContent: altered,
          content: [{ type: "text", text: canonicalJsonStringify(captureCanonicalJson(altered)) }] })?.failure).toBeUndefined();
      }
      expect(fixture.fetcher).toHaveBeenCalledTimes(1);
      expect(fixture.calls).toHaveLength(0);
    } finally { await fixture.close(); }
  });

  it("rejects another admitted card reference and leaves an uncertain control unacknowledged without replay", async () => {
    const cardId = Buffer.alloc(32, 1).toString("base64url");
    const otherCardId = Buffer.alloc(32, 2).toString("base64url");
    const runtime = new FakeRuntime((request) => {
      if (request.path === cardControlResources.read) return {
        status: 200, body: { presentation: { state: { mode: "static", reference: { kind: "card", cardId: otherCardId },
          record: { cardId: otherCardId, kind: "signing", contractVersion: "1", operationId: Buffer.alloc(32, 3).toString("base64url"),
            resultDigest: "1".repeat(64), snapshotId: null, expiresAt: null, inputState: "input_closed", closeReason: "discarded", dispatchId: null,
            context: { account: { chainId: "eip155:4663", address: `0x${"11".repeat(20)}` }, method: "personal_sign" },
            outcome: null } }, display: { kind: "summary" }, actions: [] } },
      };
      if (request.path === cardControlResources.stop) throw new Error("Control acknowledgement was lost.");
      throw new Error("Unexpected card path.");
    });
    const { client } = await connectApp(runtime);
    const mismatched = await client.callTool({ name: "presentation_get_card", arguments: { kind: "card", cardId } });
    expect(mismatched).toMatchObject({ isError: true, structuredContent: { error: { code: "internal_error" } } });
    runtime.requests.splice(0);
    const stopped = await client.callTool({ name: "presentation_cancel_wait", arguments: { cardId: Buffer.alloc(32, 89).toString("base64url") } });
    expect(stopped).toMatchObject({ isError: true, structuredContent: { error: { code: "runtime_state_unavailable" } } });
    expect(runtime.requests.map((request) => request.path)).toEqual([cardControlResources.stop]);
    expect(JSON.stringify(stopped)).not.toContain('"mode":"static"');
  });

  it("delivers a verified signature only through the direct App's same-response metadata", async () => {
    const test = createSigningFixture();
    try {
      const review = await test.coordinator.start(signingCommand, new AbortController().signal);
      const runtime = new FakeRuntime(async (request) => {
        if (request.path !== cardControlResources.action) throw new Error("Unexpected signature request path.");
        const envelope = cardActionEnvelopeSchema.parse(request.body);
        return { status: 200, body: captureCanonicalJson({ result: await test.coordinator.confirm(signingDirectDecisionSchema.parse(envelope.decision), new AbortController().signal), presentation: { status: "unavailable", cardId: envelope.cardId } }) };
      });
      const { client } = await connectApp(runtime);
      const pending = client.callTool({ name: "signing_request_signature", arguments: { cardId: Buffer.alloc(32, 83).toString("base64url"), cardOpenRequestId: Buffer.alloc(32, 84).toString("base64url"), decision: { review, initiatedBy: "mcp_app" } } });
      await test.sent;
      const signature = await signer.signMessage({ message });
      test.reply({ status: "signature_returned", signature });
      const result = CallToolResultSchema.parse(await pending);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "verified", operationId: review.operationId,
        signatureDigest: createHash("sha256").update(Buffer.from(signature.slice(2), "hex")).digest("hex") });
      expect(result._meta?.[signingSignatureMetadataKey]).toBe(signature);
      expect(JSON.stringify(result.content)).not.toContain(signature);
      expect(JSON.stringify(result.structuredContent)).not.toContain(signature);
      expect(result._meta?.[operationToolResultMetadataKey]).toBeDefined();
      expect(test.startRequest).toHaveBeenCalledOnce();
      expect(test.materials.read(review.operationId)).toBeNull();
      expect(runtime.requests.map((request) => request.path)).toEqual([cardControlResources.action]);
    } finally { await test.close(); }
  });

  it("keeps a corrupted native signature pair out of every model and private result field", async () => {
    const test = createSigningFixture();
    try {
      const review = await test.coordinator.start(signingCommand, new AbortController().signal);
      const runtime = new FakeRuntime(async (request) => {
        const completion = await test.coordinator.confirm(signingDirectDecisionSchema.parse(cardActionEnvelopeSchema.parse(request.body).decision), new AbortController().signal);
        return { status: 200, body: captureCanonicalJson({ result: { ...completion, signature: `0x${"11".repeat(64)}1b` }, presentation: { status: "unavailable", cardId: cardActionEnvelopeSchema.parse(request.body).cardId } }) };
      });
      const { client } = await connectApp(runtime);
      const pending = client.callTool({ name: "signing_request_signature", arguments: { cardId: Buffer.alloc(32, 83).toString("base64url"), cardOpenRequestId: Buffer.alloc(32, 84).toString("base64url"), decision: { review, initiatedBy: "mcp_app" } } });
      await test.sent; test.reply({ status: "signature_returned", signature: await signer.signMessage({ message }) });
      const result = CallToolResultSchema.parse(await pending);
      expect(result.structuredContent).toMatchObject({ status: "delivery_unknown", operationId: review.operationId });
      expect(result._meta).not.toHaveProperty(signingSignatureMetadataKey);
      expect(JSON.stringify(result)).not.toContain(`0x${"11".repeat(64)}1b`);
      expect(test.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });
  it("describes scoped official classification without granting safety or action authority", async () => {
    const connection = await connectOrdinary(new FakeRuntime());
    const instructions = connection.client.getInstructions();
    expect(instructions).toContain("scoped official-asset membership and deployment identity");
    expect(instructions).toContain("when established by their evidence");
    expect(instructions).toContain("does not establish token safety");
    expect(instructions).toContain("require a direct App or interactive CLI decision");
    expect(instructions).toContain("Models cannot sign or authorize transactions");
    expect(instructions).not.toContain("without establishing token safety or official status");
  });

  it("admits the bounded delivery error through an advertised SDK output schema", async () => {
    const delivery = admitMcpToolResultForDelivery({
      content: [{ type: "text", text: "x".repeat(1_048_576) }],
    });
    expect(delivery.status).toBe("too_large");
    const server = new Server(
      { name: "delivery-error-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: "test_get_result",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: {
          type: "object",
          properties: { ok: { const: true } },
          required: ["ok"],
          additionalProperties: false,
        },
      }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => delivery.result);
    const client = new Client(
      { name: "delivery-error-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();
      const result = CallToolResultSchema.parse(
        await client.callTool({ name: "test_get_result", arguments: {} }),
      );
      expect(result).toEqual(delivery.result);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(admitMcpToolResultDeliveryError(result)).toEqual({
        message:
          "Little John could not deliver this MCP result because it exceeds the supported response size.",
      });
      expect(admitMcpToolResultDeliveryErrorContent(result.content)).toEqual({
        message:
          "Little John could not deliver this MCP result because it exceeds the supported response size.",
      });
      expect(admitMcpToolResultDeliveryError({
        ...result,
        content: [{ type: "text", text: "different error" }],
      })).toBeUndefined();
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("publishes a strict JSON Schema input contract for every declared tool", async () => {
    const runtime = new FakeRuntime();
    const client = new LocalOperationClient({ ownerSessions: runtime });
    try {
      const registry = createMcpToolRegistry(runtime, client);
      expect(registry.get("read_get_chain_status").inputSchema).toMatchObject({$id: "urn:littlejohn:capability:chain.status:input:v1"});
      expect(registry.get("wallet_get_connection").inputSchema).toMatchObject({$id: "urn:littlejohn:capability:wallet.connection:input:v1"});
      for (const definition of registry.values()) {
        expect(() => new Ajv2020({ strict: true }).addFormat("uri", { type: "string", validate: (value: string) => { try { new URL(value); return true; } catch { return false; } } }).compile(definition.inputSchema as object))
          .not.toThrow();
      }
    } finally {
      await client.close();
    }
  });

  it("projects every operation definition from the same binding object and exact visibility", async () => {
    const runtime = new FakeRuntime();
    const client = new LocalOperationClient({ ownerSessions: runtime });
    try {
      const registry = createMcpToolRegistry(runtime, client);
      expect(registry.values().map((definition) => definition.name).sort())
        .toEqual([...declaredMcpToolNames].sort());

      for (const binding of operationInterfaceBindingList) {
        const definition = registry.get(binding.mcp.name);
        expect(definition.operationBinding).toBe(binding);
        expect(definition.visibility).toEqual(binding.mcp.visibility);
        expect(definition.annotations).toEqual(binding.mcp.annotations);
        expect(definition.createsView).toBe(binding.mcp.createsView);

        const local = resolveLocalOperationIdentity(binding.identity);
        if (local.action === "decide" || local.action === "cancel") {
          expect(definition.deliveryRecovery).toBeDefined();
          const projected = definition.deliveryRecovery?.project(
            createDeliveryUnknown(local.action, Buffer.alloc(32, 41).toString("base64url")),
          );
          expect(projected).toEqual({
            delivery: {
              status: "delivery_unknown",
              action: local.action,
              operationId: Buffer.alloc(32, 41).toString("base64url"),
              resendAllowed: false,
            },
            recovery: {
              tool: binding.recoveryOperation?.mcp.name,
              arguments: { operationId: Buffer.alloc(32, 41).toString("base64url") },
            },
          });
        } else {
          expect(definition.deliveryRecovery).toBeUndefined();
        }
      }
    } finally {
      await client.close();
    }
  });

  it("projects top-level discriminated inputs as one closed object without changing admission", async () => {
    const runtime = new FakeRuntime();
    const client = new LocalOperationClient({ ownerSessions: runtime });
    try {
      const registry = createMcpToolRegistry(runtime, client);
      const token = registry.get("token_start_selection_change_review").inputSchema as {
        readonly type?: string;
        readonly properties?: Readonly<Record<string, unknown>>;
        readonly required?: readonly string[];
        readonly oneOf?: readonly Readonly<Record<string, unknown>>[];
      };
      expect(token.type).toBe("object");
      expect(token.required).toEqual(["account", "asset", "kind"]);
      expect(token.properties?.["account"]).toMatchObject({ oneOf: expect.any(Array) });
      expect(token.properties?.["asset"]).toMatchObject({ type: "object" });
      expect(token.oneOf).toHaveLength(2);
      expect(token.oneOf?.every((branch) =>
        !("asset" in ((branch["properties"] as Readonly<Record<string, unknown>> | undefined) ?? {}))))
        .toBe(true);

      const asset = {
        kind: "erc20",
        chainId: "eip155:4663",
        address: `0x${"1".repeat(40)}`,
      } as const;
      const revision = "A".repeat(22);
      const account = { kind: "active_wallet" } as const;
      const tokenValidate = new Ajv2020({ strict: true }).compile(token as object);
      const tokenCases = [
        { value: { kind: "add", account, asset }, valid: true },
        { value: { kind: "remove", account, asset, expectedRevision: revision }, valid: true },
        { value: { kind: "add", account, asset: JSON.stringify(asset) }, valid: false },
        { value: { kind: "add", account, asset, expectedRevision: revision }, valid: false },
        { value: { kind: "remove", account, asset }, valid: false },
        { value: { kind: "replace", account, asset }, valid: false },
        { value: { kind: "add", account, asset, extra: true }, valid: false },
      ] as const;
      for (const example of tokenCases) {
        expect(tokenValidate(example.value)).toBe(example.valid);
        expect(tokenSelectionReviewRequestSchema.safeParse(example.value).success).toBe(example.valid);
      }

      const balance = registry.get("read_get_account_balance").inputSchema;
      const balanceValidate = new Ajv2020({ strict: true }).compile(balance as object);
      for (const example of [
        {
          value: {
            account: { kind: "active_wallet" },
            includeNative: true,
            tokens: [],
            block: { kind: "latest" },
          },
          valid: true,
        },
        {
          value: {
            account: { kind: "active_wallet" },
            includeNative: false,
            tokens: [],
            block: { kind: "latest" },
          },
          valid: false,
        },
      ] as const) {
        expect(balanceValidate(example.value)).toBe(example.valid);
        expect(accountBalanceInputSchema.safeParse(example.value).success).toBe(example.valid);
      }
    } finally {
      await client.close();
    }
  });

  it("keeps transaction confirmation and App-only resources outside an ordinary MCP connection", async () => {
    const runtime = new FakeRuntime();
    const local = new LocalOperationClient({ ownerSessions: runtime });
    const expected = createMcpToolRegistry(runtime, local).values()
      .filter((definition) =>
        !definition.createsView && definition.visibility.some((value) => value === "model"))
      .map((definition) => definition.name)
      .sort();
    await local.close();

    const { client } = await connectOrdinary(runtime);
    const listed = await client.listTools();
    const resources = await client.listResources();
    const names = listed.tools.map((tool) => tool.name).sort();

    expect(names).toEqual(expected);
    expect(resources.resources).toEqual([]);
    for (const name of ["exchange_request_transaction", "signing_request_signature"]) {
      const denied = await client.callTool({ name, arguments: {} });
      expect(denied.isError).toBe(true);
      // Ordinary connections are rejected before input parsing. A malformed
      // financial input must not make a missing visibility guard look safe.
      expect(denied.structuredContent).toMatchObject({
        ok: false, error: { code: "invalid_input", issues: [] },
      });
    }
    for (const name of ["presentation_start_view", "presentation_cancel_decision", "presentation_cancel_wait"]) {
      const cardId = Buffer.alloc(32, 87).toString("base64url");
      const denied = await client.callTool({ name, arguments: name === "presentation_start_view"
        ? { cardId, cardOpenRequestId: Buffer.alloc(32, 88).toString("base64url") } : { cardId } });
      expect(denied.isError).toBe(true);
      expect(names).not.toContain(name);
    }
    expect(runtime.requests).toHaveLength(0);
    await expect(client.readResource({ uri: testAppResource.uri })).rejects.toThrow();
    expect(names).toContain("wallet_start_connection_change_review");
    expect(names).toContain("wallet_get_operation");
    expect(names.filter((name) => name.startsWith("presentation_"))).toEqual(["presentation_get_card", "presentation_get_result_part", "presentation_get_snapshot"]);
    listed.tools.forEach(expectToolAnnotations);
  });

  it("delivers the complete capability schemas once with bounded catalog text", async () => {
    const catalog = captureCanonicalJson({ contractVersion: "1", capabilities:
      projectCapabilities(interfaceReadCapabilityRegistry).map((entry) => ({ ...entry,
        availability: { overall: "internal", direct: "internal", http: "unavailable", mcp: "unavailable", cli: "unavailable" },
      })),
    });
    // Both representations are valid alone. Duplicating the complete catalog
    // exceeds the unchanged MCP envelope limit and must not be made to pass.
    expect(admitMcpToolResultForDelivery({ structuredContent: catalog as Record<string, unknown>,
      content: [{ type: "text", text: canonicalJsonStringify(catalog) }],
    }).status).toBe("too_large");
    const runtime = new FakeRuntime(() => ({ status: 200, body: catalog }));
    const { client } = await connectOrdinary(runtime);
    const result = await client.callTool({ name: "read_list_capabilities", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(catalog);
    expect(result.content).toEqual([{ type: "text", text: [
      "Read capabilities:", "account.balance: internal", "address.inspect: internal", "chain.status: internal",
      "market.stock_token_prices: internal", "market.stock_token_trade_history: internal", "market.stock_tokens: internal",
      "token.inspect: internal", "transaction.inspect: internal", "uniswap_v2.quote_exact_input: internal",
      "uniswap_v4.list_pools: internal", "wallet.connection: internal",
    ].join("\n") }]);
    expect(admitMcpToolResultForDelivery(CallToolResultSchema.parse(result)).status).toBe("admitted");
    expect(runtime.requests).toHaveLength(1);
  });

  it("selects App resources only from admitted connection capability", async () => {
    const { client } = await connectApp(new FakeRuntime());
    const resources = await client.listResources();
    expect(resources.resources).toEqual([expect.objectContaining({
      uri: testAppResource.uri,
      mimeType: "text/html;profile=mcp-app",
    })]);
    const resource = await client.readResource({ uri: testAppResource.uri });
    expect(resource.contents).toHaveLength(1);
    const ui = resource.contents[0]?._meta?.["ui"];
    const standard = JSON.parse(readFileSync(
      new URL(import.meta.resolve("@modelcontextprotocol/ext-apps/schema.json")), "utf8",
    )) as { readonly $defs: { readonly McpUiResourceMeta: object } };
    const validateMetadata = new Ajv2020({ strict: true }).compile(standard.$defs.McpUiResourceMeta);
    expect(validateMetadata(ui)).toBe(true);
    expect(ui).not.toHaveProperty("permissions");
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("presentation_get_snapshot");
    expect(tools.tools.some((tool) => operationInterfaceBindingList
      .some((binding) => binding.mcp.name === tool.name))).toBe(true);
  });

  it("preserves package identity and a canonical public-read failure on the surviving MCP surface", async () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      readonly name: string;
      readonly version: string;
    };
    const unavailable = createStockTokenTradeHistoryFailure("source_unavailable");
    const runtime = new FakeRuntime(() => ({
      status: 503,
      body: captureCanonicalJson(toProblemDetails(
        unavailable,
        stockTokenTradeHistoryInterfaceErrorMappings,
      )),
    }));
    const { client } = await connectOrdinary(runtime);

    expect(client.getServerVersion()).toEqual({ name: manifest.name, version: manifest.version });
    const result = await client.callTool({
      name: stockTokenTradeHistoryInterface.mcp.name,
      arguments: { symbol: "AAPL" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(unavailable);
    expect(runtime.requests).toEqual([{
      requestClass: "local_control",
      method: "POST",
      path: immutableReadResultIdentity.path,
      body: {contractId: "market.stock_token_trade_history", input: { symbol: "AAPL", period: { count: 1, unit: "day" } }},
      signal: expect.any(AbortSignal),
    }]);
  });

  it("carries one admitted Stock Token result through MCP text and structured output", async () => {
    const value = stockTokenTradeHistoryUnavailableFixture();
    const runtime = new FakeRuntime(() => ({ status: 200, body: captureCanonicalJson(value) }));
    const { client } = await connectOrdinary(runtime);
    const result = await client.callTool({
      name: stockTokenTradeHistoryInterface.mcp.name,
      arguments: { symbol: "aapl" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(value);
    expect(result.content).toEqual([{
      type: "text",
      text: stockTokenTradeHistoryHumanSummary(value.data),
    }]);
    expect(runtime.requests).toEqual([{
      requestClass: "local_control",
      method: "POST",
      path: immutableReadResultIdentity.path,
      body: {contractId: "market.stock_token_trade_history", input: { symbol: "AAPL", period: { count: 1, unit: "day" } }},
      signal: expect.any(AbortSignal),
    }]);
  });

  it("keeps a completed App data query canonical without creating a second chart card", async () => {
    const value = stockTokenTradeHistoryAvailableFixture();
    const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-mcp-app-success-"));
    temporaryDirectories.push(directory);
    const database = await ProductDatabase.open(
      resolve(directory, "runtime.sqlite3"),
      parseUtcTimestamp("2026-08-23T00:00:00.000Z"),
    );
    openDatabases.push(database);
    const runtime = new FakeRuntime(
      () => ({ status: 200, body: captureCanonicalJson(value) }),
      database.presentationSnapshotStore(),
    );
    const { client } = await connectApp(runtime);
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) =>
      candidate.name === stockTokenTradeHistoryInterface.mcp.name);
    if (tool?.outputSchema === undefined) throw new TypeError("Trade-history output schema missing.");

    const result = CallToolResultSchema.parse(await client.callTool({
      name: stockTokenTradeHistoryInterface.mcp.name,
      arguments: { symbol: "AAPL", period: { count: 1, unit: "day" } },
    }));
    const admitted = captureCanonicalJson(result.structuredContent);
    const validate = new Ajv2020({ strict: true, validateFormats: false })
      .compile(tool.outputSchema);
    expect(validate(admitted)).toBe(true);
    expect(result.content.filter((item) =>
      item.type === "text" && item.text === stockTokenTradeHistoryHumanSummary(value.data)))
      .toHaveLength(1);
    expect(result.content.filter((item) => item.type === "resource_link")).toHaveLength(0);
    expect(result._meta?.["littlejohn/presentation-snapshot"]).toBeUndefined();
    expect(result.structuredContent).toEqual(value);
    expect(tool._meta?.["ui"]).toEqual({ visibility: ["model"] });
    expect(runtime.requests).toHaveLength(1);
  });

  it("does not make the completed-data query depend on presentation retention", async () => {
    const value = stockTokenTradeHistoryUnavailableFixture();
    const unavailableStore: PresentationSnapshotStore = Object.freeze({
      prepare: () => { throw new Error("snapshot store unavailable"); },
      commit: () => { throw new Error("unexpected snapshot commit"); },
      read: () => { throw new Error("unexpected snapshot read"); },
      readMetadata: () => {throw new Error("This fixture expects no snapshot metadata lookup.");},
  readResultChunk: () => { throw new Error("unexpected snapshot chunk read"); },
    });
    const runtime = new FakeRuntime(
      () => ({ status: 200, body: captureCanonicalJson(value) }),
      unavailableStore,
    );
    const { client } = await connectApp(runtime);
    const result = await client.callTool({
      name: stockTokenTradeHistoryInterface.mcp.name,
      arguments: { symbol: "aapl" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(value);
    expect(result.content).toEqual([{
      type: "text",
      text: stockTokenTradeHistoryHumanSummary(value.data),
    }]);
    expect(result._meta?.["littlejohn/presentation-snapshot"]).toBeUndefined();
    expect(runtime.requests).toHaveLength(1);
  });

  it("returns the owning invalid-input field path without repairing the value", async () => {
    const runtime = new FakeRuntime();
    const { client } = await connectOrdinary(runtime);
    const asset = {
      kind: "erc20",
      chainId: "eip155:4663",
      address: `0x${"1".repeat(40)}`,
    };
    const result = await client.callTool({
      name: "token_get_selection",
      arguments: { account: { kind: "active_wallet" }, asset: JSON.stringify(asset) },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        issues: [{ path: "/asset", code: "invalid_value" }],
      },
    });
    expect(runtime.requests).toEqual([]);
  });

  it("rejects an oversized Wallet cancellation before invocation or descriptor construction", async () => {
    const runtime = new FakeRuntime();
    const { client } = await connectApp(runtime);
    const result = await client.callTool({
      name: "wallet_cancel_operation",
      arguments: {
        operationId: Buffer.alloc(32, 7).toString("base64url"),
        reviewDigest: `0x${"8".repeat(64)}`,
        expectedState: "awaiting_wallet_approval",
        connectionRevision: `1${"0".repeat(16_384)}`,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(result._meta?.["littlejohn/operation-tool-result"]).toBeUndefined();
    expect(runtime.requests).toEqual([]);
  });

  it("delivers one exact removal operation and binds its absent inspection in the descriptor", async () => {
    const operation = await createTokenOperation({ kind: "remove" });
    const runtime = new FakeRuntime(() => ({
      status: 200,
      body: captureCanonicalJson(operation),
    }));
    const { client } = await connectApp(runtime);
    const result = await client.callTool({
      name: "token_get_operation",
      arguments: { operationId: operation.operationId },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(operation);
    expect((result.structuredContent as typeof operation)
      .result.selection.historicalInspection).toBeNull();
    const descriptor = admitOperationToolResultDescriptor(
      result._meta?.[operationToolResultMetadataKey],
    );
    expect(descriptor.resultSha256).toBe(canonicalSha256(captureCanonicalJson(operation)));
    expect(descriptor.resultUtf8Bytes).toBe(Buffer.byteLength(
      canonicalJsonStringify(captureCanonicalJson(operation)),
      "utf8",
    ));
  });

  it("accepts only the canonical MCP tool-name grammar", () => {
    for (const name of declaredMcpToolNames) expect(parseMcpToolName(name)).toBe(name);
    expect(() => parseMcpToolName("read.get_chain_status")).toThrow();
    expect(() => parseMcpToolName("Read_Get_Chain_Status")).toThrow();
    expect(() => parseMcpToolName("read_status")).toThrow();
  });
});
