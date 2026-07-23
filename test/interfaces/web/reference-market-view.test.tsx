import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  chainAnchorSchema,
  createExactRational,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referenceHistorySuccessSchema,
  referenceHistoryWarnings,
  referencePriceSuccessSchema,
  referencePriceWarnings,
  referenceRoundObservationSchema,
} from "../../../src/core/browser.js";
import {
  ReferenceMarketPriceEvidence,
  ReferenceMarketHistoryPanel,
  ReferenceMarketView,
} from "../../../src/interfaces/web/reference-market-view.js";

const pair = referenceMarketManifest.pairs[0]!;
const feed = referenceMarketManifest.feeds[0]!;
const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-22T00:07:00.000Z",
});
const observationTime = "2026-07-22T00:02:00.000Z";
const observationSeconds = String(Date.parse(observationTime) / 1_000);
const rpcConfigurationDigest = "A".repeat(43);
const observation = referenceRoundObservationSchema.parse({
  fact: {
    manifestVersion: 1,
    feedId: feed.feedId,
    proxyAddress: feed.standardProxy,
    decimals: 8,
    roundId: String((1n << 64n) | 1n),
    answeredInRound: String((1n << 64n) | 1n),
    answer: "193384405462",
    startedAtUnixSeconds: observationSeconds,
    updatedAtUnixSeconds: observationSeconds,
    value: createExactRational(193384405462n, 100000000n),
  },
  readEvidence: {
    observedAt: "2026-07-22T00:07:01.000Z",
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
const requestedStart = "2026-07-21T00:07:00.000Z";
const firstBucket = Date.parse("2026-07-21T00:15:00.000Z");
const finalBucket = Date.parse("2026-07-22T00:00:00.000Z");
const bucketMilliseconds = 15 * 60 * 1_000;
const emptyBucketStarts = Object.freeze(Array.from(
  { length: (finalBucket - firstBucket) / bucketMilliseconds },
  (_, index) => new Date(firstBucket + index * bucketMilliseconds).toISOString(),
));
const sourcePointers = Object.freeze([{
  feedId: observation.fact.feedId,
  roundId: observation.fact.roundId,
}]);
const history = referenceHistorySuccessSchema.parse({
  status: "partial",
  pair,
  window: "1d",
  block,
  mappingEvidence: referenceMarketMappingEvidence,
  coverage: {
    basis: "observed_rounds",
    requestedStart,
    requestedEnd: block.blockTimestamp,
    emptyBucketStarts,
    limitations: ["source_history_not_exhaustive", "phase_boundary"],
  },
  candles: [{
    openedAt: new Date(finalBucket).toISOString(),
    closedAt: block.blockTimestamp,
    openBucket: true,
    open: observation.fact.value,
    high: observation.fact.value,
    low: observation.fact.value,
    close: observation.fact.value,
    openSourcePointers: sourcePointers,
    openSourceSkewSeconds: "0",
    highSourcePointers: sourcePointers,
    highSourceSkewSeconds: "0",
    lowSourcePointers: sourcePointers,
    lowSourceSkewSeconds: "0",
    closeSourcePointers: sourcePointers,
    closeSourceSkewSeconds: "0",
  }],
  sourceObservations: [observation],
  warnings: [...referenceHistoryWarnings, "partial_history"],
});

describe("reference-market browser presentation", () => {
  it("keeps the canonical history, coverage, mapping, and round evidence accessible beside the chart", () => {
    const markup = renderToStaticMarkup(createElement(ReferenceMarketHistoryPanel, {
      selected: pair,
      state: { status: "available", value: history },
    }));
    expect(markup).toContain("reference-price visual projection");
    expect(markup).toContain("latest exact candle values");
    for (const label of ["Open", "High", "Low", "Close"]) {
      expect(markup).toContain(`<dt>${label}</dt><dd>96692202731/50000000</dd>`);
    }
    expect(markup).toContain("no_trade_volume");
    expect(markup).toContain("partial_history");
    expect(markup).toContain("eip155:4663");
    expect(markup).toContain(`0x${"ab".repeat(32)}`);
    expect(markup).toContain("https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood");
    expect(markup).toContain("two_named_robinhood_chain_standard_proxy_mappings");
    expect(markup).toContain("configured_rpc");
    expect(markup).toContain(`rpc:${"A".repeat(43)}`);
    expect(markup).toContain(observationSeconds);
    expect(markup).toContain("2026-07-22T00:07:01.000Z");
    expect(markup).toContain("2026-07-21T00:15:00.000Z");
    expect(markup).not.toContain("<dt>Volume</dt>");
  });

  it("keeps price status, reason-capable evidence, source reference, and warnings exact", () => {
    const staleBlock = chainAnchorSchema.parse({
      ...block,
      blockTimestamp: "2026-07-24T00:07:00.000Z",
    });
    const staleObservation = referenceRoundObservationSchema.parse({
      ...observation,
      readEvidence: { ...observation.readEvidence, block: staleBlock },
    });
    const stale = referencePriceSuccessSchema.parse({
      status: "stale",
      pair,
      block: staleBlock,
      mappingEvidence: referenceMarketMappingEvidence,
      sources: [staleObservation],
      lastObserved: staleObservation.fact.value,
      warnings: referencePriceWarnings,
    });
    const markup = renderToStaticMarkup(createElement(ReferenceMarketPriceEvidence, { pair, price: stale }));
    expect(markup).toContain(">stale<");
    expect(markup).toContain(staleObservation.readEvidence.observedAt);
    expect(markup).toContain("source_listing_not_revalidated");
    expect(markup).toContain("configured_rpc");
    expect(markup).toContain("https://rpc.example");
    expect(markup).toContain("not_revalidated_at_runtime");
    expect(markup).toContain("· stale");
    const quoteFeed = referenceMarketManifest.feeds[1]!;
    const quoteObservation = referenceRoundObservationSchema.parse({
      ...staleObservation,
      fact: {
        ...staleObservation.fact,
        feedId: quoteFeed.feedId,
        proxyAddress: quoteFeed.standardProxy,
      },
    });
    const unavailable = referencePriceSuccessSchema.parse({
      status: "unavailable",
      reason: "derived_sources_not_fresh",
      pair: referenceMarketManifest.pairs[2]!,
      block: staleBlock,
      mappingEvidence: referenceMarketMappingEvidence,
      sources: [staleObservation, quoteObservation],
      warnings: referencePriceWarnings,
    });
    const unavailableMarkup = renderToStaticMarkup(createElement(ReferenceMarketPriceEvidence, {
      pair: referenceMarketManifest.pairs[2]!,
      price: unavailable,
    }));
    expect(unavailableMarkup).toContain("Reason: derived_sources_not_fresh");
  });

  it("shows an unavailable history reason without dropping its block, mapping, coverage, or warnings", () => {
    const unavailable = referenceHistorySuccessSchema.parse({
      status: "unavailable",
      reason: "no_valid_observation",
      pair,
      window: "1d",
      block,
      mappingEvidence: referenceMarketMappingEvidence,
      coverage: {
        basis: "observed_rounds",
        requestedStart,
        requestedEnd: block.blockTimestamp,
        emptyBucketStarts: [...emptyBucketStarts, new Date(finalBucket).toISOString()],
        limitations: ["source_history_not_exhaustive", "phase_boundary"],
      },
      candles: [],
      sourceObservations: [],
      warnings: referenceHistoryWarnings,
    });
    const markup = renderToStaticMarkup(createElement(ReferenceMarketHistoryPanel, {
      selected: pair,
      state: { status: "available", value: unavailable },
    }));
    expect(markup).toContain("Reason: no_valid_observation");
    expect(markup).toContain("Coverage basis");
    expect(markup).toContain("observed_rounds");
    expect(markup).toContain("Mapping evidence");
    expect(markup).toContain("Block number");
    expect(markup).toContain("reference_price_not_trade_price");
  });

  it("exposes public reference reads before wallet connection without presenting saved state", () => {
    const markup = renderToStaticMarkup(createElement(ReferenceMarketView, {
      walletConnected: false,
      csrfToken: () => { throw new Error("A disconnected initial render must not request CSRF authority."); },
    }));
    expect(markup).toContain("Reference markets");
    expect(markup).toContain("Reference prices are evidence");
    expect(markup).toContain("Loading reference history");
    expect(markup).not.toContain("Add ETH/USD");
  });
});
