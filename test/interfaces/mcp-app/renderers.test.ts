// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  captureCanonicalJson,
  chainAnchorSchema,
  createExactRational,
  referenceHistorySuccessSchema,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referenceMarketWarningsFor,
  referenceRoundObservationSchema,
} from "../../../src/core/client.js";
import { referenceMarketApplicationContracts } from
  "../../../src/market-portfolio/contracts.js";
import { presentationContractRegistry, presentationContracts } from
  "../../../src/interfaces/mcp-app/registry.js";
import { renderOperation, renderPresentation } from
  "../../../src/interfaces/mcp-app/view/renderers.js";
import {
  stockTokenMarketAvailableFixture,
  stockTokenMarketExecutionUnavailableFixture,
  stockTokenMarketUnmappedFixture,
} from "../stock-token-market-fixture.js";

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
  warnings: referenceMarketWarningsFor({ result: "history", historyStatus: "partial" }),
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
      .toContain("1 exact candles");
    expect(card.querySelector('svg[role="img"]')?.getAttribute("aria-label"))
      .toContain("absent intervals are not filled");
    expect(card.querySelectorAll(".candle-mark")).toHaveLength(history.candles.length);
    expect(card.querySelectorAll(".candle-point")).toHaveLength(1);
    expect(card.querySelector("path, polyline")).toBeNull();
    expect(card.querySelector(".chart-time-range")?.textContent)
      .toContain(history.coverage.requestedStart);
    expect(card.querySelector(".chart-time-range")?.textContent)
      .toContain(history.coverage.requestedEnd);
    const exactValues = card.querySelector("details");
    expect(card.querySelector("table")).toBeNull();
    if (exactValues === null) throw new TypeError("Exact-value disclosure is unavailable.");
    exactValues.open = true;
    exactValues.dispatchEvent(new Event("toggle"));
    expect(card.querySelector("table caption")?.textContent).toBe("Exact candle values");
    expect([...card.querySelectorAll("tbody td")].map((cell) => cell.textContent))
      .toContain(`${observation.fact.value.numerator} / ${observation.fact.value.denominator}`);
    expect(card.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
    expect(card.querySelector(".operation-region")).toBeNull();
    expect(card.textContent).toContain("Partial history");
    expect(card.textContent).toContain("The source history is not exhaustive.");
    expect(card.textContent).toContain(
      "The value is a reference value, not an executable quote, trade, fill, or recommendation.",
    );
    expect(exactValues.open).toBe(true);
    expect(card.querySelector("pre")).toBeNull();
    expect(card.textContent).not.toContain("source_history_not_exhaustive");
  });

  it("renders mapped and unmapped Stock Token results through one typed exact-value view", () => {
    const entry = presentationContracts.stockTokenMarket;
    const input = entry.parseInput({ symbol: "AAPL", window: "1d" });
    const availableValue = stockTokenMarketAvailableFixture();
    if (availableValue.status !== "available") {
      throw new TypeError("The mapped fixture is unavailable.");
    }
    const admitted = entry.parseResult(input, availableValue);
    const card = renderPresentation(entry, admitted);

    expect(card.querySelector("h1")?.textContent).toBe("Stock Token market");
    expect(card.textContent).toContain("Apple • Robinhood Token · AAPL");
    expect(card.textContent).toContain("925 / 4");
    expect(card.textContent).toContain("2026-08-12T13:30:00.000Z");
    expect(card.textContent).toContain("Reference value (USD)");
    expect(card.textContent).toContain("Executed trades in USDG");
    expect(card.textContent).toContain("Latest exact close927 / 4 USDG");
    expect(card.textContent).toContain("Chainlink reference history in USD");
    const chartLabels = [...card.querySelectorAll('svg[role="img"]')]
      .map((chart) => chart.getAttribute("aria-label"));
    expect(chartLabels).toEqual([
      expect.stringContaining("Apple • Robinhood Token executed trades in USDG"),
      expect.stringContaining("Apple • Robinhood Token Chainlink reference history in USD"),
    ]);
    const executionCandles = availableValue.execution.status === "available"
      ? availableValue.execution.candles
      : [];
    expect(card.querySelectorAll(".candle-mark")).toHaveLength(
      executionCandles.length + availableValue.history.candles.length,
    );
    expect(card.querySelector("path, polyline")).toBeNull();
    for (const figure of card.querySelectorAll("figure")) {
      const frame = figure.querySelector(".chart-frame");
      const plotLeft = Number(frame?.getAttribute("x"));
      const plotWidth = Number(frame?.getAttribute("width"));
      const [requestedStart, requestedEnd] = [...figure.querySelectorAll(".chart-time-range span")]
        .map((node) => Date.parse(node.textContent ?? ""));
      for (const mark of figure.querySelectorAll(".candle-mark")) {
        const openedAt = Date.parse(mark.getAttribute("data-opened-at") ?? "");
        const closedAt = Date.parse(mark.getAttribute("data-closed-at") ?? "");
        const expectedRatio = ((openedAt + closedAt) / 2 - requestedStart!) /
          (requestedEnd! - requestedStart!);
        const actualRatio = (Number(mark.getAttribute("data-chart-x")) - plotLeft) / plotWidth;
        expect(actualRatio).toBeCloseTo(expectedRatio, 10);
      }
    }
    expect([...card.querySelectorAll(".chart-caption")].every((caption) =>
      !caption.textContent?.includes("empty intervals"))).toBe(true);
    expect([...card.querySelectorAll("details")].map((details) =>
      details.querySelector("summary")?.textContent)).toEqual([
      "Exact executed-trade candles",
      "Exact reference candles",
      "Data limitations",
    ]);
    expect([...card.querySelectorAll("details")].every((details) => !details.open)).toBe(true);
    expect(card.textContent).toContain(
      "Reference-round candles contain no trade-volume observation.",
    );
    expect(card.textContent).toContain(
      "Round traversal cannot prove that the provider published no additional rounds.",
    );
    expect(card.textContent).not.toContain("source_history_not_exhaustive");
    expect(card.querySelectorAll("button, input, select, textarea")).toHaveLength(0);

    const unavailableValue = stockTokenMarketUnmappedFixture();
    if (!("officialAsset" in unavailableValue)) {
      throw new TypeError("The unmapped fixture omitted its official asset.");
    }
    const unavailableInput = entry.parseInput({ symbol: "P", window: "1d" });
    const unavailable = renderPresentation(
      entry,
      entry.parseResult(unavailableInput, unavailableValue),
    );
    expect(unavailable.textContent).toContain("Stock TokenP");
    expect(unavailable.textContent).toContain(`Name${unavailableValue.officialAsset.member.sourceName}`);
    expect(unavailable.textContent).toContain(
      unavailableValue.officialAsset.member.contractAddress,
    );
    expect(unavailable.textContent).toContain(
      "The admitted catalog has no reference feed for this Stock Token.",
    );
    expect(unavailable.querySelector("svg, table")).toBeNull();
  });

  it("preserves the admitted reference result when execution history is unavailable", () => {
    const entry = presentationContracts.stockTokenMarket;
    const value = stockTokenMarketExecutionUnavailableFixture();
    const card = renderPresentation(
      entry,
      entry.parseResult(entry.parseInput({ symbol: "AAPL", window: "1d" }), value),
    );

    expect(card.textContent).toContain("Reference value (USD)925 / 4");
    expect(card.textContent).toContain("Executed trades in USDGStatusUnavailable");
    expect(card.textContent).toContain("Executed-trade history is temporarily unavailable.");
    expect(card.querySelectorAll('svg[role="img"]')).toHaveLength(1);
    expect(card.querySelector('svg[role="img"]')?.getAttribute("aria-label"))
      .toContain("Chainlink reference history in USD");
  });

  it("uses the closed presentation registry as the only View-process classifier", () => {
    const reviews = presentationContractRegistry.values()
      .filter((entry) => entry.presentationKind === "review");
    const operations = presentationContractRegistry.values()
      .filter((entry) => entry.presentationKind === "operation");

    expect(reviews).toEqual([
      presentationContracts.referenceWatchlistReview,
      presentationContracts.tokenSelectionReview,
      presentationContracts.walletReview,
    ]);
    expect(operations).toEqual([
      presentationContracts.referenceWatchlistOperation,
      presentationContracts.tokenSelectionOperation,
      presentationContracts.walletOperation,
    ]);
    expect(() => renderPresentation(
      presentationContracts.walletOperation,
      captureCanonicalJson({}),
    )).toThrow("operation cannot create a top-level presentation");
    expect(() => renderOperation(
      presentationContracts.referenceHistory,
      captureCanonicalJson({}),
    )).toThrow("not an operation");
  });
});
