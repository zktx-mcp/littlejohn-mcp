import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  parseCapabilityInput,
  parseCapabilitySuccess,
  parseUtcTimestamp,
  type CanonicalJson,
} from "../../../src/core/index.js";
import {
  admitPresentationSnapshotResource,
  createPresentationSnapshotResource,
  type PresentationSnapshotResource,
} from "../../../src/interfaces/mcp-app/contracts.js";
import {
  McpAppPresentationService,
  createMcpAppResource,
} from "../../../src/interfaces/mcp-app/server.js";
import {admitPresentationToolResult, readPresentationResource, type AdmittedPresentation, type PresentationViewApp} from "../../../src/interfaces/mcp-app/view/lifecycle.js";
import {
  admitMcpToolResultForDelivery,
  maximumMcpToolResultUtf8Bytes,
} from "../../../src/interfaces/mcp-result.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import {presentationContractRegistry} from "../../../src/interfaces/mcp-app/registry.js";
import type {PresentationSnapshotStore} from "../../../src/runtime/presentation-snapshot.js";
import {stockTokenTradeHistoryCapability, stockTokenTradeHistoryMaximumSuccessUtf8Bytes} from "../../../src/stock-token-trade-history/contracts.js";
import {stockTokenTradeHistoryHumanSummary} from "../../../src/interfaces/stock-token-trade-history-presentation.js";
import {
  tokenCatalogApplicationContracts,
  tokenSelectionDetailSchema,
} from "../../../src/token-catalog/client.js";
import { stockTokenTradeHistoryAvailableFixture } from
  "../stock-token-trade-history-fixture.js";
import maximumTradeHistorySuccess from
  "../../stock-token-trade-history/maximum-success.json" with { type: "json" };
import { capturedCodexCreatingApplicationFailure } from
  "./error-carriage-fixture.js";
import { createPriceFixture } from "../../stock-token-prices/fixture.js";
import { stockTokenPricesCapability, stockTokensCapability } from "../../../src/stock-token-prices/contracts.js";

const openedAt = parseUtcTimestamp("2026-08-12T00:00:00.000Z");
const directories: string[] = [];
let database: ProductDatabase | undefined;

afterEach(async () => {
  database?.close();
  database = undefined;
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const openStore = async (): Promise<PresentationSnapshotStore> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-presentation-process-"));
  directories.push(directory);
  database = await ProductDatabase.open(resolve(directory, "runtime.sqlite3"), openedAt);
  return database.presentationSnapshotStore();
};

const input = parseCapabilityInput(stockTokenTradeHistoryCapability, {
  symbol: "AAPL",
  period: { count: 1, unit: "day" },
});
const tradeHistory = parseCapabilitySuccess(
  stockTokenTradeHistoryCapability,
  input,
  stockTokenTradeHistoryAvailableFixture(),
);
const canonicalTradeHistory = captureCanonicalJson(tradeHistory);

const canonicalResult = (value: CanonicalJson): CallToolResult => ({
  structuredContent: value as Record<string, unknown>,
  content: [{ type: "text", text: canonicalJsonStringify(value) }],
});

const ordinaryResult = (): CallToolResult => canonicalResult(canonicalTradeHistory);

const retainResource = async (service: McpAppPresentationService, store: PresentationSnapshotStore,
  contract: object, rawInput: unknown, result: CallToolResult): Promise<PresentationSnapshotResource> => {
  const entry = presentationContractRegistry.forContract(contract);
  if (entry === undefined) throw new Error("A registered presentation contract is required.");
  const committed = store.commit({contractId: entry.contractId, contractVersion: entry.contractVersion,
    normalizedInput: entry.parseInput(rawInput), admittedResult: captureCanonicalJson(result.structuredContent)});
  if (committed.status !== "available") throw new Error("A complete retained source is required.");
  const resource = createPresentationSnapshotResource(committed.value, entry.parseInput(rawInput));
  return admitPresentationSnapshotResource(await service.readSnapshotResource(resource.descriptor.snapshotUri));
};

const fakeApp = (options: Readonly<{
  host: string;
  serverResources?: boolean;
  serverTools?: boolean;
  readResource?: (uri: string) => Promise<ReadResourceResult>;
  callTool?: (name: string, argumentsValue: Record<string, unknown>) => Promise<CallToolResult>;
}>): PresentationViewApp => ({
  getHostVersion: () => ({ name: options.host, version: "1.0.0" }),
  getHostCapabilities: () => ({
    ...(options.serverResources === true ? { serverResources: {} } : {}),
    ...(options.serverTools === true ? { serverTools: {} } : {}),
  }),
  readServerResource: async ({ uri }: { readonly uri: string }) => {
    if (options.readResource === undefined) throw new TypeError("Unexpected resource read.");
    return await options.readResource(uri);
  },
  callServerTool: async ({ name, arguments: argumentsValue }: Readonly<{
    name: string;
    arguments?: Record<string, unknown>;
  }>) => {
    if (options.callTool === undefined) throw new TypeError("Unexpected tool call.");
    return await options.callTool(name, argumentsValue ?? {});
  },
});

const readSource = async (app: PresentationViewApp, resource: PresentationSnapshotResource): Promise<AdmittedPresentation> => {
  const admitted = await readPresentationResource(app, resource, new AbortController().signal);
  if (!admitted.ok) throw new Error("An admitted source was expected.");
  return admitted.value;
};
const chunkTool = (
  service: McpAppPresentationService,
  observed?: { name: string; argumentsValue: Record<string, unknown> }[],
) => async (name: string, argumentsValue: Record<string, unknown>): Promise<CallToolResult> => {
  observed?.push({ name, argumentsValue });
  return {
    structuredContent: (await service.getResultChunk(
      String(argumentsValue["snapshotUri"]),
      Number(argumentsValue["index"]),
    )) as Record<string, unknown>,
    content: [],
  };
};

describe("MCP App presentation process", () => {
  it.each(["prices", "tokens"] as const)("reads the same exact %s source on first display and redisplay", async kind => {
    const fixture = createPriceFixture();
    try {
      const definition = kind === "prices" ? stockTokenPricesCapability : stockTokensCapability;
      const command = kind === "prices" ? {symbol: "AAPL"} : {};
      const domain = await fixture.bindings.invoke(definition, command, {signal: new AbortController().signal});
      if (!domain.ok) throw new Error("An admitted domain result is required.");
      const store = await openStore();
      const service = new McpAppPresentationService(store, createMcpAppResource("<!doctype html><main>Little John</main>"),
        {read: async () => {throw new Error("Immutable reads cannot use Review memory.");}});
      const resource = await retainResource(service, store, definition, command, canonicalResult(captureCanonicalJson(domain)));
      const reads: {name: string; argumentsValue: Record<string, unknown>}[] = [];
      const app = fakeApp({host: "standard", serverTools: true, callTool: chunkTool(service, reads)});
      expect((await readSource(app, resource)).result).toEqual(domain);
      expect(reads).toHaveLength(resource.descriptor.resultChunkCount);
      await fixture.close();
      const rpcCalls = fixture.calls.length;
      const reopened = await readSource(app, resource);
      expect(reopened.result).toEqual(domain);
      expect(reopened.normalizedInput).toEqual(command);
      expect(reads).toHaveLength(resource.descriptor.resultChunkCount * 2);
      expect(fixture.calls).toHaveLength(rpcCalls);
      expect(fixture.fetcher).toHaveBeenCalledTimes(kind === "prices" ? 1 : 0);
    } finally {await fixture.close();}
  });
  it.each(["failure", "unavailable"] as const)("preserves a received chunk %s and stops before further chunk reads", async (kind) => {
    const store = await openStore();
    const maximumInput = parseCapabilityInput(stockTokenTradeHistoryCapability, { symbol: "A".repeat(32), period: { count: 12, unit: "month" } });
    const maximum = parseCapabilitySuccess(stockTokenTradeHistoryCapability, maximumInput, maximumTradeHistorySuccess);
    const prepared = store.prepare({ contractId: "market.stock_token_trade_history", contractVersion: "1", normalizedInput: maximumInput, admittedResult: captureCanonicalJson(maximum) });
    if (prepared.status !== "available") throw new Error("Valid multi-chunk source required.");
    const resource = createPresentationSnapshotResource(prepared.value, maximumInput);
    expect(resource.descriptor.resultChunkCount).toBeGreaterThan(1);
    const failure = { ok: false, error: { code: "runtime_state_unavailable", category: "runtime", message: "Local runtime state is unavailable.", retryable: false, issues: [] } };
    const unavailable = { kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_missing" };
    let calls = 0;
    const app = fakeApp({ host: "standard", serverTools: true, callTool: async (name, input) => {
      calls += 1;
      expect(name).toBe("presentation_get_snapshot_chunk");
      expect(input).toEqual({ snapshotUri: resource.descriptor.snapshotUri, index: 0 });
      return { ...canonicalResult(captureCanonicalJson(kind === "failure" ? failure : unavailable)), isError: kind === "failure" };
    } });
    expect(await readPresentationResource(app, resource, new AbortController().signal)).toEqual({ ok: false,
      issue: kind === "failure" ? { kind: "application", failure } : { kind: "presentation", unavailable } });
    expect(calls).toBe(1);
  });


  it("delivers the accepted History maximum through its exact saved source and ordinary data envelope", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(store, createMcpAppResource("<!doctype html><main>Little John</main>"),
      {read: async () => {throw new Error("Immutable data cannot read a live Review.");}});
    const maximumInput = parseCapabilityInput(stockTokenTradeHistoryCapability, {symbol: "A".repeat(32), period: {count: 12, unit: "month"}});
    const maximum = parseCapabilitySuccess(stockTokenTradeHistoryCapability, maximumInput, maximumTradeHistorySuccess);
    const value = captureCanonicalJson(maximum);
    const resource = await retainResource(service, store, stockTokenTradeHistoryCapability, maximumInput, canonicalResult(value));
    const reads: {name: string; argumentsValue: Record<string, unknown>}[] = [];
    expect(resource.descriptor.resultUtf8Bytes).toBe(595_952);
    expect(595_952).toBeLessThanOrEqual(stockTokenTradeHistoryMaximumSuccessUtf8Bytes);
    const result = await readSource(fakeApp({host: "standard", serverTools: true, callTool: chunkTool(service, reads)}), resource);
    expect(result.result).toEqual(value);
    expect(reads.map(call => call.argumentsValue["index"])).toEqual([0, 1, 2]);
    const packet: CallToolResult = {structuredContent: value as Record<string, unknown>,
      content: [{type: "text", text: stockTokenTradeHistoryHumanSummary(maximum.data)}]};
    expect(new TextEncoder().encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(maximumMcpToolResultUtf8Bytes);
    expect(admitMcpToolResultForDelivery(packet).status).toBe("admitted");
  });

  it("returns a model descriptor and standard link without private View data or another commit", async () => {
    const store = await openStore();
    const committed = store.commit({contractId: "market.stock_token_trade_history", contractVersion: "1", normalizedInput: input, admittedResult: canonicalTradeHistory});
    if (committed.status !== "available") throw new Error("A retained source is required.");
    const resource = createPresentationSnapshotResource(committed.value, input);
    let reads = 0;
    const reader: PresentationSnapshotStore = {prepare: () => {throw new Error("No new preparation.");}, commit: () => {throw new Error("No new commit.");},
      read: id => {reads++; return store.read(id);}, readResultChunk: store.readResultChunk};
    const service = new McpAppPresentationService(reader, createMcpAppResource("<!doctype html><main>Little John</main>"),
      {read: async () => {throw new Error("No live Review.");}});
    const result = await service.getSnapshotResult(resource.descriptor.snapshotUri);
    expect(reads).toBe(1);
    expect(result.structuredContent).toEqual({kind: "presentation_snapshot_reference", snapshotUri: resource.descriptor.snapshotUri, descriptor: resource.descriptor});
    expect(result._meta).toBeUndefined();
    expect(result.content).toEqual([{type: "text", text: canonicalJsonStringify(captureCanonicalJson(result.structuredContent))},
      expect.objectContaining({type: "resource_link", uri: resource.descriptor.snapshotUri, mimeType: "application/json"})]);
    expect(JSON.parse((await service.readResource(resource.descriptor.snapshotUri)).text)).toEqual(resource);
    expect((await readSource(fakeApp({host: "standard", serverTools: true, callTool: chunkTool(service)}), resource)).result).toEqual(canonicalTradeHistory);
  });
  it("preserves immutable snapshot unavailability without starting a new read", async () => {
    const unavailableStore: PresentationSnapshotStore = Object.freeze({
      prepare: () => { throw new Error("database unavailable"); },
      commit: () => { throw new Error("unexpected commit"); },
      read: () => { throw new Error("database unavailable"); },
      readResultChunk: () => { throw new Error("database unavailable"); },
    });
    const service = new McpAppPresentationService(
      unavailableStore,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } },
    );
    expect((await service.getSnapshotResult(`littlejohn://presentation/snapshots/sha256/${"0".repeat(64)}`)).structuredContent).toEqual({
      kind: "presentation_unavailable", status: "unavailable", reason: "runtime_unavailable",
    });
    expect((await service.getResultChunk(`littlejohn://presentation/snapshots/sha256/${"0".repeat(64)}`, 0))).toEqual({
      kind: "presentation_unavailable",
      status: "unavailable",
      reason: "runtime_unavailable",
    });
  });

  it("rejects a valid stored result correlated to a different normalized input during immutable re-admission", async () => {
    const store = await openStore();
    const requestedAsset = {
      kind: "erc20" as const,
      chainId: "eip155:4663" as const,
      address: "0x1111111111111111111111111111111111111111" as const,
    };
    const normalizedInput = tokenCatalogApplicationContracts.selection.parseInput({
      account: {
        kind: "address",
        address: "0x3333333333333333333333333333333333333333",
      },
      asset: requestedAsset,
    });
    const mismatchedResult = tokenSelectionDetailSchema.parse({
      selection: {
        account: {
          chainId: requestedAsset.chainId,
          address: "0x3333333333333333333333333333333333333333",
        },
        asset: {
          ...requestedAsset,
          address: "0x2222222222222222222222222222222222222222",
        },
        included: true,
        revision: "AAAAAAAAAAAAAAAAAAAAAA",
        createdAt: openedAt,
        updatedAt: openedAt,
      },
      historicalInspection: null,
    });

    const committed = store.commit({contractId: tokenCatalogApplicationContracts.selection.capabilityId, contractVersion: "1",
      normalizedInput, admittedResult: captureCanonicalJson(mismatchedResult)});
    if (committed.status !== "available") throw new Error("A valid byte pair is required to test owning result re-admission.");
    const resource = createPresentationSnapshotResource(committed.value, normalizedInput);
    const service = new McpAppPresentationService(store, createMcpAppResource("<!doctype html><main>Little John</main>"),
      {read: async () => {throw new Error("No live Review belongs to this source.");}});
    expect(await service.readSnapshotResource(resource.descriptor.snapshotUri)).toEqual({
      kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_inconsistent"});
  });

  it("re-admits an application input through its normalized-input contract", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } },
    );
    const account = {
      chainId: "eip155:4663" as const,
      address: "0x3333333333333333333333333333333333333333" as const,
    };
    const target = { kind: "address" as const, address: account.address };
    const normalizedInput = tokenCatalogApplicationContracts.selections.parseInput({ account: target });
    const selections = tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      normalizedInput,
      { account, selections: [], nextCursor: null },
    );
    const resource = await retainResource(service, store,
      tokenCatalogApplicationContracts.selections,
      { account: target },
      canonicalResult(captureCanonicalJson(selections)),
    );

    expect(resource.normalizedInput).toEqual(normalizedInput);
    expect(resource.normalizedInput).toEqual(expect.objectContaining({ cursor: null }));
    expect(JSON.parse((await service.readResource(resource.descriptor.snapshotUri)).text)).toEqual(resource);

    const admitted = await readSource(fakeApp({
      host: "standard-host",
      serverTools: true,
      callTool: chunkTool(service),
    }), resource);
    expect(admitted.normalizedInput).toEqual(resource.normalizedInput);
    expect(admitted.result).toEqual(selections);
  });


  it.each(["standard-host", "chatgpt", "Claude"])("rejects obsolete initial packets without fetching source data for %s", async host => {
    const store = await openStore();
    const service = new McpAppPresentationService(store, createMcpAppResource("<!doctype html><main>Little John</main>"),
      {read: async () => {throw new Error("No live Review.");}});
    const resource = await retainResource(service, store, stockTokenTradeHistoryCapability, input, ordinaryResult());
    const reference = await service.getSnapshotResult(resource.descriptor.snapshotUri);
    const legacy = {...ordinaryResult(), content: [...ordinaryResult().content, ...reference.content.filter(item => item.type === "resource_link")],
      _meta: {"littlejohn/presentation-snapshot": resource}};
    for (const result of [ordinaryResult(), reference, legacy]) {
      await expect(admitPresentationToolResult(fakeApp({host}), result, new AbortController().signal)).rejects.toThrow("card acknowledgement");
    }
  });

  it("rejects changed input bytes before reading result chunks", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(store, createMcpAppResource("<!doctype html><main>Little John</main>"),
      {read: async () => {throw new Error("No live Review.");}});
    const resource = await retainResource(service, store, stockTokenTradeHistoryCapability, input, ordinaryResult());
    // Equal-size, valid input with an independently different subject retains all descriptor fields.
    const changed = {...resource, normalizedInput: {...input, symbol: "MSFT"}};
    await expect(readPresentationResource(fakeApp({host: "standard", serverTools: true}), changed, new AbortController().signal))
      .rejects.toThrow("Presentation snapshot resource input is inconsistent.");
  });
  it("separates tool errors from presentation admission without another read", async () => {
    const app = fakeApp({ host: "standard-host" });
    const signal = new AbortController().signal;
    const delivery = admitMcpToolResultForDelivery({
      content: [{ type: "text", text: "x".repeat(1_048_576) }],
    });
    if (delivery.status !== "too_large") {
      throw new TypeError("Expected the bounded MCP delivery error.");
    }

    expect(await admitPresentationToolResult(app, delivery.result, signal)).toEqual({
      status: "tool_error",
      message:
        "Little John could not deliver this MCP result because it exceeds the supported response size.",
    });
    const { isError: _isError, ...capturedCodexDeliveryError } = delivery.result;
    expect(await admitPresentationToolResult(
      fakeApp({ host: "chatgpt" }),
      capturedCodexDeliveryError,
      signal,
    )).toEqual({
      status: "tool_error",
      message:
        "Little John could not deliver this MCP result because it exceeds the supported response size.",
    });
    for (const changed of [{
      content: [{ type: "text" as const, text: "changed delivery error" }],
    }, {
      ...capturedCodexDeliveryError,
      structuredContent: capturedCodexCreatingApplicationFailure.structuredContent,
    }, {
      ...capturedCodexDeliveryError,
      isError: false,
    }]) {
      await expect(admitPresentationToolResult(
        fakeApp({ host: "chatgpt" }),
        changed,
        signal,
      )).rejects.toThrow();
    }
    expect(await admitPresentationToolResult(
      fakeApp({ host: "chatgpt" }),
      capturedCodexCreatingApplicationFailure,
      signal,
    )).toEqual({
      status: "tool_error",
      message: "The tool call ended with an error before a displayable result was available.",
    });
    const failure = { ok: false, error: { code: "runtime_state_unavailable", category: "runtime", message: "Local runtime state is unavailable.", retryable: false, issues: [] } };
    expect(await admitPresentationToolResult(app, { isError: true, structuredContent: failure,
      content: [{ type: "text", text: canonicalJsonStringify(captureCanonicalJson(failure)) }] }, signal)).toEqual({
        status: "tool_error", message: "Local runtime state is unavailable.", failure,
      });
    for (const field of ["code", "category", "message", "retryable"] as const) {
      const changed = { ...failure, error: { ...failure.error, [field]: field === "retryable" ? true : "changed" } };
      expect(await admitPresentationToolResult(app, { isError: true, structuredContent: changed,
        content: [{ type: "text", text: canonicalJsonStringify(captureCanonicalJson(changed)) }] }, signal)).toEqual({
          status: "tool_error", message: "The tool call ended with an error before a displayable result was available.",
        });
    }
    await expect(admitPresentationToolResult(
      fakeApp({ host: "standard-host" }),
      capturedCodexCreatingApplicationFailure,
      signal,
    )).rejects.toThrow();
    await expect(admitPresentationToolResult(
      fakeApp({ host: "standard-host" }),
      capturedCodexDeliveryError,
      signal,
    )).rejects.toThrow();
    expect(await admitPresentationToolResult(app, {
      isError: true,
      structuredContent: { untrusted: true },
      content: [{ type: "text", text: "untrusted error detail" }],
    }, signal)).toEqual({
      status: "tool_error",
      message: "The tool call ended with an error before a displayable result was available.",
    });
    expect(await admitPresentationToolResult(app, {
      ...delivery.result,
      content: [{ type: "text", text: "spoofed delivery error" }],
    }, signal)).toEqual({
      status: "tool_error",
      message: "The tool call ended with an error before a displayable result was available.",
    });
    expect(await admitPresentationToolResult(fakeApp({ host: "Claude" }), {
      content: capturedCodexCreatingApplicationFailure.content,
      isError: true,
    }, signal)).toEqual({
      status: "tool_error",
      message: "The tool call ended with an error before a displayable result was available.",
    });
    for (const changed of [{
      ...capturedCodexCreatingApplicationFailure,
      content: [{ type: "text" as const, text: "changed" }],
    }, {
      ...capturedCodexCreatingApplicationFailure,
      structuredContent: { ok: true },
    }, {
      ...capturedCodexCreatingApplicationFailure,
      _meta: { unexpected: true },
    }, {
      ...capturedCodexCreatingApplicationFailure,
      isError: false,
    }]) {
      await expect(admitPresentationToolResult(
        fakeApp({ host: "chatgpt" }),
        changed,
        signal,
      )).rejects.toThrow();
    }
  });
});
