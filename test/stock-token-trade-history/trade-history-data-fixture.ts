import {
  unavailableStockTokenTradeHistoryData,
  type StockTokenTradeHistoryReadPort,
} from "../../src/stock-token-trade-history/stock-token-trade-history-data.js";

export const unavailableTradeHistory = Object.freeze({
  read: async (input) => unavailableStockTokenTradeHistoryData(input, "trade_history_unavailable"),
} satisfies StockTokenTradeHistoryReadPort);
