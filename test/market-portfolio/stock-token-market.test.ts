import { Buffer } from "node:buffer";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createChainInvocationLifecycle,
  type ChainInvocationContext,
  type ChainInvocationPort,
  type ReferenceHistoryTraversal,
  type ReferenceMarketChainReadPort,
} from "../../src/chain/index.js";
import { ChainOperationError } from "../../src/chain/errors.js";
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
import { MarketPortfolioApplication } from "../../src/market-portfolio/application.js";
import {
  parseStockTokenMarketResult,
  resolveStockTokenOfficialAsset,
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
  type OfficialAssetSourceUnavailableReason,
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
import {
  findStockTokenExecutionIndexAsset,
  unavailableStockTokenExecutionSeries,
  type StockTokenExecutionIndexUnavailableReason,
  type StockTokenExecutionIndexReadPort,
  type StockTokenExecutionSeries,
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
    members: [...members],
    revision,
    updatedAt: observedAt,
  });
};

const snapshotWithMembers = (
  members: readonly OfficialAssetSourceMember[],
): CommittedOfficialAssetSnapshot => {
  const base = snapshotFor("AAPL");
  const ordered = [...members].sort((left, right) =>
    left.assetUid < right.assetUid ? -1 : left.assetUid > right.assetUid ? 1 : 0);
  return assertCommittedOfficialAssetSnapshot({
    ...base,
    members: ordered,
    memberSetDigest: officialAssetMemberSetDigest(ordered),
    candidateListDigest: officialAssetCandidateListDigest(ordered),
  });
};
const snapshotWithMember = (member: OfficialAssetSourceMember): CommittedOfficialAssetSnapshot =>
  snapshotWithMembers([member]);

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

const storeFixture = (
  initial: readonly ReferenceFeedCacheSnapshot[] = [],
): ReferenceMarketStore => {
  const snapshots = new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>(
    initial.map((snapshot) => [snapshot.feedId, snapshot]),
  );
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

const referenceSnapshot = (input: Readonly<{
  feedId: ReferenceFeedId;
  observations: readonly ReferenceRoundObservation[];
  retentionCutoffRoundId?: string;
  integrityStatus?: "conflict";
}>): ReferenceFeedCacheSnapshot => Object.freeze({
  feedId: input.feedId,
  revision: "AQEBAQEBAQEBAQEBAQEBAQ",
  observations: Object.freeze([...input.observations]),
  backfillPhaseId: "1",
  backfillNextRoundId: null,
  retentionCutoffRoundId: input.retentionCutoffRoundId ?? null,
  integrityStatus: input.integrityStatus ?? null,
  backfillStatus: input.retentionCutoffRoundId === undefined ? null : "retention_boundary",
});

const availableApplication = (options: Readonly<{
  oraclePaused?: boolean;
  latestUpdatedAt?: string;
  olderUpdatedAt?: string;
  officialSnapshot?: CommittedOfficialAssetSnapshot;
  executionReason?: StockTokenExecutionIndexUnavailableReason;
  stockFactoryUnavailable?: boolean;
  referenceRead?: ReferenceMarketChainReadPort["readStockTokenReferenceAtBlock"];
  executionRead?: StockTokenExecutionIndexReadPort["read"];
  officialSourceFailure?: OfficialAssetSourceUnavailableReason;
  referenceSnapshot?: ReferenceFeedCacheSnapshot;
  chainInvocations?: ChainInvocationPort;
}> = {}) => {
  const disposition = dispositionFor("AAPL");
  if (disposition.mapping.status !== "mapped") throw new Error("AAPL must be mapped.");
  const feed = disposition.mapping.feed;
  const snapshot = options.officialSnapshot ?? snapshotFor("AAPL");
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
  const readStockTokenReferenceAtBlock = vi.fn<ReferenceMarketChainReadPort["readStockTokenReferenceAtBlock"]>(
    async (input, context) => {
      if (options.referenceRead !== undefined) return options.referenceRead(input, context);
      expect(input).toMatchObject({ member, feedId: feed.feedId });
      expect(input.block.anchor).toEqual(block);
      return Object.freeze({
        status: "observed",
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
    readStockTokenReferenceAtBlock,
    readHistoryAtBlock,
  });
  const readExecutionIndex = vi.fn<StockTokenExecutionIndexReadPort["read"]>(
    options.executionRead ?? (async (input) =>
      unavailableStockTokenExecutionSeries(input, options.executionReason ?? "index_unavailable")),
  );
  const verifyAtBlock = vi.fn(async () => options.stockFactoryUnavailable
    ? Object.freeze({
        status: "unavailable" as const,
        member,
        reason: "source_unavailable" as const,
      })
    : Object.freeze({
        status: "verified" as const,
        member,
        verification: stockFactory,
      }));
  const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
  const application = new MarketPortfolioApplication({
    chainInvocations: options.chainInvocations ?? lifecycle,
    chain,
    store: storeFixture(options.referenceSnapshot === undefined
      ? []
      : [options.referenceSnapshot]),
    officialAssets: Object.freeze({
      synchronize: async () => options.officialSourceFailure !== undefined
        ? Object.freeze({
            status: "unavailable" as const,
            storedRevision: snapshot.revision,
            reason: options.officialSourceFailure,
          })
        : Object.freeze({ status: "current" as const, snapshot }),
      readStored: () => snapshot,
      close: async () => undefined,
    }),
    officialAssetReads: Object.freeze({
      verifyAtBlock,
      verifyManyAtBlock: async () => { throw new Error("Batch verification is not expected."); },
    }),
    activeWallet: Object.freeze({ capture: () => { throw new Error("Wallet is not required."); } }),
    stockTokenExecutionIndex: Object.freeze({ read: readExecutionIndex }),
    clock: createCanonicalClock(() => block.blockTimestamp),
  });
  return {
    application,
    lifecycle,
    readStockTokenReferenceAtBlock,
    readHistoryAtBlock,
    readExecutionIndex,
    verifyAtBlock,
  };
};

describe("Stock Token market ownership", () => {
  it("returns independent reference and execution results under one verified asset and block", async () => {
    const fixture = availableApplication();
    const result = await fixture.application.stockTokenMarket({ symbol: "aapl", window: "1d" });
    expect(result).toMatchObject({
      status: "available",
      symbol: "AAPL",
      reference: {
        status: "available",
        price: { status: "current" },
        history: { status: "partial" },
        limitations: expect.arrayContaining(["source_history_not_exhaustive", "phase_boundary"]),
      },
      execution: { status: "unavailable", reason: "index_unavailable" },
    });
    if (!("status" in result) || result.status !== "available") {
      throw new Error("Expected an available Stock Token result.");
    }
    if (result.reference.status !== "available") throw new Error("Expected reference data.");
    expect(result.reference.warnings).toEqual([
      "reference_price_not_trade_price",
      "source_listing_not_revalidated",
      "sequencer_status_unavailable",
      "no_trade_volume",
      "partial_history",
    ]);
    expect(fixture.readStockTokenReferenceAtBlock).toHaveBeenCalledTimes(1);
    expect(fixture.verifyAtBlock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSymbol: "AAPL" }),
      { anchor: block },
      expect.any(Object),
    );
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

  it("blocks both source branches when the official asset selector is missing or ambiguous", async () => {
    const missing = availableApplication();
    await expect(missing.application.stockTokenMarket({ symbol: "MSFT", window: "1d" }))
      .resolves.toMatchObject({ status: "unavailable", reason: "official_asset_not_found" });
    expect(missing.readStockTokenReferenceAtBlock).not.toHaveBeenCalled();
    expect(missing.readExecutionIndex).not.toHaveBeenCalled();
    await missing.application.close();
    await missing.lifecycle.close();

    const aapl = snapshotFor("AAPL").members[0]!;
    const second = snapshotFor("MSFT").members[0]!;
    const ambiguous = availableApplication({
      officialSnapshot: snapshotWithMembers([
        aapl,
        { ...second, sourceName: "Second AAPL", sourceSymbol: "AAPL" },
      ]),
    });
    await expect(ambiguous.application.stockTokenMarket({ symbol: "AAPL", window: "1d" }))
      .resolves.toMatchObject({ status: "unavailable", reason: "official_asset_symbol_ambiguous" });
    expect(ambiguous.readStockTokenReferenceAtBlock).not.toHaveBeenCalled();
    expect(ambiguous.readExecutionIndex).not.toHaveBeenCalled();
    await ambiguous.application.close();
    await ambiguous.lifecycle.close();
  });

  it("blocks both source branches when same-block StockFactory identity is unavailable", async () => {
    const fixture = availableApplication({ stockFactoryUnavailable: true });
    await expect(fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" }))
      .resolves.toMatchObject({
        status: "unavailable",
        reason: "stock_factory_unavailable",
        stockFactory: { status: "unavailable", reason: "source_unavailable" },
      });
    expect(fixture.readStockTokenReferenceAtBlock).not.toHaveBeenCalled();
    expect(fixture.readExecutionIndex).not.toHaveBeenCalled();
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("keeps execution independent from an admitted reference-only failure", async () => {
    let admittedExecution: StockTokenExecutionSeries | undefined;
    const fixture = availableApplication({
      referenceRead: async () => { throw new ChainOperationError("source_unavailable"); },
      executionRead: async (input) => {
        admittedExecution = unavailableStockTokenExecutionSeries(input, "index_unavailable");
        return admittedExecution;
      },
    });
    const result = await fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" });
    expect(result).toMatchObject({
      status: "available",
      reference: { status: "unavailable", reason: "source_unavailable" },
      execution: { status: "unavailable", reason: "index_unavailable" },
    });
    if (!("status" in result) || result.status !== "available") {
      throw new Error("Expected an available result.");
    }
    expect(Object.keys(result.reference).sort()).toEqual(["reason", "status"]);
    expect(result.execution).toEqual(admittedExecution);
    expect(fixture.readExecutionIndex).toHaveBeenCalledTimes(1);
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("keeps an admitted immutable-round conflict inside the reference sibling", async () => {
    const disposition = dispositionFor("AAPL");
    if (disposition.mapping.status !== "mapped") throw new Error("AAPL must be mapped.");
    const fixture = availableApplication({
      referenceSnapshot: referenceSnapshot({
        feedId: disposition.mapping.feed.feedId,
        observations: [observation(
          disposition.mapping.feed.feedId,
          2n,
          "2026-08-12T12:55:00.000Z",
        )],
        integrityStatus: "conflict",
      }),
    });
    await expect(fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" }))
      .resolves.toMatchObject({
        status: "available",
        reference: { status: "unavailable", reason: "source_inconsistent" },
        execution: { status: "unavailable", reason: "index_unavailable" },
      });
    expect(fixture.readExecutionIndex).toHaveBeenCalledTimes(1);
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("preserves retention regression as a whole-operation state conflict", async () => {
    const disposition = dispositionFor("AAPL");
    if (disposition.mapping.status !== "mapped") throw new Error("AAPL must be mapped.");
    const feedId = disposition.mapping.feed.feedId;
    const cutoffRoundId = ((1n << 64n) | 3n).toString(10);
    const fixture = availableApplication({
      referenceSnapshot: referenceSnapshot({
        feedId,
        observations: [observation(feedId, 4n, "2026-08-12T13:26:00.000Z")],
        retentionCutoffRoundId: cutoffRoundId,
      }),
    });
    await expect(fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" }))
      .resolves.toMatchObject({ ok: false, error: { code: "state_conflict" } });
    expect(fixture.readExecutionIndex).toHaveBeenCalledTimes(1);
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("does not reclassify a common rate limit as a reference-only outcome", async () => {
    const fixture = availableApplication({ officialSourceFailure: "rate_limited" });
    await expect(fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" }))
      .resolves.toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(fixture.readStockTokenReferenceAtBlock).not.toHaveBeenCalled();
    expect(fixture.readExecutionIndex).not.toHaveBeenCalled();
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it.each([
    "index_unavailable",
    "index_inconsistent",
    "outside_published_coverage",
  ] as const)("keeps the available reference independent from the execution-only %s outcome", async (reason) => {
    const fixture = availableApplication({ executionReason: reason });
    const result = await fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" });
    expect(result).toMatchObject({
      status: "available",
      reference: { status: "available", price: { status: "current" } },
      execution: { status: "unavailable", reason },
    });
    expect(fixture.readStockTokenReferenceAtBlock).toHaveBeenCalledTimes(1);
    expect(fixture.readExecutionIndex).toHaveBeenCalledTimes(1);
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("keeps execution independent from an admitted missing reference observation", async () => {
    const fixture = availableApplication({
      referenceRead: async () => Object.freeze({
        status: "unavailable" as const,
        reason: "no_valid_observation" as const,
        oraclePaused: false,
      }),
    });
    const result = await fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" });
    expect(result).toMatchObject({
      status: "available",
      reference: {
        status: "unavailable",
        reason: "no_valid_observation",
        oraclePaused: { value: false },
      },
      execution: { status: "unavailable", reason: "index_unavailable" },
    });
    expect(fixture.readExecutionIndex).toHaveBeenCalledTimes(1);
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("aborts and settles both source tasks before owner close completes", async () => {
    let markReferenceStarted!: () => void;
    let markExecutionStarted!: () => void;
    const referenceStarted = new Promise<void>((resolve) => { markReferenceStarted = resolve; });
    const executionStarted = new Promise<void>((resolve) => { markExecutionStarted = resolve; });
    let referenceAborted = false;
    let executionAborted = false;
    const fixture = availableApplication({
      referenceRead: async (_input, context) => {
        markReferenceStarted();
        return await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            referenceAborted = true;
            reject(new ChainOperationError("request_aborted"));
          }, { once: true });
        });
      },
      executionRead: async (_input, signal) => {
        markExecutionStarted();
        if (signal === undefined) throw new TypeError("Execution signal is required.");
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            executionAborted = true;
            reject(new ChainOperationError("request_aborted"));
          }, { once: true });
        });
      },
    });
    const active = fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" });
    await Promise.all([referenceStarted, executionStarted]);
    const closing = fixture.application.close();
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    await closing;
    expect(referenceAborted).toBe(true);
    expect(executionAborted).toBe(true);
    await fixture.lifecycle.close();
  });

  it("passes the complete invocation signal to both source siblings", async () => {
    const invocation = new AbortController();
    let outerSignal: AbortSignal | undefined;
    let referenceSignal: AbortSignal | undefined;
    let executionSignal: AbortSignal | undefined;
    const chainInvocations = Object.freeze({
      run: async <Result>(
        signal: AbortSignal,
        effect: (context: ChainInvocationContext) => Promise<Result>,
      ): Promise<Result> => {
        outerSignal = signal;
        return await effect(Object.freeze({ signal: invocation.signal }));
      },
    }) satisfies ChainInvocationPort;
    const fixture = availableApplication({
      chainInvocations,
      referenceRead: async (_input, context) => {
        referenceSignal = context.signal;
        return Object.freeze({
          status: "unavailable" as const,
          reason: "no_valid_observation" as const,
          oraclePaused: false,
        });
      },
      executionRead: async (input, signal) => {
        executionSignal = signal;
        return unavailableStockTokenExecutionSeries(input, "index_unavailable");
      },
    });
    await expect(fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" }))
      .resolves.toMatchObject({ status: "available" });
    expect(outerSignal).toBeDefined();
    expect(outerSignal).not.toBe(invocation.signal);
    expect(referenceSignal).toBe(invocation.signal);
    expect(executionSignal).toBe(invocation.signal);
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("settles started reference work when the execution port throws before returning a promise", async () => {
    let markReferenceStarted!: () => void;
    let releaseReference!: () => void;
    const referenceStarted = new Promise<void>((resolve) => { markReferenceStarted = resolve; });
    const referenceRelease = new Promise<void>((resolve) => { releaseReference = resolve; });
    const fixture = availableApplication({
      referenceRead: async () => {
        markReferenceStarted();
        await referenceRelease;
        throw new ChainOperationError("source_unavailable");
      },
      executionRead: () => {
        throw new Error("Synchronous execution adapter failure.");
      },
    });
    const active = fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" });
    await referenceStarted;
    let settled = false;
    void active.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseReference();
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("keeps execution independent from an outdated reference catalog identity", async () => {
    const indexed = snapshotFor("AAPL").members[0]!;
    const unknownMember: OfficialAssetSourceMember = {
      ...indexed,
      assetUid: parseHash32(`0x${"77".repeat(32)}`),
    };
    const fixture = availableApplication({ officialSnapshot: snapshotWithMember(unknownMember) });
    const result = await fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" });
    expect(result).toMatchObject({
      status: "available",
      reference: { status: "unavailable", reason: "mapping_catalog_outdated" },
      execution: { status: "unavailable", reason: "index_unavailable" },
    });
    expect(fixture.readStockTokenReferenceAtBlock).not.toHaveBeenCalled();
    expect(fixture.readExecutionIndex).toHaveBeenCalledTimes(1);
    expect(() => stockTokenMarketResultSchema.parse({
      ...result,
      reference: { status: "unavailable", reason: "source_unavailable" },
    })).toThrow();
    await fixture.application.close();
    await fixture.lifecycle.close();
  });

  it("keeps the common result available when the official asset has no Chainlink mapping", async () => {
    const snapshot = snapshotFor("P");
    const member = snapshot.members[0]!;
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
    const chain = {
      resolveCurrentBlock: vi.fn(async () => Object.freeze({ anchor: block })),
      readLatestAtBlock: vi.fn(),
      readStockTokenReferenceAtBlock: vi.fn(),
      readHistoryAtBlock: vi.fn(),
    } satisfies ReferenceMarketChainReadPort;
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const execution = vi.fn<StockTokenExecutionIndexReadPort["read"]>(async (input) =>
      unavailableStockTokenExecutionSeries(input, "index_unavailable"));
    const application = new MarketPortfolioApplication({
      chainInvocations: lifecycle,
      chain,
      store: storeFixture(),
      officialAssets: Object.freeze({
        synchronize: async () => Object.freeze({ status: "current" as const, snapshot }),
        readStored: () => snapshot,
        close: async () => undefined,
      }),
      officialAssetReads: Object.freeze({
        verifyAtBlock: async () => Object.freeze({
          status: "verified" as const,
          member,
          verification: stockFactory,
        }),
        verifyManyAtBlock: async () => { throw new Error("Batch verification is not expected."); },
      }),
      activeWallet: Object.freeze({ capture: () => { throw new Error("Wallet is not required."); } }),
      stockTokenExecutionIndex: Object.freeze({ read: execution }),
      clock: createCanonicalClock(() => block.blockTimestamp),
    });
    const result = await application.stockTokenMarket({ symbol: "p", window: "1d" });
    expect(result).toMatchObject({
      status: "available",
      reference: { status: "unavailable", reason: "mapping_unavailable" },
      execution: { status: "unavailable", reason: "asset_not_indexed" },
    });
    if (!("status" in result) || result.status !== "available") {
      throw new Error("Expected an available unmapped Stock Token result.");
    }
    expect(() => stockTokenMarketResultSchema.parse({
      ...result,
      reference: { status: "unavailable", reason: "source_unavailable" },
    })).toThrow();
    expect(chain.resolveCurrentBlock).toHaveBeenCalledTimes(1);
    expect(chain.readStockTokenReferenceAtBlock).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
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
      reference: {
        status: "available",
        price: { status: "last_observed" },
        limitations: expect.arrayContaining([limitation]),
      },
    });
    if (result.reference.status !== "available") throw new Error("Expected reference data.");
    expect(result.reference.limitations).not.toContain(absentLimitation);
    await available.application.close();
    await available.lifecycle.close();
  });

  it("rejects a result admitted for a different normalized selector", () => {
    const result = resolveStockTokenOfficialAsset({ symbol: "P", window: "1d" }, snapshotFor("P"));
    expect(() => parseStockTokenMarketResult({ symbol: "AAPL", window: "1d" }, result)).toThrow();
  });

  it("rejects a mapped disposition that is not the exact catalog member", async () => {
    const fixture = availableApplication();
    const available = await fixture.application.stockTokenMarket({ symbol: "AAPL", window: "1d" });
    if (!("status" in available) || available.status !== "available") {
      throw new Error("Expected an available Stock Token result.");
    }
    if (available.reference.status !== "available") throw new Error("Expected mapped reference data.");
    const availableReference = available.reference;
    const mappedDisposition = availableReference.mapping.disposition;
    expect(() => stockTokenMarketResultSchema.parse({
      ...available,
      price: availableReference.price,
    })).toThrow();
    expect(() => parseStockTokenMarketResult({ symbol: "AAPL", window: "1d" }, {
      ...available,
      reference: {
        ...availableReference,
        mapping: {
          ...availableReference.mapping,
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
      },
    })).toThrow();
    await fixture.application.close();
    await fixture.lifecycle.close();
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
