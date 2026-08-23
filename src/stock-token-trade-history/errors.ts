import { getChainOperationFailure } from "../chain/errors.js";
import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { getRuntimeOperationFailure } from "../runtime/errors.js";
import { tokenCatalogInterfaceErrorMappings } from "../token-catalog/errors.js";
import { getTokenCatalogOperationFailure } from "../token-catalog/operation-error.js";
import { stockTokenTradeHistoryErrorRegistry } from "./contracts.js";

export const stockTokenTradeHistoryInterfaceErrorMappings = tokenCatalogInterfaceErrorMappings;

export { stockTokenTradeHistoryErrorRegistry } from "./contracts.js";

export const createStockTokenTradeHistoryFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(stockTokenTradeHistoryErrorRegistry, code);

const operationFailures = new WeakMap<object, ApplicationFailure>();

export class StockTokenTradeHistoryOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(codeOrFailure: string | ApplicationFailure) {
    const failure = typeof codeOrFailure === "string"
      ? createStockTokenTradeHistoryFailure(codeOrFailure)
      : codeOrFailure;
    const definition = stockTokenTradeHistoryErrorRegistry.get(failure.error.code);
    if (
      failure.ok !== false ||
      failure.error.category !== definition.category ||
      failure.error.message !== definition.message ||
      failure.error.retryable !== definition.retryable
    ) {
      throw new TypeError("Stock Token trade-history failure is not canonical.");
    }
    super(failure.error.message);
    this.name = "StockTokenTradeHistoryOperationError";
    this.failure = failure;
    operationFailures.set(this, failure);
    Object.freeze(this);
  }
}

export const getStockTokenTradeHistoryOperationFailure = (
  error: unknown,
): ApplicationFailure | undefined => typeof error === "object" && error !== null
  ? operationFailures.get(error)
  : undefined;

export const normalizeStockTokenTradeHistoryError = (
  error: unknown,
): StockTokenTradeHistoryOperationError => {
  if (getStockTokenTradeHistoryOperationFailure(error) !== undefined) {
    return error as StockTokenTradeHistoryOperationError;
  }
  const inherited = getChainOperationFailure(error) ??
    getRuntimeOperationFailure(error) ??
    getTokenCatalogOperationFailure(error);
  return new StockTokenTradeHistoryOperationError(
    inherited ?? createStockTokenTradeHistoryFailure("internal_error"),
  );
};
