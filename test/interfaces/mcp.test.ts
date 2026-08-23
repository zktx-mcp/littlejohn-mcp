import { readFileSync } from "node:fs";
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
  admitMcpToolResultForDelivery,
} from "../../src/interfaces/mcp-result.js";
import {
  admitPresentationSnapshotResource,
  presentationSnapshotMetadataKey,
} from "../../src/interfaces/mcp-app/contracts.js";
import { createMcpAppResource } from "../../src/interfaces/mcp-app/server.js";
import {
  createMcpServer,
  createMcpToolRegistry,
  type McpRuntimePort,
  type McpServerRuntimePort,
} from "../../src/interfaces/mcp.js";
import { stockTokenTradeHistoryInterfaceBinding } from "../../src/interfaces/identities.js";
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
        expect(() => new Ajv2020({ strict: true }).compile(definition.inputSchema as object))
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
      expect(token.required).toEqual(["asset", "kind"]);
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
      const tokenValidate = new Ajv2020({ strict: true }).compile(token as object);
      const tokenCases = [
        { value: { kind: "add", asset }, valid: true },
        { value: { kind: "remove", asset, expectedRevision: revision }, valid: true },
        { value: { kind: "add", asset: JSON.stringify(asset) }, valid: false },
        { value: { kind: "add", asset, expectedRevision: revision }, valid: false },
        { value: { kind: "remove", asset }, valid: false },
        { value: { kind: "replace", asset }, valid: false },
        { value: { kind: "add", asset, extra: true }, valid: false },
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

  it("keeps an ordinary MCP connection read-only and rejects App-only tools and resources", async () => {
    const runtime = new FakeRuntime();
    const local = new LocalOperationClient({ ownerSessions: runtime });
    const expected = createMcpToolRegistry(runtime, local).values()
      .filter((definition) =>
        definition.operationBinding === undefined && definition.presentationTool === undefined)
      .map((definition) => definition.name)
      .sort();
    await local.close();

    const { client } = await connectOrdinary(runtime);
    const listed = await client.listTools();
    const resources = await client.listResources();
    const names = listed.tools.map((tool) => tool.name).sort();

    expect(names).toEqual(expected);
    expect(resources.resources).toEqual([]);
    await expect(client.readResource({ uri: testAppResource.uri })).rejects.toThrow();
    expect(names.some((name) => operationInterfaceBindingList
      .some((binding) => binding.mcp.name === name))).toBe(false);
    expect(names.some((name) => name.startsWith("presentation_"))).toBe(false);
    for (const tool of listed.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it("selects App resources only from admitted connection capability", async () => {
    const { client } = await connectApp(new FakeRuntime());
    const resources = await client.listResources();
    expect(resources.resources).toEqual([expect.objectContaining({
      uri: testAppResource.uri,
      mimeType: "text/html;profile=mcp-app",
    })]);
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
      name: stockTokenTradeHistoryInterfaceBinding.mcp.name,
      arguments: { symbol: "AAPL" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(unavailable);
    expect(runtime.requests).toEqual([{
      requestClass: "public_read",
      method: "POST",
      path: stockTokenTradeHistoryInterfaceBinding.http.path,
      body: { symbol: "AAPL", window: "1d" },
      signal: expect.any(AbortSignal),
    }]);
  });

  it("carries one admitted Stock Token result through MCP text and structured output", async () => {
    const value = stockTokenTradeHistoryUnavailableFixture();
    const runtime = new FakeRuntime(() => ({ status: 200, body: captureCanonicalJson(value) }));
    const { client } = await connectOrdinary(runtime);
    const result = await client.callTool({
      name: stockTokenTradeHistoryInterfaceBinding.mcp.name,
      arguments: { symbol: "aapl" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(value);
    expect(result.content).toEqual([{
      type: "text",
      text: canonicalJsonStringify(captureCanonicalJson(value)),
    }]);
    expect(runtime.requests).toEqual([{
      requestClass: "public_read",
      method: "POST",
      path: stockTokenTradeHistoryInterfaceBinding.http.path,
      body: { symbol: "AAPL", window: "1d" },
      signal: expect.any(AbortSignal),
    }]);
  });

  it("returns one schema-valid canonical result and snapshot through an App connection", async () => {
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
      candidate.name === stockTokenTradeHistoryInterfaceBinding.mcp.name);
    if (tool?.outputSchema === undefined) throw new TypeError("Trade-history output schema missing.");

    const result = CallToolResultSchema.parse(await client.callTool({
      name: stockTokenTradeHistoryInterfaceBinding.mcp.name,
      arguments: { symbol: "AAPL", window: "1d" },
    }));
    const admitted = captureCanonicalJson(result.structuredContent);
    const validate = new Ajv2020({ strict: true, validateFormats: false })
      .compile(tool.outputSchema);
    expect(validate(admitted)).toBe(true);
    const canonicalText = canonicalJsonStringify(admitted);
    expect(result.content.filter((item) => item.type === "text" && item.text === canonicalText))
      .toHaveLength(1);
    expect(result.content.filter((item) => item.type === "resource_link")).toHaveLength(1);
    const resource = admitPresentationSnapshotResource(
      result._meta?.[presentationSnapshotMetadataKey],
    );
    expect(resource.descriptor.resultUtf8Bytes).toBe(Buffer.byteLength(canonicalText, "utf8"));
    const stored = database.presentationSnapshotStore().read(resource.descriptor.snapshotId);
    expect(stored.status).toBe("available");
    if (stored.status !== "available") throw new TypeError("App snapshot was not committed.");
    expect(Buffer.from(stored.value.resultBytes).toString("utf8")).toBe(canonicalText);
    expect(runtime.requests).toHaveLength(1);
  });

  it("fails an App read closed when its presentation snapshot cannot be owned", async () => {
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
      name: stockTokenTradeHistoryInterfaceBinding.mcp.name,
      arguments: { symbol: "aapl" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    expect(result.content).toEqual([{
      type: "text",
      text: canonicalJsonStringify(captureCanonicalJson(result.structuredContent)),
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
      arguments: { asset: JSON.stringify(asset) },
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

  it("accepts only the canonical MCP tool-name grammar", () => {
    for (const name of declaredMcpToolNames) expect(parseMcpToolName(name)).toBe(name);
    expect(() => parseMcpToolName("read.get_chain_status")).toThrow();
    expect(() => parseMcpToolName("Read_Get_Chain_Status")).toThrow();
    expect(() => parseMcpToolName("read_status")).toThrow();
  });
});
