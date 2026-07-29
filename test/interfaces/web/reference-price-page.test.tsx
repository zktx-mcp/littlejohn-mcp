import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  chainAnchorSchema,
  createExactRational,
  referenceHistorySuccessSchema,
  referenceHistoryWarnings,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referenceRoundObservationSchema,
} from "../../../src/core/browser.js";
import { browserLocations } from "../../../src/interfaces/browser-contract.js";
import { ReferenceMarketChart } from "../../../src/interfaces/web/reference-market-chart.js";
import { ReferencePricePage } from "../../../src/interfaces/web/reference-price-page.js";
import type { ReferenceChartPort } from "../../../src/interfaces/web/reference-chart.js";

const unavailableChart: ReferenceChartPort = Object.freeze({
  mount: async () => Object.freeze({ status: "unavailable" }),
});

const pair = referenceMarketManifest.pairs[0]!;
const feed = referenceMarketManifest.feeds[0]!;
const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-22T00:07:00.000Z",
});
const observationTime = "2026-07-22T00:02:00.000Z";
const observation = referenceRoundObservationSchema.parse({
  fact: {
    manifestVersion: 1,
    feedId: feed.feedId,
    proxyAddress: feed.standardProxy,
    decimals: 8,
    roundId: String((1n << 64n) | 1n),
    answeredInRound: String((1n << 64n) | 1n),
    answer: "193384405462",
    startedAtUnixSeconds: String(Date.parse(observationTime) / 1_000),
    updatedAtUnixSeconds: String(Date.parse(observationTime) / 1_000),
    value: createExactRational(193384405462n, 100000000n),
  },
  readEvidence: {
    observedAt: "2026-07-22T00:07:01.000Z",
    sourceOwner: "user_configured",
    sourceClass: "chain_rpc",
    sourceReference: {
      kind: "configured_rpc",
      sourceId: `rpc:${"A".repeat(43)}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: "A".repeat(43),
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
const pointers = Object.freeze([{
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
    openSourcePointers: pointers,
    openSourceSkewSeconds: "0",
    highSourcePointers: pointers,
    highSourceSkewSeconds: "0",
    lowSourcePointers: pointers,
    lowSourceSkewSeconds: "0",
    closeSourcePointers: pointers,
    closeSourceSkewSeconds: "0",
  }],
  sourceObservations: [observation],
  warnings: [...referenceHistoryWarnings, "partial_history"],
});

describe("reference price browser presentation", () => {
  it("keeps complete history and source diagnostics out of the human browser", () => {
    const markup = renderToStaticMarkup(createElement(ReferenceMarketChart, {
      chartPort: unavailableChart,
      selectedPair: pair,
      historyState: { status: "available", value: history },
    }));

    expect(markup).toContain("One reference value is available");
    expect(markup).toContain("Observed range");
    expect(markup).toContain("1 of 96 chart intervals");
    expect(markup).toContain("The values in this interval are equal");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(
      'aria-describedby="reference-chart-summary reference-chart-legend reference-chart-instructions"',
    );
    expect(markup).not.toContain("Previous candle");
    expect(markup).not.toContain("Next candle");
    expect(markup).not.toContain("View price history as a table");
    expect(markup).not.toContain("Bucket interval");
    expect(markup).not.toContain("Exact OHLC");
    expect(markup).not.toContain("96692202731/50000000");
    expect(markup).not.toContain("2026-07-21 00:15:00 UTC");
    expect(markup).not.toContain("Source evidence");
    expect(markup).not.toContain("Source skew");
    expect(markup).not.toContain(observation.fact.roundId);
    expect(markup).not.toContain(observation.readEvidence.sourceReference.sourceId);
    expect(markup).not.toContain(block.blockHash);
    expect(markup).not.toContain("<svg");
  });

  it("renders the selected pair resource independently from the Prices list", () => {
    const markup = renderToStaticMarkup(createElement(ReferencePricePage, {
      chartPort: unavailableChart,
      pageLocation: browserLocations.referencePrice(pair.pairId, "1d"),
      onNavigate: () => undefined,
      onAnalyze: () => undefined,
    }));
    expect(markup).toContain(`>${pair.label}<`);
    expect(markup).toContain('href="/prices"');
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain(">Prices</a>");
    expect(markup).toContain("Current reference value and bounded price history");
    expect(markup).toContain("Price history");
    expect(markup).toContain("Loading reference history");
    expect(markup).not.toContain("History coverage");
    expect(markup).not.toContain("Evidence");
    expect(markup).not.toContain("Save");
  });
});
