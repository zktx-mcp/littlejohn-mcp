import { describe, expect, it } from "vitest";

import {
  chainAnchorSchema,
  createExactRational,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referencePriceWarnings,
  referencePriceSuccessSchema,
  referenceRoundObservationSchema,
} from "../../../src/core/browser.js";
import {
  presentReferencePrice,
} from "../../../src/interfaces/web/reference-price-presentation.js";

const pair = referenceMarketManifest.pairs[0]!;
const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-22T00:07:00.000Z",
});
const currentValue = createExactRational(187224n, 100n);
const staleValue = createExactRational(186932n, 100n);
const feed = referenceMarketManifest.feeds[0]!;
const configuredRpcDigest = "A".repeat(43);
const currentObservation = referenceRoundObservationSchema.parse({
  fact: {
    manifestVersion: 1,
    feedId: feed.feedId,
    proxyAddress: feed.standardProxy,
    decimals: 8,
    roundId: String((1n << 64n) | 1n),
    answeredInRound: String((1n << 64n) | 1n),
    answer: "187224000000",
    startedAtUnixSeconds: "1784678520",
    updatedAtUnixSeconds: "1784678520",
    value: currentValue,
  },
  readEvidence: {
    observedAt: "2026-07-22T00:07:01.000Z",
    sourceOwner: "user_configured",
    sourceClass: "chain_rpc",
    sourceReference: {
      kind: "configured_rpc",
      sourceId: `rpc:${configuredRpcDigest}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: configuredRpcDigest,
    },
    block,
  },
});
const staleBlock = chainAnchorSchema.parse({
  ...block,
  blockTimestamp: "2026-07-24T00:07:00.000Z",
});
const staleObservation = referenceRoundObservationSchema.parse({
  ...currentObservation,
  fact: {
    ...currentObservation.fact,
    answer: "186932000000",
    value: staleValue,
  },
  readEvidence: {
    ...currentObservation.readEvidence,
    block: staleBlock,
  },
});
const quoteFeed = referenceMarketManifest.feeds[1]!;
const staleQuoteObservation = referenceRoundObservationSchema.parse({
  ...staleObservation,
  fact: {
    ...staleObservation.fact,
    feedId: quoteFeed.feedId,
    proxyAddress: quoteFeed.standardProxy,
  },
});

describe("shared browser presentation owners", () => {
  it("projects current, stale, and unavailable reference prices without changing their exact values", () => {
    const current = presentReferencePrice(referencePriceSuccessSchema.parse({
      status: "current",
      pair,
      block,
      mappingEvidence: referenceMarketMappingEvidence,
      sources: [currentObservation],
      currentPrice: currentValue,
      warnings: referencePriceWarnings,
    }));
    const stale = presentReferencePrice(referencePriceSuccessSchema.parse({
      status: "stale",
      pair,
      block: staleBlock,
      mappingEvidence: referenceMarketMappingEvidence,
      sources: [staleObservation],
      lastObserved: staleValue,
      warnings: referencePriceWarnings,
    }));
    const unavailable = presentReferencePrice(referencePriceSuccessSchema.parse({
      status: "unavailable",
      reason: "derived_sources_not_fresh",
      pair: referenceMarketManifest.pairs[2]!,
      block: staleBlock,
      mappingEvidence: referenceMarketMappingEvidence,
      sources: [staleObservation, staleQuoteObservation],
      warnings: referencePriceWarnings,
    }));

    expect(current).toEqual({
      status: "available",
      tone: "current",
      value: currentValue,
      unit: { code: "USD", prefix: "$", suffix: "" },
    });
    expect(stale).toEqual({
      status: "available",
      tone: "stale",
      value: staleValue,
      unit: { code: "USD", prefix: "$", suffix: "" },
    });
    expect(unavailable).toEqual({
      status: "unavailable",
      tone: "unavailable",
      unit: { code: "USDG", prefix: "", suffix: " USDG" },
    });
  });
});
