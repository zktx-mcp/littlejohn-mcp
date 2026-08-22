import { getChainOperationFailure } from "../chain/errors.js";
import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { getRuntimeOperationFailure } from "../runtime/errors.js";
import { getTokenCatalogOperationFailure } from "../token-catalog/operation-error.js";
import { tokenCatalogInterfaceErrorMappings } from "../token-catalog/errors.js";
import { marketPortfolioErrorRegistry } from "./contracts.js";
import { marketPortfolioInterfaceErrorMappingDefinitions } from "./error-definitions.js";

export const marketPortfolioInterfaceErrorMappings = tokenCatalogInterfaceErrorMappings.extend(
  marketPortfolioErrorRegistry,
  marketPortfolioInterfaceErrorMappingDefinitions,
);

export { marketPortfolioErrorRegistry } from "./contracts.js";

export const createMarketPortfolioFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(marketPortfolioErrorRegistry, code);

const operationFailures = new WeakMap<object, ApplicationFailure>();

export class MarketPortfolioOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(codeOrFailure: string | ApplicationFailure) {
    const failure = typeof codeOrFailure === "string"
      ? createMarketPortfolioFailure(codeOrFailure)
      : codeOrFailure;
    const definition = marketPortfolioErrorRegistry.get(failure.error.code);
    if (
      failure.ok !== false ||
      failure.error.category !== definition.category ||
      failure.error.message !== definition.message ||
      failure.error.retryable !== definition.retryable
    ) {
      throw new TypeError("Market portfolio application failure is not canonical.");
    }
    super(failure.error.message);
    this.name = "MarketPortfolioOperationError";
    this.failure = failure;
    operationFailures.set(this, failure);
    Object.freeze(this);
  }
}

export const getMarketPortfolioOperationFailure = (error: unknown): ApplicationFailure | undefined =>
  typeof error === "object" && error !== null ? operationFailures.get(error) : undefined;

export const normalizeMarketPortfolioError = (error: unknown): MarketPortfolioOperationError => {
  if (getMarketPortfolioOperationFailure(error) !== undefined) return error as MarketPortfolioOperationError;
  const inherited = getChainOperationFailure(error) ??
    getRuntimeOperationFailure(error) ??
    getTokenCatalogOperationFailure(error);
  return new MarketPortfolioOperationError(
    inherited ?? createMarketPortfolioFailure("internal_error"),
  );
};
