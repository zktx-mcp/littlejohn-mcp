// @vitest-environment jsdom

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
import { referenceMarketApplicationContracts } from
  "../../../src/market-portfolio/contracts.js";
import { presentationContractRegistry } from
  "../../../src/interfaces/mcp-app/registry.js";
import { renderPresentation } from
  "../../../src/interfaces/mcp-app/view/renderers.js";

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
    limitations: ["source_history_not_exhaustive"],
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

describe("MCP App typed read renderers", () => {
  it("renders admitted fixed history as one accessible exact-value projection", () => {
    const entry = presentationContractRegistry.forContract(
      referenceMarketApplicationContracts.history,
    );
    if (entry === undefined) throw new TypeError("History presentation is not registered.");
    const admitted = entry.parseResult(
      entry.parseInput({ pairId: pair.pairId, window: "1d" }),
      history,
    );
    const card = renderPresentation(entry, admitted);

    expect(card.tagName).toBe("ARTICLE");
    expect(card.querySelector("h1")?.textContent).toBe("Reference price history");
    expect(card.querySelector('svg[role="img"]')?.getAttribute("aria-label"))
      .toContain("1 fixed candles");
    expect(card.querySelector("table caption")?.textContent).toBe("Exact candle values");
    expect([...card.querySelectorAll("tbody td")].map((cell) => cell.textContent))
      .toContain(`${observation.fact.value.numerator} / ${observation.fact.value.denominator}`);
    expect(card.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
    expect(card.textContent).toContain("Partial history");
    expect(card.textContent).toContain("The source history is not exhaustive.");
    expect(card.textContent).toContain("This reference price is not a trade or executable quote.");
    expect(card.querySelector("details, pre")).toBeNull();
    expect(card.textContent).not.toContain("source_history_not_exhaustive");
  });
});
