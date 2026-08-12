import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  initialReferenceWatchlistRevision,
  parseUtcTimestamp,
  referenceMarketManifest,
} from "../../../src/core/index.js";
import { referenceMarketApplicationContracts } from "../../../src/market-portfolio/contracts.js";
import {
  tokenCatalogApplicationContracts,
  tokenSelectionDetailSchema,
} from "../../../src/token-catalog/client.js";
import {
  admitPresentationSnapshotResource,
  presentationSnapshotMetadataKey,
  type PresentationSnapshotResource,
} from "../../../src/interfaces/mcp-app/contracts.js";
import { McpAppPresentationService, createMcpAppResource } from
  "../../../src/interfaces/mcp-app/server.js";
import { admitPresentationToolResult, type PresentationViewApp } from
  "../../../src/interfaces/mcp-app/view/lifecycle.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import type { PresentationSnapshotStore } from
  "../../../src/runtime/presentation-snapshot.js";

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

const input = referenceMarketApplicationContracts.watchlist.parseInput({});
const watchlist = referenceMarketApplicationContracts.watchlist.parsePublicSuccess(input, {
  account: {
    chainId: "eip155:4663",
    address: "0x1111111111111111111111111111111111111111",
  },
  revision: initialReferenceWatchlistRevision,
  entries: [referenceMarketManifest.pairs[0]],
});
const canonicalWatchlist = captureCanonicalJson(watchlist);

const ordinaryResult = (): CallToolResult => ({
  structuredContent: canonicalWatchlist as Record<string, unknown>,
  content: [{ type: "text", text: canonicalJsonStringify(canonicalWatchlist) }],
});

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

describe("MCP App presentation process", () => {
  it("advertises one exact committed snapshot while preserving the ordinary result", async () => {
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
    const presented = service.present(
      referenceMarketApplicationContracts.watchlist,
      input,
      watchlist,
      ordinaryResult(),
    );
    const resource = snapshotResource(presented);

    expect(presented.structuredContent).toEqual(canonicalWatchlist);
    expect(presented.content[0]).toEqual(ordinaryResult().content[0]);
    expect(presented.content.filter((item) => item.type === "resource_link"))
      .toEqual([expect.objectContaining({ uri: resource.descriptor.snapshotUri })]);

    reads = 0;
    const replay = service.getSnapshotResult(resource.descriptor.snapshotUri);
    expect(reads).toBe(1);
    expect(replay.structuredContent).toEqual({
      kind: "presentation_snapshot_reference",
      snapshotUri: resource.descriptor.snapshotUri,
      descriptor: resource.descriptor,
    });
    expect(canonicalJsonStringify(captureCanonicalJson(replay.structuredContent)))
      .not.toContain("entries");
    expect(snapshotResource(replay)).toEqual(resource);
  });

  it("maps presentation ownership failures without changing the admitted MCP result", async () => {
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
    const ordinary = ordinaryResult();
    const presented = service.present(
      referenceMarketApplicationContracts.watchlist,
      input,
      watchlist,
      ordinary,
    );
    expect(presented.content).toEqual(ordinary.content);
    expect(presented.structuredContent).toEqual(ordinary.structuredContent);
    expect(presented._meta?.[presentationSnapshotMetadataKey]).toEqual({
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

  it("rejects a valid result correlated to a different normalized input before rendering", async () => {
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
    const differentAsset = {
      ...requestedAsset,
      address: "0x2222222222222222222222222222222222222222" as const,
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
        asset: differentAsset,
        included: true,
        revision: "AAAAAAAAAAAAAAAAAAAAAA",
        createdAt: openedAt,
        updatedAt: openedAt,
      },
      historicalInspection: null,
    });
    const canonicalResult = captureCanonicalJson(mismatchedResult);
    const ordinary: CallToolResult = {
      structuredContent: canonicalResult as Record<string, unknown>,
      content: [{ type: "text", text: canonicalJsonStringify(canonicalResult) }],
    };
    const presented = service.present(
      tokenCatalogApplicationContracts.selection,
      normalizedInput,
      mismatchedResult,
      ordinary,
    );

    expect(presented.structuredContent).toEqual(ordinary.structuredContent);
    expect(presented._meta?.[presentationSnapshotMetadataKey]).toEqual({
      kind: "presentation_unavailable",
      status: "unavailable",
      reason: "snapshot_inconsistent",
    });
    await expect(admitPresentationToolResult(
      fakeApp({ host: "standard-host" }),
      presented,
      new AbortController().signal,
    )).rejects.toThrow("Presentation unavailable: snapshot_inconsistent");
  });

  it("routes standard and measured Host transports into the same canonical admission", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const presented = service.present(
      referenceMarketApplicationContracts.watchlist,
      input,
      watchlist,
      ordinaryResult(),
    );
    const resource = snapshotResource(presented);
    const signal = new AbortController().signal;

    const withoutPrivateMetadata: CallToolResult = {
      content: presented.content,
      structuredContent: presented.structuredContent,
    };
    const standard = await admitPresentationToolResult(fakeApp({
      host: "standard-host",
      serverResources: true,
      readResource: async (uri) => ({ contents: [service.readResource(uri)] }),
    }), withoutPrivateMetadata, signal);

    const codexWrapped: CallToolResult = {
      ...presented,
      content: [{ type: "text", text: JSON.stringify({ content: presented.content }) }],
    };
    const codex = await admitPresentationToolResult(
      fakeApp({ host: "chatgpt" }),
      codexWrapped,
      signal,
    );

    const claudeWithoutLink: CallToolResult = {
      ...presented,
      content: [presented.content[0]!],
    };
    const claude = await admitPresentationToolResult(
      fakeApp({ host: "Claude" }),
      claudeWithoutLink,
      signal,
    );

    const digest = resource.descriptor.snapshotId.slice("sha256:".length);
    const claudeRemounted: CallToolResult = {
      content: [
        presented.content[0]!,
        {
          type: "text",
          text: `[Resource link: presentation_snapshot_${digest}] ${resource.descriptor.snapshotUri} (Exact immutable presentation input and descriptor.)`,
        },
      ],
      structuredContent: presented.structuredContent,
    };
    const claudeAfterRemount = await admitPresentationToolResult(fakeApp({
      host: "Claude",
      serverResources: true,
      readResource: async (uri) => ({ contents: [service.readResource(uri)] }),
    }), claudeRemounted, signal);

    for (const admitted of [standard, codex, claude, claudeAfterRemount]) {
      expect(admitted.entry.contractId).toBe("market.watchlist");
      expect(admitted.normalizedInput).toEqual(input);
      expect(admitted.result).toEqual(canonicalWatchlist);
      expect(admitted.source).toBe("creating_result");
    }
    await expect(admitPresentationToolResult(
      fakeApp({ host: "unknown-host" }),
      claudeWithoutLink,
      signal,
    )).rejects.toThrow("omitted its exact presentation resource");
    expect(resource.descriptor.contractId).toBe("market.watchlist");
  });

  it("reconstructs one bounded replay from its exact reference and sequential chunks", async () => {
    const store = await openStore();
    const service = new McpAppPresentationService(
      store,
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const creating = service.present(
      referenceMarketApplicationContracts.watchlist,
      input,
      watchlist,
      ordinaryResult(),
    );
    const resource = snapshotResource(creating);
    const replay = service.getSnapshotResult(resource.descriptor.snapshotUri);
    const replayWithoutTransientTransport: CallToolResult = {
      structuredContent: replay.structuredContent,
      content: [],
    };
    const calls: { name: string; argumentsValue: Record<string, unknown> }[] = [];
    const resourceReads: string[] = [];
    const app = fakeApp({
      host: "standard-host",
      serverResources: true,
      serverTools: true,
      readResource: async (uri) => {
        resourceReads.push(uri);
        return { contents: [service.readResource(uri)] };
      },
      callTool: async (name, argumentsValue) => {
        calls.push({ name, argumentsValue });
        return {
          structuredContent: service.getResultChunk(
            String(argumentsValue["snapshotId"]),
            Number(argumentsValue["index"]),
          ) as Record<string, unknown>,
          content: [],
        };
      },
    });
    const admitted = await admitPresentationToolResult(
      app,
      replayWithoutTransientTransport,
      new AbortController().signal,
    );

    expect(admitted.source).toBe("exact_snapshot");
    expect(admitted.result).toEqual(canonicalWatchlist);
    expect(resourceReads).toEqual([resource.descriptor.snapshotUri]);
    expect(calls).toEqual([{
      name: "presentation_get_snapshot_chunk",
      argumentsValue: { snapshotId: resource.descriptor.snapshotId, index: 0 },
    }]);
  });
});
