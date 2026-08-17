import { Buffer } from "node:buffer";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createChainInvocationLifecycle,
  type ReferenceHistoryTraversal,
  type ReferenceMarketChainReadPort,
} from "../../src/chain/index.js";
import {
  chainAnchorSchema,
  createCanonicalClock,
  createExactRational,
  parseHash32,
  parseUtcTimestamp,
  referenceRoundObservationSchema,
  stockTokenReferenceMarketCatalog,
  type ReferenceFeedId,
  type ReferenceRoundObservation,
} from "../../src/core/index.js";
import { ReferenceMarketApplication } from "../../src/market-portfolio/application.js";
import {
  parseStockTokenMarketResult,
  resolveStockTokenMarketAsset,
  stockTokenMarketInputSchema,
  stockTokenMarketResultSchema,
} from "../../src/market-portfolio/stock-token-market.js";
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
import type {
  ReferenceFeedCacheCommit,
  ReferenceFeedCacheSnapshot,
  ReferenceMarketStore,
} from "../../src/runtime/reference-market-storage.js";
import { unavailableExecutionIndex } from "./execution-index-fixture.js";
import {
  findStockTokenExecutionIndexAsset,
  unavailableStockTokenExecutionSeries,
  type StockTokenExecutionIndexReadPort,
} from "../../src/market-portfolio/stock-token-execution-index.js";

const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "34307195",
  blockHash: `0x${"39".repeat(32)}`,
  blockTimestamp: "2026-08-12T13:30:00.000Z",
});
const rpcConfigurationDigest = "A".repeat(43);
const revision = officialAssetSnapshotRevisionSchema.parse(
  Buffer.alloc(16, 1).toString("base64url"),
);

const dispositionFor = (symbol: string) => {
  const disposition = stockTokenReferenceMarketCatalog.dispositions.find((entry) =>
    entry.asset.symbol === symbol);
  if (disposition === undefined) throw new Error(`Missing catalog fixture: ${symbol}`);
  return disposition;
};

const snapshotFor = (symbol: string): CommittedOfficialAssetSnapshot => {
  const disposition = dispositionFor(symbol);
  const deployment = disposition.asset.deployments.find((entry) => entry.chainId === 4663)!;
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
    chainId: block.chainId,
    members,
    revision,
    updatedAt: observedAt,
  });
};

const observation = (
  feedId: ReferenceFeedId,
  round: bigint,
  updatedAt: string,
): ReferenceRoundObservation => {
  const disposition = dispositionFor("AAPL");
  if (disposition.mapping.status !== "mapped") throw new Error("AAPL must be mapped.");
  const feed = disposition.mapping.feed;
  const roundId = ((1n << 64n) | round).toString(10);
  const updatedAtUnixSeconds = Math.floor(Date.parse(updatedAt) / 1_000).toString(10);
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
      observedAt: block.blockTimestamp,
      sourceOwner: "user_configured",
      sourceClass: "chain_rpc",
      sourceReference: {
        kind: "configured_rpc",
        sourceId: `rpc:${rpcConfigurationDigest}`,
        publicOrigin: "https://rpc.example",
        configurationDigest: rpcConfigurationDigest,
      },
      block,
    },
  });
};

const storeFixture = (): ReferenceMarketStore => {
  const snapshots = new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>();
  const empty = (feedId: ReferenceFeedId): ReferenceFeedCacheSnapshot => Object.freeze({
    feedId,
    revision: null,
    observations: Object.freeze([]),
    backfillPhaseId: null,
    backfillNextRoundId: null,
    retentionCutoffRoundId: null,
    integrityStatus: null,
    backfillStatus: null,
  });
  return Object.freeze({
    readFeed: (feedId: ReferenceFeedId) => snapshots.get(feedId) ?? empty(feedId),
    commitFeed: (input: ReferenceFeedCacheCommit) => {
      const current = snapshots.get(input.feedId) ?? empty(input.feedId);
      if (current.revision !== input.expectedRevision) throw new Error("Unexpected revision.");
      const byRound = new Map(current.observations.map((entry) => [entry.fact.roundId, entry]));
      for (const entry of input.observations) byRound.set(entry.fact.roundId, entry);
      const next: ReferenceFeedCacheSnapshot = Object.freeze({
        feedId: input.feedId,
        revision: "AQEBAQEBAQEBAQEBAQEBAQ",
        observations: Object.freeze([...byRound.values()]),
        backfillPhaseId: input.backfillPhaseId,
        backfillNextRoundId: input.backfillNextRoundId,
        retentionCutoffRoundId: current.retentionCutoffRoundId,
        integrityStatus: current.integrityStatus,
        backfillStatus: input.backfillStatus,
      });
      snapshots.set(input.feedId, next);
      return next;
    },
    readWatchlist: () => { throw new Error("Unexpected watchlist read."); },
    readWatchlistOperation: () => { throw new Error("Unexpected operation read."); },
    applyWatchlistChange: () => { throw new Error("Unexpected watchlist mutation."); },
  });
};

const availableApplication = (options: Readonly<{
  oraclePaused?: boolean;
  latestUpdatedAt?: string;
  olderUpdatedAt?: string;
}> = {}) => {
  const disposition = dispositionFor("AAPL");
  if (disposition.mapping.status !== "mapped") throw new Error("AAPL must be mapped.");
  const feed = disposition.mapping.feed;
  const snapshot = snapshotFor("AAPL");
  const member = snapshot.members[0]!;
  const latest = observation(
    feed.feedId,
    3n,
    options.latestUpdatedAt ?? "2026-08-12T13:25:00.000Z",
  );
  const older = observation(
    feed.feedId,
    2n,
    options.olderUpdatedAt ?? "2026-08-12T12:55:00.000Z",
  );
  const stockFactory = stockFactoryVerificationSchema.parse({
    assetUid: member.assetUid,
    contractAddress: member.contractAddress,
    block,
    proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
    proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
    implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
    implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
    tokenCodeHash: parseHash32(`0x${"22".repeat(32)}`),
  });
  const readStockTokenAtBlock = vi.fn<ReferenceMarketChainReadPort["readStockTokenAtBlock"]>(
    async (input) => {
      expect(input).toMatchObject({ member, feedId: feed.feedId });
      expect(input.block.anchor).toEqual(block);
      return Object.freeze({
        status: "observed",
        stockFactory,
        oraclePaused: options.oraclePaused ?? false,
        latest,
      });
    },
  );
  const readHistoryAtBlock = vi.fn(async (): Promise<ReferenceHistoryTraversal> => Object.freeze({
    observations: Object.freeze([older]),
    backfillPhaseId: "1",
    backfillNextRoundId: null,
    backfillStatus: "phase_boundary",
    phaseBoundaryObserved: true,
    malformedRoundObserved: false,
    failure: undefined,
  }));
  const chain: ReferenceMarketChainReadPort = Object.freeze({
    resolveCurrentBlock: async () => Object.freeze({ anchor: block }),
    readLatestAtBlock: async () => { throw new Error("Generic latest read is not expected."); },
    readStockTokenAtBlock,
    readHistoryAtBlock,
  });
  const readExecutionIndex = vi.fn<StockTokenExecutionIndexReadPort["read"]>(async (input) =>
    unavailableStockTokenExecutionSeries(input, "index_unavailable"));
  const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
  const application = new ReferenceMarketApplication({
    chainInvocations: lifecycle,
    chain,
    store: storeFixture(),
    officialAssets: Object.freeze({
      synchronize: async () => Object.freeze({ status: "current" as const, snapshot }),
      readStored: () => snapshot,
      close: async () => undefined,
    }),
    activeWallet: Object.freeze({ capture: () => { throw new Error("Wallet is not required."); } }),
    stockTokenExecutionIndex: Object.freeze({ read: readExecutionIndex }),
    clock: createCanonicalClock(() => block.blockTimestamp),
  });
  return {
    application,
    lifecycle,
    readStockTokenAtBlock,
    readHistoryAtBlock,
    readExecutionIndex,
  };
};

describe("Stock Token market ownership", () => {
  it("joins official identity, feed, block, synchronization, current value, and candles once", async () => {
    const fixture = availableApplication();
    const result = await fixture.application.stockTokenMarket({ symbol: "aapl", window: "1d" });
    expect(result).toMatchObject({
      status: "available",
      symbol: "AAPL",
      price: { status: "current" },
      history: { status: "partial" },
      execution: { status: "unavailable", reason: "index_unavailable" },
      limitations: expect.arrayContaining(["source_history_not_exhaustive", "phase_boundary"]),
    });
    if (!("status" in result) || result.status !== "available") {
      throw new Error("Expected an available Stock Token result.");
    }
    expect(result.warnings).toEqual([
      "reference_price_not_trade_price",
      "source_listing_not_revalidated",
      "sequencer_status_unavailable",
      "no_trade_volume",
      "partial_history",
    ]);
    expect(fixture.readStockTokenAtBlock).toHaveBeenCalledTimes(1);
    expect(fixture.readHistoryAtBlock).toHaveBeenCalledTimes(1);
    const executionAsset = findStockTokenExecutionIndexAsset(
      dispositionFor("AAPL").asset.deployments.find((entry) => entry.chainId === 4663)!
        .contractAddress,
    );
    expect(executionAsset).toBeDefined();
    expect(fixture.readExecutionIndex).toHaveBeenCalledWith({
      pairId: executionAsset!.poolId,
      requestedStart: "2026-08-11T13:30:00.000Z",
      requestedEnd: block.blockTimestamp,
    }, expect.any(AbortSignal));
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("returns an unmapped official asset without entering the chain boundary", async () => {
    const snapshot = snapshotFor("P");
    const chain = {
      resolveCurrentBlock: vi.fn(),
      readLatestAtBlock: vi.fn(),
      readStockTokenAtBlock: vi.fn(),
      readHistoryAtBlock: vi.fn(),
    } satisfies ReferenceMarketChainReadPort;
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const application = new ReferenceMarketApplication({
      chainInvocations: lifecycle,
      chain,
      store: storeFixture(),
      officialAssets: Object.freeze({
        synchronize: async () => Object.freeze({ status: "current" as const, snapshot }),
        readStored: () => snapshot,
        close: async () => undefined,
      }),
      activeWallet: Object.freeze({ capture: () => { throw new Error("Wallet is not required."); } }),
      stockTokenExecutionIndex: unavailableExecutionIndex,
      clock: createCanonicalClock(() => block.blockTimestamp),
    });
    await expect(application.stockTokenMarket({ symbol: "p", window: "1d" }))
      .resolves.toMatchObject({ status: "unavailable", reason: "mapping_unavailable" });
    expect(chain.resolveCurrentBlock).not.toHaveBeenCalled();
    await application.close();
    await lifecycle.close();
  });

  it.each([
    {
      condition: "a paused oracle",
      fixture: { oraclePaused: true },
      limitation: "oracle_paused",
      absentLimitation: "observation_not_fresh",
    },
    {
      condition: "an observation outside its admitted heartbeat",
      fixture: {
        latestUpdatedAt: "2026-08-10T13:25:00.000Z",
        olderUpdatedAt: "2026-08-10T12:55:00.000Z",
      },
      limitation: "observation_not_fresh",
      absentLimitation: "oracle_paused",
    },
  ] as const)("classifies $condition as last observed without conflating causes", async ({
    fixture,
    limitation,
    absentLimitation,
  }) => {
    const available = availableApplication(fixture);
    const result = await available.application.stockTokenMarket({ symbol: "AAPL", window: "1d" });
    if (!("status" in result) || result.status !== "available") {
      throw new Error("Expected an available Stock Token result.");
    }
    expect(result).toMatchObject({
      status: "available",
      price: { status: "last_observed" },
      limitations: expect.arrayContaining([limitation]),
    });
    expect(result.limitations).not.toContain(absentLimitation);
    await available.application.close();
    await available.lifecycle.close();
  });

  it("rejects a result admitted for a different normalized selector", () => {
    const result = resolveStockTokenMarketAsset({ symbol: "P", window: "1d" }, snapshotFor("P"));
    expect(() => parseStockTokenMarketResult({ symbol: "AAPL", window: "1d" }, result)).toThrow();
  });

  it("rejects mapped and unavailable dispositions that are not exact catalog members", async () => {
    const fixture = availableApplication();
    const available = await fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" });
    if (!("status" in available) || available.status !== "available") {
      throw new Error("Expected an available Stock Token result.");
    }
    const mappedDisposition = available.mapping.disposition;
    expect(() => parseStockTokenMarketResult({ symbol: "AAPL", window: "1d" }, {
      ...available,
      mapping: {
        ...available.mapping,
        disposition: {
          ...mappedDisposition,
          mapping: {
            ...mappedDisposition.mapping,
            feed: {
              ...mappedDisposition.mapping.feed,
              sourceRow: mappedDisposition.mapping.feed.sourceRow + 1,
            },
          },
        },
      },
    })).toThrow();
    await fixture.application.close();
    await fixture.lifecycle.close();

    const unavailable = resolveStockTokenMarketAsset({ symbol: "P", window: "1d" }, snapshotFor("P"));
    if (unavailable.status !== "unavailable" || unavailable.reason !== "mapping_unavailable") {
      throw new Error("Expected an unavailable Stock Token mapping.");
    }
    expect(() => parseStockTokenMarketResult({ symbol: "P", window: "1d" }, {
      ...unavailable,
      disposition: {
        ...unavailable.disposition,
        mapping: { status: "unmapped", reason: "feed_non_usd" },
      },
    })).toThrow();
  });

  it("projects strict public input and result schemas from the canonical owner", () => {
    const ajv = new Ajv2020({
      strict: true,
      formats: { uri: true, "date-time": true },
    });
    const input = z.toJSONSchema(stockTokenMarketInputSchema, {
      target: "draft-2020-12", io: "input", unrepresentable: "throw",
    });
    const output = z.toJSONSchema(stockTokenMarketResultSchema, {
      target: "draft-2020-12", io: "output", unrepresentable: "throw",
    });
    expect(() => ajv.compile(input)).not.toThrow();
    expect(() => ajv.compile(output)).not.toThrow();
  });
});
