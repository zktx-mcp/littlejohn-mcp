import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { tokenCatalogInterfaceErrorMappings } from "../token-catalog/errors.js";
import {
  stockTokenTradeHistoryErrorRegistry,
  stockTokenTradeHistoryFailureCodes,
} from "./contracts.js";

export const stockTokenTradeHistoryInterfaceErrorMappings =
  tokenCatalogInterfaceErrorMappings;

export { stockTokenTradeHistoryErrorRegistry } from "./contracts.js";

export const createStockTokenTradeHistoryFailure = (
  code: (typeof stockTokenTradeHistoryFailureCodes)[number],
): ApplicationFailure =>
  createApplicationFailure(stockTokenTradeHistoryErrorRegistry, code);
