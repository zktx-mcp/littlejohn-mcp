// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { presentationContractRegistry, presentationContracts } from
  "../../../src/interfaces/mcp-app/registry.js";
import { renderOperation, renderPresentation } from
  "../../../src/interfaces/mcp-app/view/renderers.js";
import {
  stockTokenTradeHistoryAvailableFixture,
  stockTokenTradeHistoryUnavailableFixture,
} from "../stock-token-trade-history-fixture.js";
import { createTokenOperation } from "../../token-catalog/harness.js";

const fields = (list: Element | null): ReadonlyMap<string, string> => {
  if (!(list instanceof HTMLDListElement)) throw new TypeError("Summary is unavailable.");
  const labels = [...list.querySelectorAll("dt")];
  const values = [...list.querySelectorAll("dd")];
  return new Map(labels.map((label, index) => [label.textContent ?? "", values[index]?.textContent ?? ""]));
};

describe("Stock Token trade-history presentation", () => {
  it("shows user-facing trade facts and keeps exact processing data in developer details", () => {
    const entry = presentationContracts.stockTokenTradeHistory;
    const input = entry.parseInput({ symbol: "AAPL", period: { count: 1, unit: "day" } });
    const value = stockTokenTradeHistoryAvailableFixture();
    if (value.data.status !== "available") throw new TypeError("Trade-history fixture is unavailable.");
    const data = value.data;
    const admitted = entry.parseResult(input, value);
    const rendered = renderPresentation(entry, admitted);
    const card = rendered.node;

    expect(card.querySelector("h1")?.textContent).toBe("Stock Token trade history");
    expect(fields(card.querySelector("dl"))).toEqual(new Map([
      ["Stock Token", "Apple • Robinhood Token · AAPL"],
      ["Requested period", "1 day"],
    ]));
    expect(card.textContent).toContain("Trades in USDG");
    expect(card.textContent).toContain("StatusAvailable");
    expect(card.textContent).toContain(
      `Freshness${data.freshness === "current" ? "Current" : "Stale"}`,
    );
    expect(card.textContent).toContain(
      `Coverage${data.coverage.status === "complete" ? "Complete" : "Partial"}`,
    );
    expect(card.textContent).toContain(
      `Requested coverage${data.requestedStart} to ${data.requestedEnd}`,
    );
    expect(card.textContent).toContain(
      `Published through${data.archive.root.currentUntil.timestamp}`,
    );
    for (const limitation of data.coverage.limitations) {
      expect(card.textContent).toContain(limitation === "before_published_coverage"
        ? "Published trade history starts after the requested period began."
        : "Published trade history ends before the requested period ended.");
    }
    expect(card.textContent).not.toContain("Chainlink");
    expect(card.textContent).not.toContain("oracle");
    expect(card.textContent).not.toContain("Reference value");
    expect(card.querySelector(".eyebrow")).toBeNull();
    expect(rendered.tradeHistoryChart).not.toBeNull();
    expect(card.querySelector('.trade-history-chart[role="img"]')?.getAttribute("aria-label"))
      .toContain("Apple • Robinhood Token · AAPL trades in USDG");
    expect(card.querySelector('.trade-history-chart[role="img"]')?.getAttribute("aria-label"))
      .toContain("Developer details");
    expect(card.querySelector('.trade-history-chart[role="img"]')?.getAttribute("aria-label"))
      .toContain(`${data.requestedStart} inclusive to ${data.requestedEnd} exclusive`);

    const disclosures = [...card.querySelectorAll("details")];
    expect(disclosures.map((details) => details.querySelector("summary")?.textContent)).toEqual([
      "Token details",
      "Developer details",
    ]);
    expect(disclosures.every((details) => !details.open)).toBe(true);
    expect(card.textContent).not.toContain("Exact chart data");

    const token = disclosures[0]!;
    expect(fields(token.querySelector("dl"))).toEqual(new Map<string, string>([
      ["Stock Token contract", data.officialAsset.member.contractAddress],
      ["USDG contract", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"],
      ["Uniswap V4 PoolManager", "0x8366a39cc670b4001a1121b8f6a443a643e40951"],
      ["Uniswap V4 Pool IDs", Object.keys(data.archive.pools).join(", ")],
    ]));

    const developer = disclosures[1]!;
    developer.open = true;
    developer.dispatchEvent(new Event("toggle"));
    expect(developer.textContent).not.toContain(data.officialAsset.member.contractAddress);
    expect(developer.textContent).not.toContain("One-minute trade candles");
    expect(developer.textContent).toContain("Source publication sequence");
    const tables = [...developer.querySelectorAll("table")];
    expect(tables.map((table) => table.querySelector("caption")?.textContent)).toEqual([
      expect.stringContaining("Chart values and processing by display position"),
      "Evidence source correlation",
    ]);
    expect(tables).toHaveLength(2);
    expect(tables[0]?.querySelectorAll("tbody tr")).toHaveLength(data.positions.length);
    expect(tables[1]?.querySelectorAll("tbody tr")).toHaveLength(value.evidence.sources.length);
    const headings = [...(tables[0]?.querySelectorAll("th") ?? [])]
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Natural interval start",
      "Natural interval end",
      "Represented start",
      "Represented end",
      "Position coverage",
      "Coverage meaning",
      "Pool ID",
      "Position state",
      "Open in USDG",
      "High in USDG",
      "Low in USDG",
      "Close in USDG",
      "USDG volume",
      "AAPL volume",
      "Trade count",
      "USDG volume raw",
      "AAPL volume raw",
      "Observed start",
      "Observed end",
      "First source position",
      "Last source position",
      "Aggregation source",
    ]);
    expect(new Set(headings).size).toBe(headings.length);
    const firstCandle = data.positions.find((position) => position.candle !== null)?.candle;
    if (firstCandle === undefined || firstCandle === null) {
      throw new TypeError("Trade-history fixture has no candle.");
    }
    expect(developer.textContent).toContain(
      `${firstCandle.open.numerator} / ${firstCandle.open.denominator}`,
    );
    expect(developer.textContent).toContain(firstCandle.quoteVolumeRaw);
    expect(developer.textContent).toContain(firstCandle.firstSource.blockHash);
    expect(developer.textContent).toContain(firstCandle.firstSource.transactionHash);
    expect(developer.textContent).toContain(value.evidence.sources[0]!.invocationId);
    expect(developer.textContent).toContain(value.evidence.sources[0]!.observationId);
    expect(developer.textContent).toContain(value.evidence.sources[0]!.recordDigest);
  });

  it("states trade-history unavailability without reviving removed reference data", () => {
    const entry = presentationContracts.stockTokenTradeHistory;
    const admitted = entry.parseResult(
      entry.parseInput({ symbol: "AAPL", period: { count: 1, unit: "day" } }),
      stockTokenTradeHistoryUnavailableFixture(),
    );
    const rendered = renderPresentation(entry, admitted);

    expect(rendered.tradeHistoryChart).toBeNull();
    expect(rendered.node.textContent).toContain("Trades in USDG");
    expect(rendered.node.textContent).toContain("Unavailable");
    expect(rendered.node.textContent).not.toMatch(/Chainlink|oracle|reference price/iu);
    const details = [...rendered.node.querySelectorAll("details")];
    expect(details.map((value) => value.querySelector("summary")?.textContent))
      .toEqual(["Token details"]);
    expect([...fields(details[0]?.querySelector("dl") ?? null).keys()])
      .toEqual(["Stock Token contract"]);
  });

  it("keeps the closed presentation registry as the View classifier", () => {
    expect(presentationContractRegistry.forContract(
      presentationContracts.stockTokenTradeHistory.contract,
    )).toBe(presentationContracts.stockTokenTradeHistory);
    expect(presentationContractRegistry.values()).toContain(
      presentationContracts.stockTokenTradeHistory,
    );
    expect(presentationContractRegistry.values().some((entry) =>
      /reference|market portfolio/iu.test(entry.title))).toBe(false);
  });
});

describe("Token selection operation presentation", () => {
  it("renders a removal from its canonical selection without inspection data", async () => {
    const entry = presentationContracts.tokenSelectionOperation;
    const operation = await createTokenOperation({ kind: "remove" });
    expect(operation.result.selection.historicalInspection).toBeNull();

    const admitted = entry.parseResult(
      entry.parseInput({ operationId: operation.operationId }),
      operation,
    );
    const rendered = renderOperation(entry, admitted);

    expect(fields(rendered.node.querySelector("dl"))).toEqual(new Map([
      ["Operation ID", operation.operationId],
      ["Decision", "Remove token selection"],
      ["Status", "Completed"],
      ["Decision interface", "MCP App"],
      ["Account", operation.result.selection.selection.account.address],
      ["Token", operation.result.selection.selection.asset.address],
      ["Included", "No"],
      ["Selection revision", operation.result.selection.selection.revision],
      ["Completed at", operation.completedAt],
    ]));
    expect(rendered.node.querySelector("details")).toBeNull();
  });
});
