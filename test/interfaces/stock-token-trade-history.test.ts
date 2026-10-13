import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  getCapabilityDefinitionSnapshot,
  parseCapabilitySuccess,
} from "../../src/core/index.js";
import {
  parseMarketCliCommand,
  runMarketCliCommand,
} from "../../src/interfaces/market-cli.js";
import {stockTokenTradeHistoryInterface} from "../../src/interfaces/identities.js";
import {stockTokenTradeHistoryHumanSummary} from "../../src/interfaces/stock-token-trade-history-presentation.js";
import type { RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import { openTestOwnerSession } from "./owner-session-harness.js";
import {stockTokenTradeHistoryCapability} from "../../src/stock-token-trade-history/index.js";
import {
  stockTokenTradeHistoryAvailableFixture,
  stockTokenTradeHistoryUnavailableFixture,
} from "./stock-token-trade-history-fixture.js";

const clients: LocalOperationClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

const runtime = (value: unknown, requests: unknown[]): LocalOperationClient => {
  const dispatch: RuntimeDispatchPort = Object.freeze({
  dispatchRuntimeRequest: async (
    request: Parameters<RuntimeDispatchPort["dispatchRuntimeRequest"]>[0],
  ) => {
    requests.push(request);
    return { status: 200, body: captureCanonicalJson(value) };
  },
  });
  const client = new LocalOperationClient({ ownerSessions: { openOwnerSession: (signal) => openTestOwnerSession(dispatch, signal) } });
  clients.push(client);
  return client;
};

describe("Stock Token trade-history interface", () => {
  it("derives one control read identity and admits only the canonical CLI period grammar", () => {
    expect(stockTokenTradeHistoryInterface.definition).toBe(stockTokenTradeHistoryCapability);
    expect(getCapabilityDefinitionSnapshot(stockTokenTradeHistoryInterface.definition).capabilityId)
      .toBe("market.stock_token_trade_history");
    expect(stockTokenTradeHistoryInterface.mcp.name)
      .toBe("market_get_stock_token_trade_history");
    expect(stockTokenTradeHistoryInterface.http.path)
      .toBe("/api/v1/internal/control/stock-token-trade-history-queries");
    expect(parseMarketCliCommand([
      "market", "stock-token-trade-history", "aapl",
      "--period", "7", "--unit", "day", "--json",
    ])).toEqual({
      kind: "stock_token_trade_history",
      json: true,
      input: { symbol: "AAPL", period: { count: 7, unit: "day" } },
    });
    expect(parseMarketCliCommand([
      "market", "stock-token-trade-history", "AAPL",
    ])).toMatchObject({ input: { period: { count: 1, unit: "day" } } });
    for (const rejected of [
      ["market", "stock-token-trade-history", "AAPL", "--window", "7d"],
      ["market", "stock-token-trade-history", "AAPL", "--period", "7"],
      ["market", "stock-token-trade-history", "AAPL", "--unit", "day"],
      ["market", "stock-token-market", "AAPL"],
    ]) expect(() => parseMarketCliCommand(rejected)).toThrow();
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

    expect(await runMarketCliCommand(
      runtime(value, requests),
      parseMarketCliCommand([
        "market", "stock-token-trade-history", "AAPL", "--json",
      ]),
      port,
    )).toBe(0);
    expect(output).toEqual([`${canonicalJsonStringify(captureCanonicalJson(value))}\n`]);
    expect(errors).toEqual([]);
    expect(requests).toEqual([expect.objectContaining({
      requestClass: "local_control",
      method: "POST",
      path: "/api/v1/internal/control/stock-token-trade-history-queries",
      body: { symbol: "AAPL", period: { count: 1, unit: "day" } },
    })]);

    output.splice(0);
    expect(await runMarketCliCommand(
      runtime(value, []),
      parseMarketCliCommand([
        "market", "stock-token-trade-history", "AAPL",
      ]),
      port,
    )).toBe(0);
    expect(output[0]).toContain("Stock Token trade history");
    expect(output[0]).toContain("Token: Apple • Robinhood Token · AAPL");
    expect(output[0]).toContain("Data freshness:");
    expect(output[0]).toContain("Data coverage:");
    expect(output[0]).toContain(
      `Available period: ${value.data.requestedStart} to ${value.data.requestedEnd}`,
    );
    expect(output[0]).toContain("Resolution:");
    expect(output[0]).toBe(`${stockTokenTradeHistoryHumanSummary(value.data, value.meta.evaluatedAt)}\n`);
    expect(output[0]).not.toMatch(/Chainlink|oracle|reference price/iu);
  });

  it("states archive unavailability and unknown freshness without inventing a value", async () => {
    const output: string[] = [];
    await runMarketCliCommand(
      runtime(stockTokenTradeHistoryUnavailableFixture(), []),
      parseMarketCliCommand([
        "market", "stock-token-trade-history", "AAPL",
      ]),
      { writeOutput: (text) => output.push(text), writeError: () => undefined },
    );
    expect(output[0]).toContain("Status: Unavailable");
    expect(output[0]).toContain("Reason: Trade history is unavailable.");
    expect(output[0]).toContain("Data freshness: Unknown");
    expect(output[0]).toContain("Reached scope: catalog_root");
    expect(output[0]).not.toMatch(/USD value|oracle|fallback/iu);
  });
});
