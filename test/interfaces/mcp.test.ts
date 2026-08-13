import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  accountBalanceInputSchema,
  canonicalJsonStringify,
  captureCanonicalJson,
  referenceMarketManifest,
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
  createMcpServer,
  createMcpToolRegistry,
  type McpRuntimePort,
} from "../../src/interfaces/mcp.js";
import { referenceMarketInterfaceBindings } from "../../src/interfaces/identities.js";
import {
  createReferenceMarketFailure,
  referenceMarketInterfaceErrorMappings,
} from "../../src/market-portfolio/errors.js";
import { referenceWatchlistReviewRequestSchema } from "../../src/market-portfolio/index.js";
import { tokenSelectionReviewRequestSchema } from "../../src/token-catalog/index.js";
import type { RuntimeDispatchRequest, RuntimeDispatchResponse } from "../../src/runtime/index.js";
import { toProblemDetails } from "../../src/runtime/index.js";
import { openTestOwnerSession } from "./owner-session-harness.js";
import { stockTokenMarketUnmappedFixture } from "./stock-token-market-fixture.js";

class FakeRuntime implements McpRuntimePort {
  readonly requests: RuntimeDispatchRequest[] = [];
  handler: (request: RuntimeDispatchRequest) => RuntimeDispatchResponse | Promise<RuntimeDispatchResponse>;

  constructor(handler?: FakeRuntime["handler"]) {
    this.handler = handler ?? (() => ({ status: 500, body: { ok: false } }));
  }

  async dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    this.requests.push(request);
    return await this.handler(request);
  }

  openOwnerSession(signal?: AbortSignal) {
    return openTestOwnerSession(this, signal);
  }
}

interface ConnectedMcp {
  readonly client: Client;
  close(): Promise<void>;
}

const openConnections: ConnectedMcp[] = [];

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
});

const connectOrdinary = async (runtime: McpRuntimePort): Promise<ConnectedMcp> => {
  const operationClient = new LocalOperationClient({ ownerSessions: runtime });
  const server = createMcpServer(runtime, operationClient);
  const client = new Client({ name: "littlejohn-test", version: "1.0.0" }, { capabilities: {} });
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

describe("MCP binding projection", () => {
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

      const pairId = referenceMarketManifest.pairs[0]!.pairId;
      const watchlist = registry.get("market_get_watchlist_change_review").inputSchema;
      const watchlistValidate = new Ajv2020({ strict: true }).compile(watchlist as object);
      for (const example of [
        { value: { kind: "add", pairId, expectedRevision: revision }, valid: true },
        { value: { kind: "remove", pairId, expectedRevision: revision }, valid: true },
        { value: { kind: "reorder", pairIds: [pairId], expectedRevision: revision }, valid: true },
        { value: { kind: "reorder", pairId, expectedRevision: revision }, valid: false },
      ] as const) {
        expect(watchlistValidate(example.value)).toBe(example.valid);
        expect(referenceWatchlistReviewRequestSchema.safeParse(example.value).success).toBe(example.valid);
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

  it("keeps an ordinary MCP connection read-only and omits App operation and presentation tools", async () => {
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
    const names = listed.tools.map((tool) => tool.name).sort();

    expect(names).toEqual(expected);
    expect(names.some((name) => operationInterfaceBindingList
      .some((binding) => binding.mcp.name === name))).toBe(false);
    expect(names.some((name) => name.startsWith("presentation_"))).toBe(false);
    for (const tool of listed.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it("preserves package identity and a canonical public-read failure on the surviving MCP surface", async () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      readonly name: string;
      readonly version: string;
    };
    const unavailable = createReferenceMarketFailure("source_unavailable");
    const runtime = new FakeRuntime(() => ({
      status: 503,
      body: captureCanonicalJson(toProblemDetails(unavailable, referenceMarketInterfaceErrorMappings)),
    }));
    const { client } = await connectOrdinary(runtime);

    expect(client.getServerVersion()).toEqual({ name: manifest.name, version: manifest.version });
    const pairId = referenceMarketManifest.pairs[0]!.pairId;
    const result = await client.callTool({
      name: referenceMarketInterfaceBindings.price.mcp.name,
      arguments: { pairId },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(unavailable);
    expect(runtime.requests).toEqual([{
      requestClass: "public_read",
      method: "POST",
      path: referenceMarketInterfaceBindings.price.http.path,
      body: { pairId },
      signal: expect.any(AbortSignal),
    }]);
  });

  it("carries one admitted Stock Token result through MCP text and structured output", async () => {
    const value = stockTokenMarketUnmappedFixture();
    const runtime = new FakeRuntime(() => ({ status: 200, body: captureCanonicalJson(value) }));
    const { client } = await connectOrdinary(runtime);
    const result = await client.callTool({
      name: referenceMarketInterfaceBindings.stockTokenMarket.mcp.name,
      arguments: { symbol: "p" },
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
      path: referenceMarketInterfaceBindings.stockTokenMarket.http.path,
      body: { symbol: "P", window: "1d" },
      signal: expect.any(AbortSignal),
    }]);
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
