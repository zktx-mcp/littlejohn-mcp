import {
  ReferenceMarketOperationError,
  type ReferenceMarketApplicationPort,
} from "../../src/market-portfolio/index.js";

const unavailable = () => new ReferenceMarketOperationError("wallet_not_connected").failure;

export const referenceMarketInterfaceHarnessPort = (): ReferenceMarketApplicationPort => Object.freeze({
  price: async () => unavailable(),
  history: async () => unavailable(),
  watchlist: async () => unavailable(),
  addPair: async () => unavailable(),
  removePair: async () => unavailable(),
  reorderPairs: async () => unavailable(),
});
