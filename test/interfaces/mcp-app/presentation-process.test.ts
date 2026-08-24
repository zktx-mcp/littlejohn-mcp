import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  parseUtcTimestamp,
  type CanonicalJson,
} from "../../../src/core/index.js";
import {
  admitPresentationSnapshotResource,
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
  type AdmittedPresentation,
  type PresentationViewApp,
} from
  "../../../src/interfaces/mcp-app/view/lifecycle.js";
import { admitMcpToolResultForDelivery } from "../../../src/interfaces/mcp-result.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import type { PresentationSnapshotStore } from
  "../../../src/runtime/presentation-snapshot.js";
import { stockTokenTradeHistoryApplicationContract } from
  "../../../src/stock-token-trade-history/contracts.js";
import {
  tokenCatalogApplicationContracts,
  tokenSelectionDetailSchema,
} from "../../../src/token-catalog/client.js";
import { stockTokenTradeHistoryAvailableFixture } from
  "../stock-token-trade-history-fixture.js";
import { capturedCodexCreatingApplicationFailure } from
  "./error-carriage-fixture.js";

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

const input = stockTokenTradeHistoryApplicationContract.parseInput({
  symbol: "AAPL",
  window: "1d",
});
const tradeHistory = stockTokenTradeHistoryApplicationContract.parsePublicSuccess(
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
    structuredContent: service.getResultChunk(
      String(argumentsValue["snapshotId"]),
      Number(argumentsValue["index"]),
    ) as Record<string, unknown>,
    content: [],
  };
};

describe("MCP App presentation process", () => {
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
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const presented = availableResult(service.present(
      stockTokenTradeHistoryApplicationContract,
      input,
      ordinaryResult(),
    ));
    const resource = snapshotResource(presented);

    expect(presented.structuredContent).toEqual(canonicalTradeHistory);
    expect(presented.content).toEqual([
      ordinaryResult().content[0],
      expect.objectContaining({ type: "resource_link", uri: resource.descriptor.snapshotUri }),
    ]);
    expect(canonicalJsonStringify(captureCanonicalJson(presented._meta)))
      .not.toContain("candles");

    reads = 0;
    const replay = service.getSnapshotResult(resource.descriptor.snapshotUri);
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
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    expect(service.present(
      stockTokenTradeHistoryApplicationContract,
      input,
      ordinaryResult(),
    )).toEqual({
      kind: "presentation_unavailable",
      status: "unavailable",
      reason: "runtime_unavailable",
    });
    expect(service.getResultChunk(`sha256:${"0".repeat(64)}`, 0)).toEqual({
      kind: "presentation_unavailable",
      status: "unavailable",
      reason: "runtime_unavailable",
    });
  });

  it("rejects a valid result correlated to a different normalized input before snapshot commit", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const requestedAsset = {
      kind: "erc20" as const,
      chainId: "eip155:4663" as const,
      address: "0x1111111111111111111111111111111111111111" as const,
    };
    const normalizedInput = tokenCatalogApplicationContracts.selection.parseInput({
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

    expect(service.present(
      tokenCatalogApplicationContracts.selection,
      normalizedInput,
      canonicalResult(captureCanonicalJson(mismatchedResult)),
    )).toEqual({
      kind: "presentation_unavailable",
      status: "unavailable",
      reason: "snapshot_inconsistent",
    });
  });

  it("rejects mismatched canonical text before preparing a snapshot", async () => {
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
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const changed = ordinaryResult();
    changed.content = [{ type: "text", text: "{}" }];

    expect(service.present(
      stockTokenTradeHistoryApplicationContract,
      input,
      changed,
    )).toEqual({
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
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const normalizedInput = tokenCatalogApplicationContracts.selections.parseInput({});
    const selections = tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      normalizedInput,
      { selections: [], nextCursor: null },
    );
    const presented = availableResult(service.present(
      tokenCatalogApplicationContracts.selections,
      {},
      canonicalResult(captureCanonicalJson(selections)),
    ));
    const resource = snapshotResource(presented);

    expect(resource.normalizedInput).toEqual(normalizedInput);
    expect(resource.normalizedInput).toEqual(expect.objectContaining({ cursor: null }));
    expect(JSON.parse(service.readResource(resource.descriptor.snapshotUri).text)).toEqual(resource);

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
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const presented = availableResult(service.present(
      stockTokenTradeHistoryApplicationContract,
      input,
      ordinaryResult(),
    ));
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
        return { contents: [service.readResource(uri)] };
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
        return { contents: [service.readResource(uri)] };
      },
    }), withoutPrivateResource, signal)).rejects.toThrow(
      "omitted its private presentation resource",
    );
    expect(resourceReads).toEqual([]);

    const replay = service.getSnapshotResult(resource.descriptor.snapshotUri);
    const replayText = replay.content.find((item) => item.type === "text");
    if (replayText === undefined || replayText.type !== "text") {
      throw new TypeError("Replay canonical text is unavailable.");
    }
    const digest = resource.descriptor.snapshotId.slice("sha256:".length);
    const claudeAfterRemount = await admitPresentation(fakeApp({
      host: "Claude",
      serverResources: true,
      serverTools: true,
      readResource: async (uri) => ({ contents: [service.readResource(uri)] }),
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
      argumentsValue: { snapshotId: resource.descriptor.snapshotId, index: 0 },
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
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const presented = availableResult(service.present(
      stockTokenTradeHistoryApplicationContract,
      input,
      ordinaryResult(),
    ));
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
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const creating = availableResult(service.present(
      stockTokenTradeHistoryApplicationContract,
      input,
      ordinaryResult(),
    ));
    const resource = snapshotResource(creating);
    const replay = service.getSnapshotResult(resource.descriptor.snapshotUri);
    const calls: { name: string; argumentsValue: Record<string, unknown> }[] = [];
    const resourceReads: string[] = [];
    const admitted = await admitPresentation(fakeApp({
      host: "standard-host",
      serverResources: true,
      serverTools: true,
      readResource: async (uri) => {
        resourceReads.push(uri);
        return { contents: [service.readResource(uri)] };
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
      argumentsValue: { snapshotId: resource.descriptor.snapshotId, index: 0 },
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
