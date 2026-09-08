import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { officialAssetInterfaceErrorMappings } from "../registry/errors.js";
import {
  stockTokenTradeHistoryErrorRegistry,
  stockTokenTradeHistoryFailureCodes,
} from "./contracts.js";

export const stockTokenTradeHistoryInterfaceErrorMappings =
  officialAssetInterfaceErrorMappings;

export { stockTokenTradeHistoryErrorRegistry } from "./contracts.js";

export const createStockTokenTradeHistoryFailure = (
  code: (typeof stockTokenTradeHistoryFailureCodes)[number],
): ApplicationFailure =>
  createApplicationFailure(stockTokenTradeHistoryErrorRegistry, code);
