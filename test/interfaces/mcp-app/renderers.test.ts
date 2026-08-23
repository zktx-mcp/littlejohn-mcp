// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { presentationContractRegistry, presentationContracts } from
  "../../../src/interfaces/mcp-app/registry.js";
import { renderPresentation } from
  "../../../src/interfaces/mcp-app/view/renderers.js";
import {
  stockTokenTradeHistoryAvailableFixture,
  stockTokenTradeHistoryUnavailableFixture,
} from "../stock-token-trade-history-fixture.js";

const fields = (list: Element | null): ReadonlyMap<string, string> => {
  if (!(list instanceof HTMLDListElement)) throw new TypeError("Summary is unavailable.");
  const labels = [...list.querySelectorAll("dt")];
  const values = [...list.querySelectorAll("dd")];
  return new Map(labels.map((label, index) => [label.textContent ?? "", values[index]?.textContent ?? ""]));
};

describe("Stock Token trade-history presentation", () => {
  it("shows user-facing trade facts and keeps exact processing data in developer details", () => {
    const entry = presentationContracts.stockTokenTradeHistory;
    const input = entry.parseInput({ symbol: "AAPL", window: "1d" });
    const value = stockTokenTradeHistoryAvailableFixture();
    if (value.status !== "available") throw new TypeError("Trade-history fixture is unavailable.");
    const admitted = entry.parseResult(input, value);
    const rendered = renderPresentation(entry, admitted);
    const card = rendered.node;

    expect(card.querySelector("h1")?.textContent).toBe("Stock Token trade history");
    expect(fields(card.querySelector("dl"))).toEqual(new Map([
      ["Stock Token", "Apple • Robinhood Token · AAPL"],
      ["Requested period", "1 day"],
    ]));
    expect(card.textContent).toContain("Trades in USDG");
    expect(card.textContent).toContain("CoveragePartial");
    expect(card.textContent).not.toContain("FreshnessCurrent");
    expect(card.textContent).toContain(
      "Published trade history starts after the requested period began.",
    );
    expect(card.textContent).not.toContain("Chainlink");
    expect(card.textContent).not.toContain("oracle");
    expect(card.textContent).not.toContain("Reference value");
    expect(card.querySelector(".eyebrow")).toBeNull();
    expect(rendered.tradeHistoryChart).not.toBeNull();
    expect(card.querySelector('.trade-history-chart[role="img"]')?.getAttribute("aria-label"))
      .toContain("Apple • Robinhood Token · AAPL trades in USDG");
    expect(card.querySelector('.trade-history-chart[role="img"]')?.getAttribute("aria-label"))
      .toContain("Developer details");

    const disclosures = [...card.querySelectorAll("details")];
    expect(disclosures.map((details) => details.querySelector("summary")?.textContent)).toEqual([
      "Token details",
      "Developer details",
    ]);
    expect(disclosures.every((details) => !details.open)).toBe(true);
    expect(card.textContent).not.toContain("Exact chart data");

    const token = disclosures[0]!;
    expect(fields(token.querySelector("dl"))).toEqual(new Map<string, string>([
      ["Stock Token contract", value.officialAsset.member.contractAddress],
      ["USDG contract", value.source.quoteToken.address],
      ["Uniswap V4 PoolManager", value.source.poolManager],
      ["Uniswap V4 Pool ID", value.source.poolId],
    ]));

    const developer = disclosures[1]!;
    developer.open = true;
    developer.dispatchEvent(new Event("toggle"));
    expect(developer.textContent).not.toContain(value.status === "available"
      ? value.officialAsset.member.contractAddress : "");
    expect(developer.textContent).not.toContain("One-minute trade candles");
    expect(developer.textContent).toContain("Source file sequence");
    expect(developer.querySelector("table caption")?.textContent).toContain(
      "Chart values and processing by display position",
    );
    expect(developer.querySelectorAll("table")).toHaveLength(1);
    expect(developer.querySelectorAll("tbody tr")).toHaveLength(97);
    const headings = [...developer.querySelectorAll("th")].map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Natural interval start",
      "Natural interval end",
      "Represented start",
      "Represented end",
      "Position coverage",
      "Coverage meaning",
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
      "Aggregation source",
    ]);
    expect(new Set(headings).size).toBe(headings.length);
    expect(developer.textContent).toContain("925 / 4");
    expect(developer.textContent).toContain("0.006003 USDG");
    expect(developer.textContent).toContain("6003");
  });

  it("states trade-history unavailability without reviving removed reference data", () => {
    const entry = presentationContracts.stockTokenTradeHistory;
    const admitted = entry.parseResult(
      entry.parseInput({ symbol: "AAPL", window: "1d" }),
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
