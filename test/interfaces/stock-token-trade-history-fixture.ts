import { Buffer } from "node:buffer";

import {
  chainAnchorSchema,
  parseEvmAddress,
  parseHash32,
  parseUtcTimestamp,
} from "../../src/core/index.js";
import {
  createStockTokenTradeHistoryResult,
  findStockTokenTradeHistoryAsset,
  resolveStockTokenTradeHistoryOfficialAsset,
  stockTokenTradeHistoryChartWindowDefinitions,
  stockTokenTradeHistoryDataSchema,
  stockTokenTradeHistoryInterval,
  stockTokenTradeHistoryRegistry,
  unavailableStockTokenTradeHistoryData,
  type StockTokenTradeHistoryResult,
} from "../../src/stock-token-trade-history/index.js";
import {
  assertCommittedOfficialAssetSnapshot,
  defaultStockTokenManifest,
  officialAssetSnapshotRevisionSchema,
  officialAssetSourceDefinition,
  stockFactoryAdmissionManifest,
  stockFactoryVerificationSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSourceMember,
} from "../../src/registry/index.js";
import {
  officialAssetCandidateListDigest,
  officialAssetMemberSetDigest,
} from "../../src/registry/official-asset-contract.js";

export const stockTokenTradeHistoryFixtureBlock = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "34307195",
  blockHash: `0x${"39".repeat(32)}`,
  blockTimestamp: "2026-08-12T13:37:23.000Z",
});

const request = Object.freeze({ symbol: "AAPL", window: "1d" as const });
const asset = findStockTokenTradeHistoryAsset(
  parseEvmAddress("0xaf3d76f1834a1d425780943c99ea8a608f8a93f9"),
);
if (asset === undefined) throw new TypeError("AAPL trade-history fixture asset is unavailable.");
const authority = defaultStockTokenManifest.assets.find(
  (candidate) => candidate.contractAddress === asset.token,
);
if (authority === undefined) throw new TypeError("AAPL official fixture identity is unavailable.");

const snapshot = (): CommittedOfficialAssetSnapshot => {
  const members: OfficialAssetSourceMember[] = [{
    assetUid: authority.assetUid,
    contractAddress: asset.token,
    sourceName: asset.name,
    sourceSymbol: asset.symbol,
  }];
  const observedAt = parseUtcTimestamp("2026-08-12T13:12:28.000Z");
  return assertCommittedOfficialAssetSnapshot({
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: observedAt,
    rawResponseDigest: parseHash32(`0x${"11".repeat(32)}`),
    memberSetDigest: officialAssetMemberSetDigest(members),
    candidateListDigest: officialAssetCandidateListDigest(members),
    chainId: stockTokenTradeHistoryFixtureBlock.chainId,
    members,
    revision: officialAssetSnapshotRevisionSchema.parse(
      Buffer.alloc(16, 1).toString("base64url"),
    ),
    updatedAt: observedAt,
  });
};

const resolved = () => {
  const resolution = resolveStockTokenTradeHistoryOfficialAsset(request, snapshot());
  if (resolution.status !== "resolved") {
    throw new TypeError("AAPL trade-history fixture did not resolve.");
  }
  return resolution;
};

const stockFactory = () => stockFactoryVerificationSchema.parse({
  assetUid: authority.assetUid,
  contractAddress: asset.token,
  block: stockTokenTradeHistoryFixtureBlock,
  proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
  proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
  implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
  implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
  tokenCodeHash: parseHash32(`0x${"22".repeat(32)}`),
});

const availableData = () => {
  const interval = stockTokenTradeHistoryInterval(
    request.window,
    stockTokenTradeHistoryFixtureBlock.blockTimestamp,
  );
  const candles = ([
    ["2026-08-12T13:34:00.000Z", "925", "4", 34307190],
    ["2026-08-12T13:35:00.000Z", "463", "2", 34307191],
    ["2026-08-12T13:36:00.000Z", "927", "4", 34307192],
  ] as const).map(([intervalStart, numerator, denominator, blockNumber], index) => {
    const source = {
      blockNumber: String(blockNumber),
      blockHash: `0x${String(40 + index).padStart(2, "0").repeat(32)}`,
      transactionIndex: 0,
      transactionHash: `0x${String(50 + index).padStart(2, "0").repeat(32)}`,
      logIndex: 0,
    };
    return {
      symbol: asset.symbol,
      token: asset.token,
      poolId: asset.poolId,
      intervalStart,
      intervalEnd: new Date(Date.parse(intervalStart) + 60_000).toISOString(),
      open: { numerator, denominator },
      high: { numerator, denominator },
      low: { numerator, denominator },
      close: { numerator, denominator },
      tokenVolumeRaw: String(1_000 + index),
      quoteVolumeRaw: String(2_000 + index),
      tradeCount: 1,
      firstSource: source,
      lastSource: source,
    };
  });
  const definition = stockTokenTradeHistoryChartWindowDefinitions[request.window];
  const coverageStart = "2026-08-12T13:00:00.000Z";
  const coverageEnd = "2026-08-12T13:37:00.000Z";
  const firstPositionStart = Math.floor(
    Date.parse(interval.requestedStart) / definition.intervalMilliseconds,
  ) * definition.intervalMilliseconds;
  const positionCount = Math.ceil(
    (Date.parse(interval.requestedEnd) - firstPositionStart) / definition.intervalMilliseconds,
  );
  const positions = Array.from({ length: positionCount }, (_, index) => {
    const positionStart = firstPositionStart + index * definition.intervalMilliseconds;
    const positionEnd = positionStart + definition.intervalMilliseconds;
    const representedStart = Math.max(positionStart, Date.parse(interval.requestedStart));
    const representedEnd = Math.min(positionEnd, Date.parse(interval.requestedEnd));
    const overlapStart = Math.max(representedStart, Date.parse(coverageStart));
    const overlapEnd = Math.min(representedEnd, Date.parse(coverageEnd));
    const positionCoverage = overlapStart >= overlapEnd
      ? "unavailable"
      : overlapStart === representedStart && overlapEnd === representedEnd &&
          representedStart % 60_000 === 0 && representedEnd % 60_000 === 0
        ? "complete"
        : "partial";
    return {
      intervalStart: new Date(positionStart).toISOString(),
      intervalEnd: new Date(positionEnd).toISOString(),
      representedStart: new Date(representedStart).toISOString(),
      representedEnd: new Date(representedEnd).toISOString(),
      coverage: positionCoverage,
      candle: positionStart === Date.parse("2026-08-12T13:30:00.000Z")
        ? {
            open: candles[0]!.open,
            high: candles[2]!.high,
            low: candles[0]!.low,
            close: candles[2]!.close,
            tokenVolumeRaw: "3003",
            quoteVolumeRaw: "6003",
            tradeCount: "3",
            firstSource: candles[0]!.firstSource,
            lastSource: candles[2]!.lastSource,
            observedStart: candles[0]!.intervalStart,
            observedEnd: candles[2]!.intervalEnd,
          }
        : null,
    };
  });
  return stockTokenTradeHistoryDataSchema.parse({
    status: "available",
    requestedStart: interval.requestedStart,
    requestedEnd: interval.requestedEnd,
    source: {
      chainId: stockTokenTradeHistoryRegistry.chain.chainId,
      finality: stockTokenTradeHistoryRegistry.chain.finalityTag,
      poolManager: stockTokenTradeHistoryRegistry.deployment.poolManager,
      poolId: asset.poolId,
      quoteToken: {
        address: asset.pair.quoteAsset.address,
        decimals: asset.pair.quoteAsset.decimals,
        symbol: "USDG",
      },
    },
    sourceFiles: {
      contractVersion: "1",
      pairId: asset.poolId,
      sequence: 2,
      coveredUntilTimestamp: coverageEnd,
      stateSha256: "31".repeat(32),
      months: [{ month: "2026-08", sha256: "30".repeat(32) }],
      days: [{ day: "2026-08-12", sha256: "32".repeat(32) }],
    },
    freshness: "current",
    coverage: {
      status: "partial",
      intervals: [{
        fromBlock: "34307000",
        fromTimestamp: coverageStart,
        untilBlock: "34307196",
        untilTimestamp: coverageEnd,
      }],
      limitations: ["before_published_coverage", "after_published_coverage"],
    },
    chart: {
      window: request.window,
      requestedStart: interval.requestedStart,
      requestedEnd: interval.requestedEnd,
      source: {
        chainId: stockTokenTradeHistoryRegistry.chain.chainId,
        finality: stockTokenTradeHistoryRegistry.chain.finalityTag,
        poolManager: stockTokenTradeHistoryRegistry.deployment.poolManager,
        poolId: asset.poolId,
        token: { address: asset.token, decimals: asset.tokenDecimals, symbol: asset.symbol },
        quoteToken: {
          address: asset.pair.quoteAsset.address,
          decimals: asset.pair.quoteAsset.decimals,
          symbol: "USDG",
        },
      },
      positions,
    },
  });
};

export const stockTokenTradeHistoryAvailableFixture = (): StockTokenTradeHistoryResult =>
  createStockTokenTradeHistoryResult({
    request,
    resolution: resolved(),
    block: stockTokenTradeHistoryFixtureBlock,
    stockFactory: stockFactory(),
    data: availableData(),
  });

export const stockTokenTradeHistoryUnavailableFixture = (): StockTokenTradeHistoryResult => {
  const interval = stockTokenTradeHistoryInterval(
    request.window,
    stockTokenTradeHistoryFixtureBlock.blockTimestamp,
  );
  return createStockTokenTradeHistoryResult({
    request,
    resolution: resolved(),
    block: stockTokenTradeHistoryFixtureBlock,
    stockFactory: stockFactory(),
    data: unavailableStockTokenTradeHistoryData(interval, "trade_history_unavailable"),
  });
};
