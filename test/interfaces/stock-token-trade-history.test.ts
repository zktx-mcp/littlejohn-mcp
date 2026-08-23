import { describe, expect, it } from "vitest";

import { canonicalJsonStringify, captureCanonicalJson } from "../../src/core/index.js";
import {
  parseStockTokenTradeHistoryCliCommand,
  runStockTokenTradeHistoryCliCommand,
} from "../../src/interfaces/stock-token-trade-history-cli.js";
import { stockTokenTradeHistoryInterfaceBinding } from
  "../../src/interfaces/identities.js";
import type { RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import { stockTokenTradeHistoryApplicationContract } from
  "../../src/stock-token-trade-history/index.js";
import {
  stockTokenTradeHistoryAvailableFixture,
  stockTokenTradeHistoryUnavailableFixture,
} from "./stock-token-trade-history-fixture.js";

const runtime = (value: unknown, requests: unknown[]): RuntimeDispatchPort => Object.freeze({
  dispatchRuntimeRequest: async (
    request: Parameters<RuntimeDispatchPort["dispatchRuntimeRequest"]>[0],
  ) => {
    requests.push(request);
    return { status: 200, body: captureCanonicalJson(value) };
  },
});

describe("Stock Token trade-history interface", () => {
  it("uses one public name and one canonical CLI grammar", () => {
    expect(stockTokenTradeHistoryInterfaceBinding.contract.capabilityId)
      .toBe("market.stock_token_trade_history");
    expect(stockTokenTradeHistoryInterfaceBinding.mcp.name)
      .toBe("market_get_stock_token_trade_history");
    expect(stockTokenTradeHistoryInterfaceBinding.http.path)
      .toBe("/api/v1/stock-token-trade-history-queries");
    expect(parseStockTokenTradeHistoryCliCommand([
      "market", "stock-token-trade-history", "aapl", "--window", "7d", "--json",
    ])).toEqual({
      kind: "stock_token_trade_history",
      json: true,
      input: { symbol: "AAPL", window: "7d" },
    });
    expect(() => parseStockTokenTradeHistoryCliCommand([
      "market", "stock-token-market", "AAPL",
    ])).toThrow();
  });

  it("preserves the admitted result in JSON and keeps human output trade-focused", async () => {
    const value = stockTokenTradeHistoryAvailableFixture();
    const input = { symbol: "AAPL", window: "1d" as const };
    expect(() => stockTokenTradeHistoryApplicationContract.parsePublicSuccess(
      input,
      { ...value, candles: [] },
    )).toThrow();
    expect(() => stockTokenTradeHistoryApplicationContract.parsePublicSuccess(
      input,
      { ...value, detail: { status: "complete", observedCandleCount: 0, limitations: [] } },
    )).toThrow();
    const requests: unknown[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const port = { writeOutput: (text: string) => output.push(text), writeError: (text: string) => errors.push(text) };

    expect(await runStockTokenTradeHistoryCliCommand(
      runtime(value, requests),
      parseStockTokenTradeHistoryCliCommand([
        "market", "stock-token-trade-history", "AAPL", "--json",
      ]),
      port,
    )).toBe(0);
    expect(output).toEqual([`${canonicalJsonStringify(captureCanonicalJson(value))}\n`]);
    expect(errors).toEqual([]);
    expect(requests).toEqual([expect.objectContaining({
      requestClass: "public_read",
      method: "POST",
      path: "/api/v1/stock-token-trade-history-queries",
      body: { symbol: "AAPL", window: "1d" },
    })]);

    output.splice(0);
    expect(await runStockTokenTradeHistoryCliCommand(
      runtime(value, []),
      parseStockTokenTradeHistoryCliCommand([
        "market", "stock-token-trade-history", "AAPL",
      ]),
      port,
    )).toBe(0);
    expect(output[0]).toContain("Stock Token trade history");
    expect(output[0]).toContain("Token: Apple • Robinhood Token · AAPL");
    expect(output[0]).toContain("Coverage: Partial");
    expect(output[0]).toContain(
      "Limitation: Published trade history starts after the requested period began.",
    );
    expect(output[0]).toContain(
      "Limitation: Published trade history ends before the requested period ended.",
    );
    expect(output[0]).toContain("Latest 15-minute chart close: 927 / 4 USDG");
    expect(output[0]).toContain(
      "Trades observed: 2026-08-12T13:34:00.000Z to 2026-08-12T13:37:00.000Z",
    );
    expect(output[0]).not.toMatch(/One-minute trade candles|Freshness: Current/u);
    expect(output[0]).not.toMatch(/Chainlink|oracle|reference price/iu);
  });

  it("does not invent a price or fallback when trade history is unavailable", async () => {
    const output: string[] = [];
    await runStockTokenTradeHistoryCliCommand(
      runtime(stockTokenTradeHistoryUnavailableFixture(), []),
      parseStockTokenTradeHistoryCliCommand([
        "market", "stock-token-trade-history", "AAPL",
      ]),
      { writeOutput: (text) => output.push(text), writeError: () => undefined },
    );
    expect(output[0]).toContain("Status: Unavailable");
    expect(output[0]).toContain("Reason: Trade history is temporarily unavailable.");
    expect(output[0]).not.toMatch(/USD value|oracle|fallback/iu);
  });
});
