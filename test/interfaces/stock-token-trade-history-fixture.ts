import {
  parseCapabilityInput,
  parseCapabilitySuccess,
} from "../../src/core/index.js";
import {
  stockTokenTradeHistoryCapability,
  type StockTokenTradeHistoryData,
} from "../../src/stock-token-trade-history/index.js";
import results from "./stock-token-trade-history-results.json" with { type: "json" };

const input = parseCapabilityInput(stockTokenTradeHistoryCapability, {
  symbol: "AAPL",
  period: { count: 1, unit: "day" },
});

const available = parseCapabilitySuccess(
  stockTokenTradeHistoryCapability,
  input,
  results.available,
);
const unavailable = parseCapabilitySuccess(
  stockTokenTradeHistoryCapability,
  input,
  results.unavailable,
);

if (available.data.status !== "available" || !("block" in available.data)) {
  throw new TypeError("The admitted trade-history fixture is not available.");
}

export const stockTokenTradeHistoryFixtureBlock = available.data.block;

export const stockTokenTradeHistoryAvailableFixture = () => available;

export const stockTokenTradeHistoryUnavailableFixture = () => unavailable;

export type StockTokenTradeHistoryFixtureData = StockTokenTradeHistoryData;
