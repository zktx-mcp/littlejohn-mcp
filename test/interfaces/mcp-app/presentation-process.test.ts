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
  presentationSnapshotMetadataKey,
  type PresentationSnapshotResource,
} from "../../../src/interfaces/mcp-app/contracts.js";
import {
  McpAppPresentationService,
  createMcpAppResource,
  type McpAppPresentationHandoff,
} from "../../../src/interfaces/mcp-app/server.js";
import {
  admitPresentationToolResult,
  readPresentationResource,
  type AdmittedPresentation,
  type PresentationViewApp,
} from
  "../../../src/interfaces/mcp-app/view/lifecycle.js";
import {
  admitMcpToolResultForDelivery,
  maximumMcpToolResultUtf8Bytes,
} from "../../../src/interfaces/mcp-result.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import type { PresentationSnapshotStore } from
  "../../../src/runtime/presentation-snapshot.js";
import {
  stockTokenTradeHistoryCapability,
  stockTokenTradeHistoryMaximumSuccessUtf8Bytes,
} from
  "../../../src/stock-token-trade-history/contracts.js";
import {
  stockTokenTradeHistoryHumanSummary,
} from
  "../../../src/interfaces/stock-token-trade-history-presentation.js";
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

const availableResult = (handoff: McpAppPresentationHandoff): CallToolResult => {
  if (handoff.status !== "available") {
    throw new TypeError(`Expected an available presentation, received ${handoff.status}.`);
  }
  return handoff.delivery.result;
};

const snapshotResource = (result: CallToolResult): PresentationSnapshotResource =>
  admitPresentationSnapshotResource(result._meta?.[presentationSnapshotMetadataKey]);

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

const admitPresentation = async (
  app: PresentationViewApp,
  result: CallToolResult,
  signal: AbortSignal,
): Promise<AdmittedPresentation> => {
  const outcome = await admitPresentationToolResult(app, result, signal);
  if (outcome.status !== "presentation") {
    throw new TypeError("Expected a presentation result.");
  }
  return outcome.presentation;
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
  it.each(["prices", "tokens"] as const)("stores and replays the exact %s result without another domain read", async (kind) => {
    const fixture = createPriceFixture();
    try {
      const definition = kind === "prices" ? stockTokenPricesCapability : stockTokensCapability;
      const input = kind === "prices" ? { symbol: "AAPL" } : {};
      const domain = await fixture.bindings.invoke(definition, input, { signal: new AbortController().signal });
      if (!domain.ok) throw new Error(JSON.stringify(domain));
      const store = await openStore();
      const service = new McpAppPresentationService(store, createMcpAppResource("<!doctype html><main>Little John</main>"),
        { read: async () => { throw new Error("An immutable price cannot use Review memory."); } },
        async () => { throw new Error("An immutable price cannot create or open a decision card."); });
      const delivered = availableResult(await service.present(definition, input, canonicalResult(captureCanonicalJson(domain))));
      const resource = snapshotResource(delivered);
      const reads: { name: string; argumentsValue: Record<string, unknown> }[] = [];
      const app = fakeApp({ host: "standard", serverTools: true, callTool: chunkTool(service, reads) });
      const first = await admitPresentation(app, delivered, new AbortController().signal);
      expect(first.result).toEqual(domain);
      expect(reads).toHaveLength(0);
      expect(first.entry.presentationKind).toBe("immutable_result");
      expect(first.entry.cardKind).toBeUndefined();
      await fixture.close();
      const rpcCalls = fixture.calls.length;
      const replay = await service.getSnapshotResult(resource.descriptor.snapshotUri);
      const reopened = await admitPresentation(app, replay, new AbortController().signal);
      expect(reopened.result).toEqual(domain);
      expect(reopened.normalizedInput).toEqual(input);
      expect(reads).toHaveLength(resource.descriptor.resultChunkCount);
      expect(fixture.calls).toHaveLength(rpcCalls);
      expect(fixture.fetcher).toHaveBeenCalledTimes(kind === "prices" ? 1 : 0);
    } finally { await fixture.close(); }
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

  it("preserves exact resource unavailability without trying to reconstruct missing data", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(store, createMcpAppResource("<!doctype html><main>Little John</main>"),
      { read: async () => { throw new Error("No live Review belongs to immutable data."); } }, async () => { throw new Error("No decision card belongs to immutable data."); });
    const creating = availableResult(await service.present(stockTokenTradeHistoryCapability, input, ordinaryResult()));
    const resource = snapshotResource(creating);
    const replay = await service.getSnapshotResult(resource.descriptor.snapshotUri);
    const { _meta: _private, ...withoutPrivate } = replay;
    const unavailable = { kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_missing" };
    let reads = 0;
    const app = fakeApp({ host: "standard", serverResources: true, readResource: async (uri) => {
      reads += 1;
      expect(uri).toBe(resource.descriptor.snapshotUri);
      return { contents: [{ uri, mimeType: "application/json", text: canonicalJsonStringify(captureCanonicalJson(unavailable)) }] };
    } });
    expect(await admitPresentationToolResult(app, withoutPrivate, new AbortController().signal)).toEqual({
      status: "read_error", issue: { kind: "presentation", unavailable },
    });
    expect(reads).toBe(1);
  });

  it("delivers the accepted trade-history Core maximum through the production App envelope", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
    );
    const ordinaryPresented = availableResult((await service.present(
      stockTokenTradeHistoryCapability,
      input,
      ordinaryResult(),
    )));
    const linkTemplate = ordinaryPresented.content[1];
    if (linkTemplate?.type !== "resource_link") {
      throw new TypeError("Production App snapshot link is unavailable.");
    }

    const maximumInput = parseCapabilityInput(stockTokenTradeHistoryCapability, {
      symbol: "A".repeat(32),
      period: { count: 12, unit: "month" },
    });
    const maximumSuccess = parseCapabilitySuccess(
      stockTokenTradeHistoryCapability,
      maximumInput,
      maximumTradeHistorySuccess,
    );
    const maximumValue = captureCanonicalJson(maximumSuccess);
    const prepared = store.prepare({
      contractId: "market.stock_token_trade_history",
      contractVersion: "1",
      normalizedInput: maximumInput,
      admittedResult: maximumValue,
    });
    if (prepared.status !== "available") {
      throw new TypeError("Maximum App envelope fixture was not prepared.");
    }
    const resource = createPresentationSnapshotResource(prepared.value, maximumInput);
    const modelSummary = stockTokenTradeHistoryHumanSummary(maximumSuccess.data);
    const creatingResult: CallToolResult = {
      ...ordinaryPresented,
      structuredContent: maximumValue as Record<string, unknown>,
      content: [{ type: "text", text: modelSummary }, {
        ...linkTemplate,
        name: `presentation_snapshot_${resource.descriptor.snapshotId.slice("sha256:".length)}`,
        uri: resource.descriptor.snapshotUri,
      }],
      _meta: { ...ordinaryPresented._meta, [presentationSnapshotMetadataKey]: resource },
    };
    const serializedBytes = new TextEncoder().encode(JSON.stringify(creatingResult)).length;

    expect(new TextEncoder().encode(canonicalJsonStringify(maximumValue))).toHaveLength(595_952);
    expect(595_952).toBeLessThanOrEqual(stockTokenTradeHistoryMaximumSuccessUtf8Bytes);
    expect(serializedBytes).toBeLessThanOrEqual(maximumMcpToolResultUtf8Bytes);
    expect(admitMcpToolResultForDelivery(creatingResult).status).toBe("admitted");
  });

  it("augments one canonical result with its exact committed snapshot", async () => {
    const store = await openStore();
    let reads = 0;
    const countedStore: PresentationSnapshotStore = Object.freeze({
      prepare: (value: Parameters<PresentationSnapshotStore["prepare"]>[0]) =>
        store.prepare(value),
      commit: (value: Parameters<PresentationSnapshotStore["commit"]>[0]) =>
        store.commit(value),
      read: (snapshotId: Parameters<PresentationSnapshotStore["read"]>[0]) => {
        reads += 1;
        return store.read(snapshotId);
      },
      readResultChunk: (value: Parameters<PresentationSnapshotStore["readResultChunk"]>[0]) =>
        store.readResultChunk(value),
    });
    const service = new McpAppPresentationService(
      countedStore,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
    );
    const presented = availableResult((await service.present(
      stockTokenTradeHistoryCapability,
      input,
      ordinaryResult(),
    )));
    const resource = snapshotResource(presented);

    expect(presented.structuredContent).toEqual(canonicalTradeHistory);
    expect(presented.content).toEqual([
      ordinaryResult().content[0],
      expect.objectContaining({ type: "resource_link", uri: resource.descriptor.snapshotUri }),
    ]);
    expect(canonicalJsonStringify(captureCanonicalJson(presented._meta)))
      .not.toContain("candles");

    reads = 0;
    const replay = (await service.getSnapshotResult(resource.descriptor.snapshotUri));
    expect(reads).toBe(1);
    expect(replay.structuredContent).toEqual({
      kind: "presentation_snapshot_reference",
      snapshotUri: resource.descriptor.snapshotUri,
      descriptor: resource.descriptor,
    });
    expect(canonicalJsonStringify(captureCanonicalJson(replay.structuredContent)))
      .not.toContain("candles");
    expect(snapshotResource(replay)).toEqual(resource);
  });

  it("returns no result handoff when snapshot ownership is unavailable", async () => {
    const unavailableStore: PresentationSnapshotStore = Object.freeze({
      prepare: () => { throw new Error("database unavailable"); },
      commit: () => { throw new Error("unexpected commit"); },
      read: () => { throw new Error("database unavailable"); },
      readResultChunk: () => { throw new Error("database unavailable"); },
    });
    const service = new McpAppPresentationService(
      unavailableStore,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
    );
    expect((await service.present(
      stockTokenTradeHistoryCapability,
      input,
      ordinaryResult(),
    ))).toEqual({
      kind: "presentation_unavailable",
      status: "unavailable",
      reason: "runtime_unavailable",
    });
    expect((await service.getResultChunk(`littlejohn://presentation/snapshots/sha256/${"0".repeat(64)}`, 0))).toEqual({
      kind: "presentation_unavailable",
      status: "unavailable",
      reason: "runtime_unavailable",
    });
  });

  it("carries a new-commit capacity failure without publishing a presentation handoff", async () => {
    const store = await openStore();
    let commits = 0;
    const capacityStore: PresentationSnapshotStore = Object.freeze({
      prepare: store.prepare,
      commit: () => {
        commits += 1;
        return Object.freeze({ status: "unavailable", reason: "capacity_exceeded" });
      },
      read: store.read,
      readResultChunk: store.readResultChunk,
    });
    const service = new McpAppPresentationService(
      capacityStore,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
    );
    expect((await service.present(stockTokenTradeHistoryCapability, input, ordinaryResult()))).toEqual({
      kind: "presentation_unavailable", status: "unavailable", reason: "capacity_exceeded",
    });
    expect(commits).toBe(1);
  });

  it("rejects a valid result correlated to a different normalized input before snapshot commit", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
    );
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

    expect((await service.present(
      tokenCatalogApplicationContracts.selection,
      normalizedInput,
      canonicalResult(captureCanonicalJson(mismatchedResult)),
    ))).toEqual({
      kind: "presentation_unavailable",
      status: "unavailable",
      reason: "snapshot_inconsistent",
    });
  });

  it("requires one nonempty model-visible text projection before preparing a snapshot", async () => {
    const store = await openStore();
    let prepares = 0;
    const countedStore: PresentationSnapshotStore = Object.freeze({
      prepare: (value: Parameters<PresentationSnapshotStore["prepare"]>[0]) => {
        prepares += 1;
        return store.prepare(value);
      },
      commit: (value: Parameters<PresentationSnapshotStore["commit"]>[0]) =>
        store.commit(value),
      read: (snapshotId: Parameters<PresentationSnapshotStore["read"]>[0]) =>
        store.read(snapshotId),
      readResultChunk: (value: Parameters<PresentationSnapshotStore["readResultChunk"]>[0]) =>
        store.readResultChunk(value),
    });
    const service = new McpAppPresentationService(
      countedStore,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
    );
    const changed = ordinaryResult();
    changed.content = [{ type: "text", text: "" }];

    expect((await service.present(
      stockTokenTradeHistoryCapability,
      input,
      changed,
    ))).toEqual({
      kind: "presentation_unavailable",
      status: "unavailable",
      reason: "snapshot_inconsistent",
    });
    expect(prepares).toBe(0);
  });

  it("re-admits an application input through its normalized-input contract", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
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
    const presented = availableResult((await service.present(
      tokenCatalogApplicationContracts.selections,
      { account: target },
      canonicalResult(captureCanonicalJson(selections)),
    )));
    const resource = snapshotResource(presented);

    expect(resource.normalizedInput).toEqual(normalizedInput);
    expect(resource.normalizedInput).toEqual(expect.objectContaining({ cursor: null }));
    expect(JSON.parse((await service.readResource(resource.descriptor.snapshotUri)).text)).toEqual(resource);

    const admitted = await admitPresentation(fakeApp({
      host: "standard-host",
      serverTools: true,
      callTool: chunkTool(service),
    }), presented, new AbortController().signal);
    expect(admitted.normalizedInput).toEqual(resource.normalizedInput);
    expect(admitted.result).toEqual(selections);
  });

  it("admits creating results directly and reconstructs only a measured Host replay", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
    );
    const presented = availableResult((await service.present(
      stockTokenTradeHistoryCapability,
      input,
      ordinaryResult(),
    )));
    const resource = snapshotResource(presented);
    const signal = new AbortController().signal;
    const calls: { name: string; argumentsValue: Record<string, unknown> }[] = [];
    const resourceReads: string[] = [];
    const callTool = chunkTool(service, calls);

    const standard = await admitPresentation(fakeApp({
      host: "standard-host",
      serverResources: true,
      readResource: async (uri) => {
        resourceReads.push(uri);
        return { contents: [(await service.readResource(uri))] };
      },
      callTool,
    }), presented, signal);

    const codex = await admitPresentation(fakeApp({
      host: "chatgpt",
      serverTools: true,
      callTool,
    }), {
      ...presented,
      content: [{ type: "text", text: JSON.stringify({ content: presented.content }) }],
    }, signal);

    const claudeWithoutLink: CallToolResult = {
      ...presented,
      content: presented.content.filter((item) => item.type === "text"),
    };
    const claude = await admitPresentation(fakeApp({
      host: "Claude",
      serverTools: true,
      callTool,
    }), claudeWithoutLink, signal);
    const claudeContentLimited = await admitPresentation(fakeApp({
      host: "Claude",
      serverTools: true,
      callTool,
    }), {
      ...presented,
      content: [{
        type: "text",
        text: "Tool result too large for context; canonical content was offloaded by the Host.",
      }],
    }, signal);
    expect(calls).toEqual([]);
    expect(resourceReads).toEqual([]);

    const withoutPrivateResource: CallToolResult = { ...presented, _meta: undefined };
    await expect(admitPresentationToolResult(fakeApp({
      host: "standard-host",
      serverResources: true,
      readResource: async (uri) => {
        resourceReads.push(uri);
        return { contents: [(await service.readResource(uri))] };
      },
    }), withoutPrivateResource, signal)).rejects.toThrow(
      "omitted its private presentation resource",
    );
    expect(resourceReads).toEqual([]);

    const replay = (await service.getSnapshotResult(resource.descriptor.snapshotUri));
    const replayText = replay.content.find((item) => item.type === "text");
    if (replayText === undefined || replayText.type !== "text") {
      throw new TypeError("Replay canonical text is unavailable.");
    }
    const digest = resource.descriptor.snapshotId.slice("sha256:".length);
    const claudeAfterRemount = await admitPresentation(fakeApp({
      host: "Claude",
      serverResources: true,
      serverTools: true,
      readResource: async (uri) => ({ contents: [(await service.readResource(uri))] }),
      callTool,
    }), {
      structuredContent: replay.structuredContent,
      content: [replayText, {
        type: "text",
        text: `[Resource link: presentation_snapshot_${digest}] ${resource.descriptor.snapshotUri} (Exact immutable presentation input and descriptor.)`,
      }],
    }, signal);

    for (const admitted of [standard, codex, claude, claudeContentLimited, claudeAfterRemount]) {
      expect(admitted.entry.contractId).toBe("market.stock_token_trade_history");
      expect(admitted.normalizedInput).toEqual(input);
      expect(admitted.result).toEqual(canonicalTradeHistory);
    }
    expect(calls).toEqual([{
      name: "presentation_get_snapshot_chunk",
      argumentsValue: { snapshotUri: resource.descriptor.snapshotUri, index: 0 },
    }]);
    await expect(admitPresentationToolResult(
      fakeApp({ host: "unknown-host" }),
      claudeWithoutLink,
      signal,
    )).rejects.toThrow("omitted its exact presentation resource");
    await expect(admitPresentationToolResult(
      fakeApp({ host: "standard-host" }),
      ordinaryResult(),
      signal,
    )).rejects.toThrow("omitted its exact presentation resource");
  });

  it("does not use compatibility text as direct View authority", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
    );
    const presented = availableResult((await service.present(
      stockTokenTradeHistoryCapability,
      input,
      ordinaryResult(),
    )));
    const changed = {
      ...presented,
      content: presented.content.map((item) => item.type === "text"
        ? { ...item, text: "{}" }
        : item),
    };

    const admitted = await admitPresentation(
      fakeApp({ host: "standard-host" }),
      changed,
      new AbortController().signal,
    );
    expect(admitted.normalizedInput).toEqual(input);
    expect(admitted.result).toEqual(canonicalTradeHistory);

    await expect(admitPresentationToolResult(
      fakeApp({ host: "standard-host" }),
      { ...presented, structuredContent: undefined },
      new AbortController().signal,
    )).rejects.toThrow("omitted its canonical result");
    await expect(admitPresentationToolResult(
      fakeApp({ host: "standard-host" }),
      { ...presented, structuredContent: { untrusted: true } },
      new AbortController().signal,
    )).rejects.toThrow("result does not match its descriptor");
  });

  it("reconstructs a bounded replay reference through sequential chunks", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"), { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); },
    );
    const creating = availableResult((await service.present(
      stockTokenTradeHistoryCapability,
      input,
      ordinaryResult(),
    )));
    const resource = snapshotResource(creating);
    const replay = (await service.getSnapshotResult(resource.descriptor.snapshotUri));
    const calls: { name: string; argumentsValue: Record<string, unknown> }[] = [];
    const resourceReads: string[] = [];
    const admitted = await admitPresentation(fakeApp({
      host: "standard-host",
      serverResources: true,
      serverTools: true,
      readResource: async (uri) => {
        resourceReads.push(uri);
        return { contents: [(await service.readResource(uri))] };
      },
      callTool: chunkTool(service, calls),
    }), {
      structuredContent: replay.structuredContent,
      content: [],
    }, new AbortController().signal);

    expect(admitted.result).toEqual(canonicalTradeHistory);
    expect(resourceReads).toEqual([resource.descriptor.snapshotUri]);
    expect(calls).toEqual([{
      name: "presentation_get_snapshot_chunk",
      argumentsValue: { snapshotUri: resource.descriptor.snapshotUri, index: 0 },
    }]);
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
