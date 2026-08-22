import {
  MarketPortfolioOperationError,
  type MarketPortfolioApplicationPort,
} from "../../src/market-portfolio/index.js";

const unavailable = () => new MarketPortfolioOperationError("wallet_not_connected").failure;

export const marketPortfolioInterfaceHarnessPort = (): MarketPortfolioApplicationPort => Object.freeze({
  price: async () => unavailable(),
  history: async () => unavailable(),
  stockTokenMarket: async () => unavailable(),
  watchlist: async () => unavailable(),
  reviewWatchlistChange: async () => unavailable(),
  decideWatchlistChange: async () => unavailable(),
  getWatchlistOperation: async () => unavailable(),
});
