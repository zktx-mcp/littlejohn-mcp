import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createSigningFixture, command as signingCommand, signer, message } from "../review/signing-fixture.js";
import { cardActionEnvelopeSchema } from "../../src/interfaces/mcp-app/card-contract.js";
import { signingDirectDecisionSchema } from "../../src/review/signing-contracts.js";
import { signingSignatureMetadataKey } from "../../src/interfaces/signing-result.js";
import { cardControlResources } from "../../src/interfaces/mcp-app/card-controls.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  accountBalanceInputSchema,
  canonicalJsonStringify,
  canonicalSha256,
  captureCanonicalJson,
  parseUtcTimestamp,
} from "../../src/core/index.js";
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
  presentationSnapshotMetadataKey,
} from "../../src/interfaces/mcp-app/contracts.js";
import { createMcpAppResource } from "../../src/interfaces/mcp-app/server.js";
import {
  createMcpServer,
  createMcpToolRegistry,
  type McpRuntimePort,
  type McpServerRuntimePort,
} from "../../src/interfaces/mcp.js";
import { stockTokenTradeHistoryInterface } from "../../src/interfaces/identities.js";
import { stockTokenTradeHistoryHumanSummary } from
  "../../src/interfaces/stock-token-trade-history-presentation.js";
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

const unusedSnapshotStore: PresentationSnapshotStore = Object.freeze({
  prepare: () => { throw new Error("Ordinary MCP must not prepare a snapshot."); },
  commit: () => { throw new Error("Ordinary MCP must not commit a snapshot."); },
  read: () => { throw new Error("Ordinary MCP must not read a snapshot."); },
  readResultChunk: () => { throw new Error("Ordinary MCP must not read a snapshot chunk."); },
});
const testAppResource = createMcpAppResource("<!doctype html><title>Little John test</title>");

class FakeRuntime implements McpServerRuntimePort {
  readonly requests: RuntimeDispatchRequest[] = [];
  handler: (request: RuntimeDispatchRequest) => RuntimeDispatchResponse | Promise<RuntimeDispatchResponse>;
  readonly snapshotStore: PresentationSnapshotStore;

  constructor(
    handler?: FakeRuntime["handler"],
    snapshotStore: PresentationSnapshotStore = unusedSnapshotStore,
  ) {
    this.handler = handler ?? (() => ({ status: 500, body: { ok: false } }));
    this.snapshotStore = snapshotStore;
  }

  async dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    this.requests.push(request);
    return await this.handler(request);
  }

  openOwnerSession(signal?: AbortSignal) {
    return openTestOwnerSession(this, signal);
  }

  presentationSnapshotStore(): PresentationSnapshotStore { return this.snapshotStore; }
}

interface ConnectedMcp {
  readonly client: Client;
  close(): Promise<void>;
}

const openConnections: ConnectedMcp[] = [];
const openDatabases: ProductDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const connectMcp = async (
  runtime: McpServerRuntimePort,
  capabilities: ClientCapabilities,
): Promise<ConnectedMcp> => {
  const operationClient = new LocalOperationClient({ ownerSessions: runtime });
  const server = createMcpServer(runtime, operationClient, testAppResource);
  const client = new Client({ name: "littlejohn-test", version: "1.0.0" }, { capabilities });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const connection = Object.freeze({
    client,
    close: async (): Promise<void> => {
      await Promise.allSettled([client.close(), server.close(), operationClient.close()]);
    },
  });
  openConnections.push(connection);
  return connection;
};

const connectOrdinary = (runtime: McpServerRuntimePort): Promise<ConnectedMcp> =>
  connectMcp(runtime, {});

const connectApp = (runtime: McpServerRuntimePort): Promise<ConnectedMcp> => connectMcp(runtime, {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
});

describe("MCP binding projection", () => {
  it("rejects another admitted card reference and leaves an uncertain control unacknowledged without replay", async () => {
    const cardId = Buffer.alloc(32, 1).toString("base64url");
    const otherCardId = Buffer.alloc(32, 2).toString("base64url");
    const runtime = new FakeRuntime((request) => {
      if (request.path === cardControlResources.read) return {
        status: 200, body: { presentation: { state: { mode: "static", reference: { kind: "card", cardId: otherCardId },
          record: { cardId: otherCardId, kind: "signing", contractVersion: "1", operationId: Buffer.alloc(32, 3).toString("base64url"),
            resultDigest: "1".repeat(64), snapshotId: null, firstCardOpenRequestId: null, expiresAt: null, phase: "closed",
            context: { account: { chainId: "eip155:4663", address: `0x${"11".repeat(20)}` }, method: "personal_sign" },
            outcome: { kind: "decision", reason: "discarded" } } }, display: { kind: "summary" }, actions: [] } },
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
        expect(definition.presentationContract).toBe(
          binding.action === "review" ? binding.contract : undefined,
        );

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
      const token = registry.get("token_get_selection_change_review").inputSchema as {
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
        definition.operationBinding === undefined && definition.presentationTool === undefined && definition.visibility.some((value) => value === "model"))
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
    expect(names.some((name) => operationInterfaceBindingList
      .some((binding) => binding.mcp.name === name))).toBe(false);
    expect(names.filter((name) => name.startsWith("presentation_"))).toEqual(["presentation_get_card"]);
    for (const tool of listed.tools) {
      if (tool.name === "account_list_assets") {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        });
      } else if (tool.name === "exchange_start_review" || tool.name === "activity_inspect_transaction" || tool.name === "uniswap_v4_list_pools") {
        expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
      } else if (tool.name === "signing_start_review") {
        expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
      } else if (tool.name === "exchange_cancel_review") {
        expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      } else {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.destructiveHint).toBe(false);
      }
    }
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
    expect(ui).toHaveProperty("permissions", { clipboardWrite: {} });
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
      requestClass: "public_read",
      method: "POST",
      path: stockTokenTradeHistoryInterface.http.path,
      body: { symbol: "AAPL", period: { count: 1, unit: "day" } },
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
      requestClass: "public_read",
      method: "POST",
      path: stockTokenTradeHistoryInterface.http.path,
      body: { symbol: "AAPL", period: { count: 1, unit: "day" } },
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
    expect(result._meta?.[presentationSnapshotMetadataKey]).toBeUndefined();
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
