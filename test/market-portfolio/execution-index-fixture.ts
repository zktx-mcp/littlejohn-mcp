import {
  unavailableStockTokenExecutionSeries,
  type StockTokenExecutionIndexReadPort,
} from "../../src/market-portfolio/stock-token-execution-index.js";

export const unavailableExecutionIndex = Object.freeze({
  read: async (input) => unavailableStockTokenExecutionSeries(input, "index_unavailable"),
} satisfies StockTokenExecutionIndexReadPort);
