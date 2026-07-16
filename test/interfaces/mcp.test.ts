import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonStringify, captureCanonicalJson } from "../../src/core/index.js";
import { extendChainSupportManifest } from "../../src/chain/application.js";
import {
  createMcpServer,
  mcpToolNames,
  parseMcpToolName,
} from "../../src/interfaces/mcp.js";
import { extendInterfaceSupportManifest } from "../../src/interfaces/support.js";
import type { RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResponse,
} from "../../src/runtime/index.js";
import {
  composeCapabilityCatalog,
  initialRuntimeSupportManifest,
} from "../../src/runtime/index.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import {
  parseWalletManagementOperation,
  walletOperationIdByteLength,
  type WalletManagementOperation,
} from "../../src/wallet/contracts.js";
import { walletControlRoutes } from "../../src/wallet/routes.js";

const operationId = Buffer.alloc(walletOperationIdByteLength, 31).toString("base64url");
const catalog = composeCapabilityCatalog(extendInterfaceSupportManifest(
  extendChainSupportManifest(extendWalletSupportManifest(initialRuntimeSupportManifest)),
));
const operation = (): WalletManagementOperation => parseWalletManagementOperation({
  operationId,
  kind: "connect",
  state: "awaiting_confirmation",
  connectionRevision: "5",
  expiresAt: "2026-07-15T05:00:00.000Z",
  result: null,
  failure: null,
});

class FakeRuntime implements RuntimeDispatchPort {
  readonly requests: RuntimeDispatchRequest[] = [];
  handler: (request: RuntimeDispatchRequest) => Promise<RuntimeDispatchResponse> | RuntimeDispatchResponse;

  constructor(handler?: FakeRuntime["handler"]) {
    this.handler = handler ?? ((request) => Object.freeze({
      status: request.path === walletControlRoutes.operations ? 201 : 200,
      body: captureCanonicalJson(request.path === walletControlRoutes.operations
        ? { operation: operation() }
        : catalog),
    }));
  }

  async dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    this.requests.push(request);
    return await this.handler(request);
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

const connect = async (runtime: RuntimeDispatchPort): Promise<ConnectedMcp> => {
  const server = createMcpServer(runtime);
  const client = new Client({ name: "littlejohn-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const connection = Object.freeze({
    client,
    close: async (): Promise<void> => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  });
  openConnections.push(connection);
  return connection;
};

const textResult = (result: unknown): string => {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("Expected MCP tool content.");
  }
  const content = result.content[0];
  if (typeof content !== "object" || content === null || !("type" in content) || content.type !== "text" ||
    !("text" in content) || typeof content.text !== "string") {
    throw new Error("Expected MCP text content.");
  }
  return content.text;
};

describe("MCP interface", () => {
  it("projects the package identity through the MCP handshake", async () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      readonly name: string;
      readonly version: string;
    };
    const { client } = await connect(new FakeRuntime());
    expect(client.getServerVersion()).toEqual({
      name: manifest.name,
      version: manifest.version,
    });
  });

  it("registers the exact convention-validated tool set with strict schemas and annotations", async () => {
    const { client } = await connect(new FakeRuntime());
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([...mcpToolNames].sort());
    expect(names).toHaveLength(10);
    for (const name of names) expect(parseMcpToolName(name)).toBe(name);
    expect(() => parseMcpToolName("read.get_chain_status")).toThrow();
    expect(() => parseMcpToolName("Read_Get_Chain_Status")).toThrow();
    expect(() => parseMcpToolName("read_status")).toThrow();
    expect(() => parseMcpToolName(`read_get_${"x".repeat(60)}`)).toThrow();

    const chainStatus = listed.tools.find((tool) => tool.name === "read_get_chain_status");
    expect(chainStatus).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: { type: "object", additionalProperties: false },
    });
    const cancel = listed.tools.find((tool) => tool.name === "wallet_cancel_operation");
    const getOperation = listed.tools.find((tool) => tool.name === "wallet_get_operation");
    expect(cancel?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["operationId"],
    });
    expect(getOperation?.inputSchema).toEqual(cancel?.inputSchema);
  });

  it("uses one canonical operation identifier contract for reads and cancellations", async () => {
    const runtime = new FakeRuntime(() => ({
      status: 200,
      body: captureCanonicalJson({ operation: operation() }),
    }));
    const { client } = await connect(runtime);

    for (const name of ["wallet_get_operation", "wallet_cancel_operation"] as const) {
      for (const invalidOperationId of [
        Buffer.alloc(walletOperationIdByteLength - 1, 31).toString("base64url"),
        Buffer.alloc(walletOperationIdByteLength + 1, 31).toString("base64url"),
        `${operationId}=`,
      ]) {
        const result = await client.callTool({ name, arguments: { operationId: invalidOperationId } });
        expect(result.isError).toBe(true);
      }
    }
    expect(runtime.requests).toEqual([]);

    const read = await client.callTool({
      name: "wallet_get_operation",
      arguments: { operationId },
    });
    const cancelled = await client.callTool({
      name: "wallet_cancel_operation",
      arguments: { operationId },
    });
    expect(read.isError).not.toBe(true);
    expect(cancelled.isError).not.toBe(true);
    expect(runtime.requests).toEqual([
      {
        requestClass: "local_control",
        method: "GET",
        path: walletControlRoutes.operation(operationId),
        signal: expect.any(AbortSignal),
      },
      {
        requestClass: "local_control",
        method: "DELETE",
        path: walletControlRoutes.operation(operationId),
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("rejects undeclared input before dispatch and keeps structured content identical to canonical text", async () => {
    const runtime = new FakeRuntime();
    const { client } = await connect(runtime);
    const invalid = await client.callTool({
      name: "read_get_chain_status",
      arguments: { unexpected: true },
    });
    expect(invalid.isError).toBe(true);
    expect(runtime.requests).toEqual([]);
    expect(textResult(invalid)).toBe(canonicalJsonStringify(invalid.structuredContent as never));
    expect(invalid.structuredContent).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const valid = await client.callTool({ name: "read_list_capabilities", arguments: {} });
    expect(valid.isError).not.toBe(true);
    expect(textResult(valid)).toBe(canonicalJsonStringify(valid.structuredContent as never));
    expect(valid.structuredContent).toEqual(catalog);
    expect(runtime.requests).toMatchObject([{
      requestClass: "public_read",
      method: "GET",
      path: "/api/v1/capabilities",
    }]);
  });

  it("starts only a web-confirmed wallet operation and returns a secret-free fixed management URL", async () => {
    const runtime = new FakeRuntime();
    const { client } = await connect(runtime);
    const result = await client.callTool({ name: "wallet_start_connection", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      operation: operation(),
      managementUrl: `http://127.0.0.1:46630/wallet/operations/${operationId}`,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("qr");
    expect(serialized).not.toContain("pairing");
    expect(serialized).not.toContain("topic");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("?");
    expect(runtime.requests).toEqual([{
      requestClass: "local_control",
      method: "POST",
      path: walletControlRoutes.operations,
      body: { kind: "connect", interactionInterface: "web" },
      signal: expect.any(AbortSignal),
    }]);
    expect(runtime.requests.some((request) => request.path.endsWith("/confirmation"))).toBe(false);
  });

  it("normalizes dispatcher exceptions without exposing their text", async () => {
    const runtime = new FakeRuntime(() => { throw new Error("secret-provider-payload"); });
    const { client } = await connect(runtime);
    const result = await client.callTool({ name: "read_list_capabilities", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "internal_error" } });
    expect(JSON.stringify(result)).not.toContain("secret-provider-payload");
  });

  it("rejects malformed read and catalog successes instead of diverging from canonical clients", async () => {
    const runtime = new FakeRuntime((request) => ({
      status: 200,
      body: captureCanonicalJson(request.path === "/api/v1/capabilities"
        ? { contractVersion: "forged", capabilities: [] }
        : { data: {} }),
    }));
    const { client } = await connect(runtime);
    const address = `0x${"11".repeat(20)}`;
    const transactionHash = `0x${"22".repeat(32)}`;
    for (const [name, argumentsValue] of [
      ["read_get_account_balance", {
        account: { kind: "address", address },
        includeNative: true,
        tokens: [],
        block: { kind: "latest" },
      }],
      ["read_get_chain_status", {}],
      ["read_inspect_contract", { address, block: { kind: "latest" } }],
      ["read_inspect_transaction", { transactionHash }],
      ["wallet_get_connection", {}],
      ["read_list_capabilities", {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: argumentsValue });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "internal_error" },
      });
    }
  });

  it("propagates client cancellation to the fixed-port dispatcher", async () => {
    let observedSignal: AbortSignal | undefined;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const runtime = new FakeRuntime(async (request) => {
      observedSignal = request.signal;
      enteredResolve();
      await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted dispatch");
    });
    const { client } = await connect(runtime);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "read_list_capabilities", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    await entered;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
  });
});
