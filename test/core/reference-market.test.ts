import { describe, expect, it } from "vitest";

import {
  createExactRational,
  createReferenceHistoryWorkPlan,
  deriveReferencePairValue,
  exactRationalSchema,
  initialReferenceWatchlistRevision,
  parseReferenceCompositeRoundId,
  referenceFeedTraversalStateSchema,
  referenceHistorySuccessSchema,
  referenceHistoryWarnings,
  referenceCompositeRoundIdSchema,
  referenceMarketMappingEvidenceSchema,
  referenceMarketManifest,
  referenceMarketManifestSchema,
  referencePairIds,
  referencePriceSuccessSchema,
  referencePriceWarnings,
  referenceRoundObservationSchema,
  referenceWatchlistReorderInputSchema,
  referenceWatchlistRevisionSchema,
  referenceWatchlistSuccessSchema,
} from "../../src/core/reference-market.js";

const blockHash = `0x${"00".repeat(32)}`;
const ethUsdPairId =
  "0x6ebd461b84c32591c68ca0c58037f2d7786040f83dd9a7d50808aab58280095d";
const usdgUsdPairId =
  "0x27acae83c2b702463f8f36b08f01223412d582f316a281f439c84bdc0d7f3a59";
const ethUsdgPairId =
  "0xe7ff8704493555892931b237cde2c90e470d05c7350e0780fe3a2a7aa2d8666e";
const rpcConfigurationDigest = "A".repeat(43);

const mappingEvidence = {
  sourceOwner: "Chainlink Foundation",
  sourceClass: "official_document",
  sourceUri: "https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood",
  sourceObservedAt: "2026-07-23T02:00:12.000Z",
  freshnessStatus: "unknown",
  freshnessRule: "not_revalidated_at_runtime",
  coverage: "two_named_robinhood_chain_standard_proxy_mappings",
  exclusions: ["all_other_networks_and_feeds"],
  supportedConclusions: [
    "feed_address_association_at_observation_time",
    "feed_description_at_observation_time",
    "feed_decimals_at_observation_time",
    "feed_heartbeat_at_observation_time",
  ],
  unsupportedConclusions: [
    "ongoing_directory_membership",
    "proxy_correctness_after_observation",
    "source_uptime",
    "price_correctness",
    "endorsement",
    "trade_price",
    "sequencer_status",
    "legal_value",
  ],
} as const;

const blockAt = (blockTimestamp: string) => ({
  chainId: "eip155:4663",
  blockNumber: "1",
  blockHash,
  blockTimestamp,
});

const observation = (input: Readonly<{
  feedId: "eth_usd" | "usdg_usd";
  roundId: string;
  answer: string;
  updatedAtUnixSeconds?: string;
  blockTimestamp?: string;
  observedAt?: string;
}>) => {
  const feed = referenceMarketManifest.feeds.find((entry) => entry.feedId === input.feedId)!;
  const updatedAtUnixSeconds = input.updatedAtUnixSeconds ?? "1784592000";
  return referenceRoundObservationSchema.parse({
    fact: {
      manifestVersion: 1,
      feedId: input.feedId,
      proxyAddress: feed.standardProxy,
      decimals: feed.decimals,
      roundId: input.roundId,
      answeredInRound: input.roundId,
      answer: input.answer,
      startedAtUnixSeconds: (BigInt(updatedAtUnixSeconds) - 10n).toString(10),
      updatedAtUnixSeconds,
      value: createExactRational(BigInt(input.answer), 100_000_000n),
    },
    readEvidence: {
      observedAt: input.observedAt ?? "2026-07-22T00:00:01.000Z",
      sourceOwner: "user_configured",
      sourceClass: "chain_rpc",
      sourceReference: {
        kind: "configured_rpc",
        sourceId: `rpc:${rpcConfigurationDigest}`,
        publicOrigin: "https://rpc.example",
        configurationDigest: rpcConfigurationDigest,
      },
      block: blockAt(input.blockTimestamp ?? "2026-07-22T00:00:00.000Z"),
    },
  });
};

const ethObservation = observation({
  feedId: "eth_usd",
  roundId: "18446744073709551617",
  answer: "300000000000",
});

const usdgObservation = observation({
  feedId: "usdg_usd",
  roundId: "18446744073709551618",
  answer: "100000000",
});

const compositeRoundId = (
  phaseId: bigint,
  aggregatorRoundId: bigint,
): ReturnType<typeof referenceCompositeRoundIdSchema.parse> =>
  referenceCompositeRoundIdSchema.parse(((phaseId << 64n) | aggregatorRoundId).toString(10));

describe("reference market core contract", () => {
  it("derives one ordered, cutoff-exclusive work plan for continuation and gaps", () => {
    const latest = compositeRoundId(2n, 3n);
    const phaseTwo = observation({
      feedId: "eth_usd",
      roundId: latest,
      answer: "300000000000",
    });
    const phaseOne = observation({
      feedId: "eth_usd",
      roundId: compositeRoundId(1n, 5n),
      answer: "299000000000",
    });
    const continuation = compositeRoundId(1n, 4n);
    const cutoff = compositeRoundId(1n, 2n);
    const phaseOneId = parseReferenceCompositeRoundId(cutoff).phaseId;
    const plan = createReferenceHistoryWorkPlan({
      latestRoundId: phaseTwo.fact.roundId,
      observations: [phaseOne, phaseTwo],
      traversal: referenceFeedTraversalStateSchema.parse({
        backfillPhaseId: phaseOneId,
        backfillNextRoundId: continuation,
        backfillStatus: null,
        retentionCutoffRoundId: cutoff,
      }),
    });

    expect(plan).toEqual({
      segments: [
        {
          kind: "gap",
          firstRoundId: compositeRoundId(2n, 2n),
          stopExclusiveRoundId: null,
        },
        {
          kind: "continuation",
          firstRoundId: continuation,
          stopExclusiveRoundId: null,
        },
      ],
      remainingContinuation: true,
      remainingGap: true,
    });
    expect(plan.segments.every((segment) => BigInt(segment.firstRoundId) > BigInt(cutoff))).toBe(true);
  });

  it("keeps the virtual cutoff endpoint and omits work at or below it", () => {
    const cutoff = compositeRoundId(1n, 100n);
    const phaseOneId = parseReferenceCompositeRoundId(cutoff).phaseId;
    const latest = observation({
      feedId: "eth_usd",
      roundId: compositeRoundId(1n, 103n),
      answer: "300000000000",
    });
    const traversal = referenceFeedTraversalStateSchema.parse({
      backfillPhaseId: phaseOneId,
      backfillNextRoundId: null,
      backfillStatus: "retention_boundary",
      retentionCutoffRoundId: cutoff,
    });
    expect(createReferenceHistoryWorkPlan({
      latestRoundId: latest.fact.roundId,
      observations: [latest],
      traversal,
    })).toEqual({
      segments: [{
        kind: "gap",
        firstRoundId: compositeRoundId(1n, 102n),
        stopExclusiveRoundId: cutoff,
      }],
      remainingContinuation: false,
      remainingGap: true,
    });

    const round102 = observation({
      feedId: "eth_usd",
      roundId: compositeRoundId(1n, 102n),
      answer: "300000000000",
    });
    expect(createReferenceHistoryWorkPlan({
      latestRoundId: latest.fact.roundId,
      observations: [latest, round102],
      traversal,
    })).toEqual({
      segments: [{
        kind: "gap",
        firstRoundId: compositeRoundId(1n, 101n),
        stopExclusiveRoundId: cutoff,
      }],
      remainingContinuation: false,
      remainingGap: true,
    });

    const round101 = observation({
      feedId: "eth_usd",
      roundId: compositeRoundId(1n, 101n),
      answer: "300000000000",
    });
    expect(createReferenceHistoryWorkPlan({
      latestRoundId: latest.fact.roundId,
      observations: [latest, round102, round101],
      traversal,
    })).toEqual({
      segments: [],
      remainingContinuation: false,
      remainingGap: false,
    });
  });

  it("owns one exact composite-round parser for every history boundary", () => {
    const roundId = ((7n << 64n) | 19n).toString(10);
    expect(parseReferenceCompositeRoundId(roundId)).toEqual({
      roundId,
      phaseId: "7",
      aggregatorRoundId: "19",
    });
    expect(() => parseReferenceCompositeRoundId("1")).toThrow();
    expect(() => parseReferenceCompositeRoundId((1n << 64n).toString(10))).toThrow();
    expect(() => parseReferenceCompositeRoundId((1n << 80n).toString(10))).toThrow();
    expect(() => parseReferenceCompositeRoundId(`0${roundId}`)).toThrow();
  });

  it("fixes exact feed and pair identities instead of accepting same-shaped substitutions", () => {
    expect(referencePairIds).toEqual([ethUsdPairId, usdgUsdPairId, ethUsdgPairId]);

    const changedProxy = structuredClone(referenceMarketManifest) as unknown as {
      feeds: Array<Record<string, unknown>>;
    };
    changedProxy.feeds[0]!["standardProxy"] = "0x0000000000000000000000000000000000000001";
    expect(referenceMarketManifestSchema.safeParse(changedProxy).success).toBe(false);

    const changedPresentation = structuredClone(referenceMarketManifest) as unknown as {
      pairs: Array<Record<string, unknown>>;
    };
    changedPresentation.pairs[0]!["label"] = "ETH/USDG";
    changedPresentation.pairs[0]!["starter"] = false;
    expect(referenceMarketManifestSchema.safeParse(changedPresentation).success).toBe(false);

    const reordered = structuredClone(referenceMarketManifest) as unknown as {
      pairs: Array<Record<string, unknown>>;
    };
    [reordered.pairs[0], reordered.pairs[1]] = [reordered.pairs[1]!, reordered.pairs[0]!];
    expect(referenceMarketManifestSchema.safeParse(reordered).success).toBe(false);
    expect(referenceMarketMappingEvidenceSchema.parse(mappingEvidence)).toEqual(mappingEvidence);
    expect(referenceMarketMappingEvidenceSchema.safeParse({
      ...mappingEvidence,
      sourceOwner: "Unknown",
    }).success).toBe(false);
  });

  it("keeps exact rational components reduced, positive, and bounded", () => {
    expect(createExactRational(6n, 8n)).toEqual({ numerator: "3", denominator: "4" });
    expect(exactRationalSchema.safeParse({ numerator: "6", denominator: "8" }).success).toBe(false);
    expect(exactRationalSchema.safeParse({ numerator: "1".repeat(97), denominator: "1" }).success)
      .toBe(false);
  });

  it("separates immutable round facts from actual configured-RPC read evidence", () => {
    expect(referenceRoundObservationSchema.parse(ethObservation)).toEqual(ethObservation);
    expect(referenceRoundObservationSchema.safeParse({
      ...ethObservation,
      fact: { ...ethObservation.fact, value: { numerator: "2999", denominator: "1" } },
    }).success).toBe(false);
    const laterRead = referenceRoundObservationSchema.parse({
      ...ethObservation,
      readEvidence: {
        ...ethObservation.readEvidence,
        observedAt: "2026-07-22T00:00:02.000Z",
      },
    });
    expect(laterRead.fact).toEqual(ethObservation.fact);
    expect(laterRead.readEvidence.observedAt).not.toBe(ethObservation.fact.updatedAtUnixSeconds);
    expect(referenceRoundObservationSchema.safeParse({
      ...ethObservation,
      readEvidence: {
        ...ethObservation.readEvidence,
        block: blockAt("2026-07-20T23:59:59.000Z"),
      },
    }).success).toBe(false);
    expect(referenceRoundObservationSchema.safeParse({
      ...ethObservation,
      fact: { ...ethObservation.fact, answer: (1n << 255n).toString(10) },
    }).success).toBe(false);
    expect(referenceRoundObservationSchema.safeParse({
      ...ethObservation,
      readEvidence: {
        ...ethObservation.readEvidence,
        sourceReference: { kind: "public", sourceId: "forged", uri: "https://rpc.example/" },
      },
    }).success).toBe(false);
  });

  it("derives current and stale results from their exact sources at the heartbeat boundary", () => {
    const pair = referenceMarketManifest.pairs[2]!;
    expect(deriveReferencePairValue(pair, [ethObservation, usdgObservation])).toEqual({
      numerator: "3000",
      denominator: "1",
    });

    const current = {
      status: "current",
      pair,
      block: blockAt("2026-07-22T00:00:00.000Z"),
      mappingEvidence,
      sources: [ethObservation, usdgObservation],
      warnings: referencePriceWarnings,
      currentPrice: { numerator: "3000", denominator: "1" },
    };
    expect(referencePriceSuccessSchema.safeParse(current).success).toBe(true);
    expect(referencePriceSuccessSchema.safeParse({
      ...current,
      currentPrice: { numerator: "3001", denominator: "1" },
    }).success).toBe(false);
    const agedBlock = blockAt("2026-07-22T00:00:01.000Z");
    const agedSources = [ethObservation, usdgObservation].map((source) =>
      referenceRoundObservationSchema.parse({
        ...source,
        readEvidence: { ...source.readEvidence, block: agedBlock },
      }));
    const { currentPrice, ...currentWithoutPrice } = current;
    expect(referencePriceSuccessSchema.safeParse({
      ...currentWithoutPrice,
      status: "unavailable",
      block: agedBlock,
      sources: agedSources,
      reason: "derived_sources_not_fresh",
    }).success).toBe(true);
    expect(referencePriceSuccessSchema.safeParse({
      ...currentWithoutPrice,
      status: "stale",
      block: agedBlock,
      sources: agedSources,
      lastObserved: currentPrice,
    }).success).toBe(false);
    expect(referencePriceSuccessSchema.safeParse({
      ...currentWithoutPrice,
      status: "unavailable",
      block: agedBlock,
      sources: agedSources,
      reason: "derived_sources_not_fresh",
      lastObserved: currentPrice,
    }).success).toBe(false);
    expect(referencePriceSuccessSchema.safeParse({
      status: "stale",
      pair: referenceMarketManifest.pairs[0],
      block: agedBlock,
      mappingEvidence,
      sources: [agedSources[0]],
      warnings: referencePriceWarnings,
      lastObserved: { numerator: "3000", denominator: "1" },
    }).success).toBe(true);
    expect(referencePriceSuccessSchema.safeParse({
      ...current,
      mappingEvidence: { ...mappingEvidence, sourceOwner: "Unknown" },
    }).success).toBe(false);
    expect(referencePriceSuccessSchema.safeParse({
      ...current,
      warnings: [...referencePriceWarnings].reverse(),
    }).success).toBe(false);
  });

  it("binds history coverage and every OHLC point to the selected pair sources", () => {
    const historyEth = observation({
      feedId: "eth_usd",
      roundId: "18446744073709551619",
      answer: "300000000000",
      updatedAtUnixSeconds: "1784677800",
    });
    const historyUsdg = observation({
      feedId: "usdg_usd",
      roundId: "18446744073709551620",
      answer: "100000000",
      updatedAtUnixSeconds: "1784677800",
    });
    const candleSourcePointers = [historyEth, historyUsdg].map((source) => ({
      feedId: source.fact.feedId,
      roundId: source.fact.roundId,
    }));
    const candle = {
      openedAt: "2026-07-21T23:45:00.000Z",
      closedAt: "2026-07-22T00:00:00.000Z",
      openBucket: false,
      open: { numerator: "3000", denominator: "1" },
      high: { numerator: "3000", denominator: "1" },
      low: { numerator: "3000", denominator: "1" },
      close: { numerator: "3000", denominator: "1" },
      openSourcePointers: candleSourcePointers,
      openSourceSkewSeconds: "0",
      highSourcePointers: candleSourcePointers,
      highSourceSkewSeconds: "0",
      lowSourcePointers: candleSourcePointers,
      lowSourceSkewSeconds: "0",
      closeSourcePointers: candleSourcePointers,
      closeSourceSkewSeconds: "0",
    };
    const partial = {
      status: "partial",
      pair: referenceMarketManifest.pairs[2],
      window: "1d",
      block: blockAt("2026-07-22T00:00:00.000Z"),
      mappingEvidence,
      coverage: {
        basis: "observed_rounds",
        requestedStart: "2026-07-21T00:00:00.000Z",
        requestedEnd: "2026-07-22T00:00:00.000Z",
        emptyBucketStarts: Array.from({ length: 95 }, (_, index) =>
          new Date(Date.parse("2026-07-21T00:00:00.000Z") + index * 15 * 60 * 1_000).toISOString()),
        limitations: ["source_history_not_exhaustive"],
      },
      candles: [candle],
      sourceObservations: [historyEth, historyUsdg],
      warnings: [...referenceHistoryWarnings, "partial_history"],
    };
    expect(referenceHistorySuccessSchema.safeParse(partial).success).toBe(true);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      status: "complete",
      coverage: {
        ...partial.coverage,
        status: "complete",
      },
      warnings: referenceHistoryWarnings,
    }).success).toBe(false);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      coverage: {
        ...partial.coverage,
        availableStart: partial.coverage.requestedStart,
        availableEnd: partial.coverage.requestedEnd,
        missingBucketStarts: [],
      },
    }).success).toBe(false);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      candles: [{ ...candle, openBucket: true }],
    }).success).toBe(false);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      candles: [{ ...candle, closeSourcePointers: candleSourcePointers.slice(0, 1) }],
    }).success).toBe(false);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      candles: [{
        ...candle,
        closeSourcePointers: [
          candleSourcePointers[0],
          { ...candleSourcePointers[1], roundId: "18446744073709551621" },
        ],
      }],
    }).success).toBe(false);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      sourceObservations: [historyEth, historyUsdg, historyEth],
    }).success).toBe(false);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      sourceObservations: [historyUsdg, historyEth],
    }).success).toBe(false);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      candles: [{
        ...candle,
        closeSourcePointers: [
          { ...candleSourcePointers[0], feedId: "usdg_usd" },
          { ...candleSourcePointers[1], feedId: "eth_usd" },
        ],
      }],
    }).success).toBe(false);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      sourceObservations: [historyEth, historyUsdg, observation({
        feedId: "eth_usd",
        roundId: "18446744073709551621",
        answer: "300000000000",
        updatedAtUnixSeconds: "1784677700",
      })],
    }).success).toBe(false);
    expect(referenceHistorySuccessSchema.safeParse({
      ...partial,
      warnings: referenceHistoryWarnings,
    }).success).toBe(false);
  });

  it("accepts only canonical revisions and exact supported watchlist entries", () => {
    expect(referenceWatchlistRevisionSchema.parse(initialReferenceWatchlistRevision))
      .toBe(initialReferenceWatchlistRevision);
    expect(referenceWatchlistRevisionSchema.safeParse("AAAAAAAAAAAAAAAAAAAAAB").success).toBe(false);
    expect(referenceWatchlistSuccessSchema.safeParse({
      account: {
        chainId: "eip155:4663",
        address: "0x0000000000000000000000000000000000000001",
      },
      revision: initialReferenceWatchlistRevision,
      entries: [referenceMarketManifest.pairs[0]],
    }).success).toBe(true);

    const altered = structuredClone(referenceMarketManifest.pairs[0]!) as unknown as Record<string, unknown>;
    altered["starter"] = false;
    expect(referenceWatchlistSuccessSchema.safeParse({
      account: {
        chainId: "eip155:4663",
        address: "0x0000000000000000000000000000000000000001",
      },
      revision: initialReferenceWatchlistRevision,
      entries: [altered],
    }).success).toBe(false);
    expect(referenceWatchlistReorderInputSchema.safeParse({
      pairIds: [`0x${"ff".repeat(32)}`],
      expectedRevision: initialReferenceWatchlistRevision,
    }).success).toBe(false);
  });
});
