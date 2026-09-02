import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  getCapabilityDefinitionSnapshot,
  parseCapabilitySuccess,
} from "../../src/core/index.js";
import {
  parseStockTokenTradeHistoryCliCommand,
  runStockTokenTradeHistoryCliCommand,
} from "../../src/interfaces/stock-token-trade-history-cli.js";
import { stockTokenTradeHistoryInterface } from
  "../../src/interfaces/identities.js";
import { stockTokenTradeHistoryHumanSummary } from
  "../../src/interfaces/stock-token-trade-history-presentation.js";
import type { RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import { stockTokenTradeHistoryCapability } from
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
  it("derives one public identity and admits only the canonical CLI period grammar", () => {
    expect(stockTokenTradeHistoryInterface.definition).toBe(stockTokenTradeHistoryCapability);
    expect(getCapabilityDefinitionSnapshot(stockTokenTradeHistoryInterface.definition).capabilityId)
      .toBe("market.stock_token_trade_history");
    expect(stockTokenTradeHistoryInterface.mcp.name)
      .toBe("market_get_stock_token_trade_history");
    expect(stockTokenTradeHistoryInterface.http.path)
      .toBe("/api/v1/stock-token-trade-history-queries");
    expect(parseStockTokenTradeHistoryCliCommand([
      "market", "stock-token-trade-history", "aapl",
      "--period", "7", "--unit", "day", "--json",
    ])).toEqual({
      kind: "stock_token_trade_history",
      json: true,
      input: { symbol: "AAPL", period: { count: 7, unit: "day" } },
    });
    expect(parseStockTokenTradeHistoryCliCommand([
      "market", "stock-token-trade-history", "AAPL",
    ])).toMatchObject({ input: { period: { count: 1, unit: "day" } } });
    for (const rejected of [
      ["market", "stock-token-trade-history", "AAPL", "--window", "7d"],
      ["market", "stock-token-trade-history", "AAPL", "--period", "7"],
      ["market", "stock-token-trade-history", "AAPL", "--unit", "day"],
      ["market", "stock-token-market", "AAPL"],
    ]) expect(() => parseStockTokenTradeHistoryCliCommand(rejected)).toThrow();
  });

  it("carries the exact canonical success in JSON and derives only human text", async () => {
    const value = stockTokenTradeHistoryAvailableFixture();
    if (value.data.status !== "available") throw new TypeError("Expected available fixture.");
    const input = { symbol: "AAPL", period: { count: 1, unit: "day" as const } };
    expect(() => parseCapabilitySuccess(stockTokenTradeHistoryCapability, input, {
      ...value,
      data: { ...value.data, positions: [] },
    })).toThrow();
    const requests: unknown[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const port = {
      writeOutput: (text: string) => output.push(text),
      writeError: (text: string) => errors.push(text),
    };

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
      body: { symbol: "AAPL", period: { count: 1, unit: "day" } },
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
    expect(output[0]).toContain("Freshness:");
    expect(output[0]).toContain("Coverage:");
    expect(output[0]).toContain(
      `Requested coverage: ${value.data.requestedStart} to ${value.data.requestedEnd}`,
    );
    expect(output[0]).toContain("Resolution:");
    expect(output[0]).toBe(`${stockTokenTradeHistoryHumanSummary(value.data)}\n`);
    expect(output[0]).not.toMatch(/Chainlink|oracle|reference price/iu);
  });

  it("states archive unavailability and unknown freshness without inventing a value", async () => {
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
    expect(output[0]).toContain("Freshness: Unknown");
    expect(output[0]).toContain("Reached scope: catalog_root");
    expect(output[0]).not.toMatch(/USD value|oracle|fallback/iu);
  });
});
