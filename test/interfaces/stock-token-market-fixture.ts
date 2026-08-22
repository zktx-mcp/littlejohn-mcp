import { Buffer } from "node:buffer";

import {
  chainAnchorSchema,
  createExactRational,
  parseHash32,
  parseUtcTimestamp,
  referenceRoundObservationSchema,
  stockTokenReferenceMarketCatalog,
  type ReferenceFeedId,
} from "../../src/core/index.js";
import { createDirectReferenceCandleSeries } from "../../src/market-portfolio/candles.js";
import {
  createAvailableStockTokenMarketResult,
  createAvailableStockTokenReferenceResult,
  createUnavailableStockTokenReferenceFromFailure,
  resolveStockTokenOfficialAsset,
  resolveStockTokenReferenceMapping,
  stockTokenMarketInterval,
  type StockTokenMarketResult,
} from "../../src/market-portfolio/stock-token-market.js";
import {
  findStockTokenExecutionIndexAsset,
  stockTokenExecutionIndexRegistry,
  stockTokenExecutionSeriesSchema,
  unavailableStockTokenExecutionSeries,
} from
  "../../src/market-portfolio/stock-token-execution-index.js";
import {
  assertCommittedOfficialAssetSnapshot,
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
import type { ReferenceFeedCacheSnapshot } from
  "../../src/runtime/reference-market-storage.js";

export const stockTokenMarketFixtureBlock = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "34307195",
  blockHash: `0x${"39".repeat(32)}`,
  blockTimestamp: "2026-08-12T13:30:00.000Z",
});

const dispositionFor = (symbol: string) => {
  const disposition = stockTokenReferenceMarketCatalog.dispositions.find((entry) =>
    entry.asset.symbol === symbol);
  if (disposition === undefined) throw new TypeError(`Missing Stock Token fixture: ${symbol}`);
  return disposition;
};

const snapshotFor = (symbol: string): CommittedOfficialAssetSnapshot => {
  const disposition = dispositionFor(symbol);
  const deployment = disposition.asset.deployments.find((entry) => entry.chainId === 4663);
  if (deployment === undefined) throw new TypeError("Stock Token fixture deployment is missing.");
  const members: OfficialAssetSourceMember[] = [{
    assetUid: disposition.asset.assetUid,
    contractAddress: deployment.contractAddress,
    sourceName: disposition.asset.name,
    sourceSymbol: disposition.asset.symbol,
  }];
  const observedAt = parseUtcTimestamp("2026-08-12T13:12:28.000Z");
  return assertCommittedOfficialAssetSnapshot({
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: observedAt,
    rawResponseDigest: parseHash32(`0x${"11".repeat(32)}`),
    memberSetDigest: officialAssetMemberSetDigest(members),
    candidateListDigest: officialAssetCandidateListDigest(members),
    chainId: stockTokenMarketFixtureBlock.chainId,
    members,
    revision: officialAssetSnapshotRevisionSchema.parse(
      Buffer.alloc(16, 1).toString("base64url"),
    ),
    updatedAt: observedAt,
  });
};

const observation = (feedId: ReferenceFeedId, round: bigint, updatedAt: string) => {
  const disposition = dispositionFor("AAPL");
  if (disposition.mapping.status !== "mapped") throw new TypeError("AAPL fixture is not mapped.");
  const feed = disposition.mapping.feed;
  const roundId = ((1n << 64n) | round).toString(10);
  const updatedAtUnixSeconds = String(Math.floor(Date.parse(updatedAt) / 1_000));
  return referenceRoundObservationSchema.parse({
    fact: {
      manifestVersion: 1,
      feedId,
      proxyAddress: feed.proxyAddress,
      decimals: feed.decimals,
      roundId,
      answeredInRound: roundId,
      answer: "23125000000",
      startedAtUnixSeconds: updatedAtUnixSeconds,
      updatedAtUnixSeconds,
      value: createExactRational(23_125_000_000n, 10n ** BigInt(feed.decimals)),
    },
    readEvidence: {
      observedAt: stockTokenMarketFixtureBlock.blockTimestamp,
      sourceOwner: "user_configured",
      sourceClass: "chain_rpc",
      sourceReference: {
        kind: "configured_rpc",
        sourceId: `rpc:${"A".repeat(43)}`,
        publicOrigin: "https://rpc.example",
        configurationDigest: "A".repeat(43),
      },
      block: stockTokenMarketFixtureBlock,
    },
  });
};

export const stockTokenMarketAvailableFixture = (): StockTokenMarketResult => {
  const request = { symbol: "AAPL", window: "1d" } as const;
  const disposition = dispositionFor(request.symbol);
  if (disposition.mapping.status !== "mapped") throw new TypeError("AAPL fixture is not mapped.");
  const resolution = resolveStockTokenOfficialAsset(request, snapshotFor(request.symbol));
  if (resolution.status !== "resolved") throw new TypeError("AAPL fixture did not resolve.");
  const referenceMapping = resolveStockTokenReferenceMapping(resolution.officialAsset);
  if (referenceMapping.status !== "mapped") throw new TypeError("AAPL fixture is not mapped.");
  const latest = observation(disposition.mapping.feed.feedId, 3n, "2026-08-12T13:25:00.000Z");
  const older = observation(disposition.mapping.feed.feedId, 2n, "2026-08-12T12:55:00.000Z");
  const snapshot: ReferenceFeedCacheSnapshot = Object.freeze({
    feedId: disposition.mapping.feed.feedId,
    revision: "AQEBAQEBAQEBAQEBAQEBAQ",
    observations: Object.freeze([older, latest]),
    backfillPhaseId: "1",
    backfillNextRoundId: null,
    retentionCutoffRoundId: null,
    integrityStatus: null,
    backfillStatus: "phase_boundary",
  });
  const member = resolution.officialAsset.member;
  const interval = stockTokenMarketInterval(request.window, stockTokenMarketFixtureBlock.blockTimestamp);
  const executionAsset = findStockTokenExecutionIndexAsset(member.contractAddress);
  if (executionAsset === undefined) throw new TypeError("AAPL execution fixture is not indexed.");
  const executionCandles = ([
    ["2026-08-12T13:25:00.000Z", "2026-08-12T13:26:00.000Z", "925", "4", 34307190],
    ["2026-08-12T13:26:00.000Z", "2026-08-12T13:27:00.000Z", "463", "2", 34307191],
    ["2026-08-12T13:27:00.000Z", "2026-08-12T13:28:00.000Z", "927", "4", 34307192],
  ] as const).map(([intervalStart, intervalEnd, numerator, denominator, blockNumber], index) => ({
    symbol: executionAsset.symbol,
    token: executionAsset.token,
    poolId: executionAsset.poolId,
    intervalStart,
    intervalEnd,
    open: { numerator, denominator },
    high: { numerator, denominator },
    low: { numerator, denominator },
    close: { numerator, denominator },
    tokenVolumeRaw: String(1_000 + index),
    quoteVolumeRaw: String(2_000 + index),
    tradeCount: 1,
    firstSource: {
      blockNumber: String(blockNumber),
      blockHash: `0x${String(40 + index).padStart(2, "0").repeat(32)}`,
      transactionIndex: 0,
      transactionHash: `0x${String(50 + index).padStart(2, "0").repeat(32)}`,
      logIndex: 0,
    },
    lastSource: {
      blockNumber: String(blockNumber),
      blockHash: `0x${String(40 + index).padStart(2, "0").repeat(32)}`,
      transactionIndex: 0,
      transactionHash: `0x${String(50 + index).padStart(2, "0").repeat(32)}`,
      logIndex: 0,
    },
  }));
  const execution = stockTokenExecutionSeriesSchema.parse({
    status: "available",
    requestedStart: interval.requestedStart,
    requestedEnd: interval.requestedEnd,
    source: {
      chainId: stockTokenExecutionIndexRegistry.chain.chainId,
      finality: stockTokenExecutionIndexRegistry.chain.finalityTag,
      poolManager: stockTokenExecutionIndexRegistry.deployment.poolManager,
      poolId: executionAsset.poolId,
      quoteToken: {
        address: executionAsset.pair.quoteAsset.address,
        decimals: executionAsset.pair.quoteAsset.decimals,
        symbol: "USDG",
      },
    },
    artifact: {
      contractVersion: "1",
      pairId: executionAsset.poolId,
      sequence: 2,
      coveredUntilTimestamp: interval.requestedEnd,
      stateSha256: "31".repeat(32),
      months: [{ month: "2026-08", sha256: "30".repeat(32) }],
      days: [{ day: "2026-08-12", sha256: "32".repeat(32) }],
    },
    freshness: "current",
    coverage: {
      status: "partial",
      intervals: [{
        fromBlock: "34307000",
        fromTimestamp: "2026-08-12T13:00:00.000Z",
        untilBlock: "34307196",
        untilTimestamp: interval.requestedEnd,
      }],
      limitations: ["before_published_coverage"],
    },
    detail: {
      status: "complete",
      observedCandleCount: executionCandles.length,
      limitations: [],
    },
    candles: executionCandles,
  });
  const stockFactory = stockFactoryVerificationSchema.parse({
    assetUid: member.assetUid,
    contractAddress: member.contractAddress,
    block: stockTokenMarketFixtureBlock,
    proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
    proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
    implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
    implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
    tokenCodeHash: parseHash32(`0x${"22".repeat(32)}`),
  });
  const series = createDirectReferenceCandleSeries({
    feedId: disposition.mapping.feed.feedId,
    window: request.window,
    block: stockTokenMarketFixtureBlock,
    snapshot,
  });
  const reference = createAvailableStockTokenReferenceResult({
    resolution: referenceMapping,
    officialAsset: resolution.officialAsset,
    block: stockTokenMarketFixtureBlock,
    read: Object.freeze({
      status: "observed" as const,
      oraclePaused: false,
      latest,
    }),
    series,
    snapshot,
    report: Object.freeze({
      remainingContinuation: false,
      remainingGap: false,
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
    }),
  });
  return createAvailableStockTokenMarketResult({
    request,
    resolution,
    block: stockTokenMarketFixtureBlock,
    stockFactory,
    reference,
    execution,
  });
};

export const stockTokenMarketExecutionUnavailableFixture = (): StockTokenMarketResult => {
  const value = stockTokenMarketAvailableFixture();
  if (value.status !== "available") throw new TypeError("Stock Token fixture is unavailable.");
  return createAvailableStockTokenMarketResult({
    request: { symbol: value.symbol, window: value.window },
    resolution: {
      status: "resolved",
      officialAsset: value.officialAsset,
    },
    block: value.block,
    stockFactory: value.stockFactory,
    reference: value.reference,
    execution: unavailableStockTokenExecutionSeries({
      requestedStart: value.execution.requestedStart,
      requestedEnd: value.execution.requestedEnd,
    }, "index_unavailable"),
  });
};

export const stockTokenMarketReferenceUnavailableFixture = (): StockTokenMarketResult => {
  const value = stockTokenMarketAvailableFixture();
  if (value.status !== "available" || value.execution.status !== "available") {
    throw new TypeError("Stock Token execution fixture is unavailable.");
  }
  const referenceResolution = resolveStockTokenReferenceMapping(value.officialAsset);
  if (referenceResolution.status !== "mapped") {
    throw new TypeError("Stock Token reference fixture is not mapped.");
  }
  return createAvailableStockTokenMarketResult({
    request: { symbol: value.symbol, window: value.window },
    resolution: { status: "resolved", officialAsset: value.officialAsset },
    block: value.block,
    stockFactory: value.stockFactory,
    reference: createUnavailableStockTokenReferenceFromFailure({
      resolution: referenceResolution,
      officialAsset: value.officialAsset,
      reason: "source_unavailable",
    }),
    execution: value.execution,
  });
};

export const stockTokenMarketUnmappedFixture = (): StockTokenMarketResult => {
  const request = { symbol: "P", window: "1d" } as const;
  const resolution = resolveStockTokenOfficialAsset(request, snapshotFor(request.symbol));
  if (resolution.status !== "resolved") throw new TypeError("P fixture did not resolve.");
  const reference = resolveStockTokenReferenceMapping(resolution.officialAsset);
  if (reference.status !== "unavailable") throw new TypeError("P fixture unexpectedly mapped.");
  const member = resolution.officialAsset.member;
  const stockFactory = stockFactoryVerificationSchema.parse({
    assetUid: member.assetUid,
    contractAddress: member.contractAddress,
    block: stockTokenMarketFixtureBlock,
    proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
    proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
    implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
    implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
    tokenCodeHash: parseHash32(`0x${"22".repeat(32)}`),
  });
  const interval = stockTokenMarketInterval(request.window, stockTokenMarketFixtureBlock.blockTimestamp);
  return createAvailableStockTokenMarketResult({
    request,
    resolution,
    block: stockTokenMarketFixtureBlock,
    stockFactory,
    reference,
    execution: unavailableStockTokenExecutionSeries(interval, "asset_not_indexed"),
  });
};
