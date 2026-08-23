import { describe, expect, it, vi } from "vitest";

import { createChainInvocationLifecycle } from "../../src/chain/index.js";
import {
  parseEvmAddress,
  parseHash32,
} from "../../src/core/index.js";
import {
  assertCommittedOfficialAssetSnapshot,
  stockFactoryVerificationSchema,
  type OfficialAssetSourceMember,
} from "../../src/registry/index.js";
import {
  officialAssetCandidateListDigest,
  officialAssetMemberSetDigest,
} from "../../src/registry/official-asset-contract.js";
import { StockTokenTradeHistoryApplication } from
  "../../src/stock-token-trade-history/application.js";
import {
  stockTokenTradeHistoryDataSchema,
  unavailableStockTokenTradeHistoryData,
  type StockTokenTradeHistoryData,
  type StockTokenTradeHistoryReadPort,
} from "../../src/stock-token-trade-history/stock-token-trade-history-data.js";
import {
  stockTokenTradeHistoryAvailableFixture,
} from "../interfaces/stock-token-trade-history-fixture.js";

const availableResult = stockTokenTradeHistoryAvailableFixture();
if (availableResult.status !== "available") {
  throw new TypeError("Expected an available Stock Token trade-history fixture.");
}

const availableData = stockTokenTradeHistoryDataSchema.parse({
  status: availableResult.status,
  requestedStart: availableResult.requestedStart,
  requestedEnd: availableResult.requestedEnd,
  source: availableResult.source,
  sourceFiles: availableResult.sourceFiles,
  freshness: availableResult.freshness,
  coverage: availableResult.coverage,
  chart: availableResult.chart,
});

const snapshotFor = (member: OfficialAssetSourceMember) => {
  const evidence = availableResult.officialAsset.snapshot;
  return assertCommittedOfficialAssetSnapshot({
    sourceUri: evidence.sourceUri,
    sourceObservedAt: evidence.sourceObservedAt,
    rawResponseDigest: evidence.rawResponseDigest,
    memberSetDigest: officialAssetMemberSetDigest([member]),
    candidateListDigest: officialAssetCandidateListDigest([member]),
    chainId: availableResult.block.chainId,
    members: [member],
    revision: evidence.revision,
    updatedAt: evidence.sourceObservedAt,
  });
};

const fixture = (input: Readonly<{
  member?: OfficialAssetSourceMember;
  read?: StockTokenTradeHistoryReadPort["read"];
}> = {}) => {
  const member = input.member ?? availableResult.officialAsset.member;
  const snapshot = snapshotFor(member);
  const verification = stockFactoryVerificationSchema.parse({
    ...availableResult.stockFactory,
    assetUid: member.assetUid,
    contractAddress: member.contractAddress,
  });
  const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
  const read = vi.fn<StockTokenTradeHistoryReadPort["read"]>(
    input.read ?? (async () => availableData),
  );
  const resolveCurrentBlock = vi.fn(async () => Object.freeze({
    anchor: availableResult.block,
  }));
  const verifyAtBlock = vi.fn(async () => Object.freeze({
    status: "verified" as const,
    member,
    verification,
  }));
  const application = new StockTokenTradeHistoryApplication({
    chainInvocations: lifecycle,
    currentBlockReads: Object.freeze({ resolveCurrentBlock }),
    officialAssets: Object.freeze({
      synchronize: async () => Object.freeze({ status: "current" as const, snapshot }),
      readStored: () => snapshot,
      close: async () => undefined,
    }),
    officialAssetReads: Object.freeze({
      verifyAtBlock,
      verifyManyAtBlock: async () => {
        throw new Error("Batch verification is not part of Stock Token trade history.");
      },
    }),
    tradeHistoryReads: Object.freeze({ read }),
  });
  return { application, lifecycle, read, resolveCurrentBlock, verifyAtBlock };
};

const closeFixture = async (value: ReturnType<typeof fixture>): Promise<void> => {
  await value.application.close();
  await value.lifecycle.close();
};

describe("Stock Token trade-history application", () => {
  it("returns the admitted trade history after one identity, block, and source-read sequence", async () => {
    const value = fixture();
    await expect(value.application.get({ symbol: "aapl", window: "1d" }))
      .resolves.toEqual(availableResult);
    expect(value.resolveCurrentBlock).toHaveBeenCalledTimes(1);
    expect(value.verifyAtBlock).toHaveBeenCalledWith(
      availableResult.officialAsset.member,
      { anchor: availableResult.block },
      expect.any(Object),
    );
    expect(value.read).toHaveBeenCalledWith({
      pairId: availableResult.source.poolId,
      window: "1d",
      requestedStart: availableResult.requestedStart,
      requestedEnd: availableResult.requestedEnd,
    }, expect.any(AbortSignal));
    await closeFixture(value);
  });

  it("returns asset_not_supported without reading trade-history data", async () => {
    const member: OfficialAssetSourceMember = {
      assetUid: parseHash32(`0x${"77".repeat(32)}`),
      contractAddress: parseEvmAddress("0x1111111111111111111111111111111111111111"),
      sourceName: "Unsupported Stock Token",
      sourceSymbol: "OTHER",
    };
    const value = fixture({ member });
    await expect(value.application.get({ symbol: "other", window: "7d" }))
      .resolves.toMatchObject({ status: "unavailable", reason: "asset_not_supported" });
    expect(value.read).not.toHaveBeenCalled();
    await closeFixture(value);
  });

  it.each([
    "trade_history_unavailable",
    "trade_history_inconsistent",
  ] as const)("preserves the provider-neutral %s result", async (reason) => {
    const value = fixture({
      read: async (request) => unavailableStockTokenTradeHistoryData(request, reason),
    });
    await expect(value.application.get({ symbol: "AAPL", window: "1d" }))
      .resolves.toMatchObject({ status: "unavailable", reason });
    expect(value.read).toHaveBeenCalledTimes(1);
    await closeFixture(value);
  });

  it("reports caller cancellation after settling the active source read", async () => {
    let started!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { started = resolve; });
    const value = fixture({
      read: async (_request, signal): Promise<StockTokenTradeHistoryData> => {
        started();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const caller = new AbortController();
    const active = value.application.get({ symbol: "AAPL", window: "1d" }, caller.signal);
    await sourceStarted;
    caller.abort();
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: { code: "request_aborted" },
    });
    await closeFixture(value);
  });

  it("aborts and settles the active source read before owner close completes", async () => {
    let started!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { started = resolve; });
    let sourceAborted = false;
    const value = fixture({
      read: async (_request, signal): Promise<StockTokenTradeHistoryData> => {
        started();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            sourceAborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
      },
    });
    const active = value.application.get({ symbol: "AAPL", window: "1d" });
    await sourceStarted;
    const closing = value.application.close();
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    await closing;
    expect(sourceAborted).toBe(true);
    await value.lifecycle.close();
  });
});
