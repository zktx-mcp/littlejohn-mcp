import { getChainOperationFailure } from "../chain/errors.js";
import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { getRuntimeOperationFailure } from "../runtime/errors.js";
import { getTokenCatalogOperationFailure } from "../token-catalog/operation-error.js";
import { tokenCatalogInterfaceErrorMappings } from "../token-catalog/errors.js";
import { referenceMarketErrorRegistry } from "./contracts.js";
import { referenceMarketInterfaceErrorMappingDefinitions } from "./error-definitions.js";

export const referenceMarketInterfaceErrorMappings = tokenCatalogInterfaceErrorMappings.extend(
  referenceMarketErrorRegistry,
  referenceMarketInterfaceErrorMappingDefinitions,
);

export { referenceMarketErrorRegistry } from "./contracts.js";

export const createReferenceMarketFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(referenceMarketErrorRegistry, code);

const operationFailures = new WeakMap<object, ApplicationFailure>();

export class ReferenceMarketOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(codeOrFailure: string | ApplicationFailure) {
    const failure = typeof codeOrFailure === "string"
      ? createReferenceMarketFailure(codeOrFailure)
      : codeOrFailure;
    const definition = referenceMarketErrorRegistry.get(failure.error.code);
    if (
      failure.ok !== false ||
      failure.error.category !== definition.category ||
      failure.error.message !== definition.message ||
      failure.error.retryable !== definition.retryable
    ) {
      throw new TypeError("Reference market application failure is not canonical.");
    }
    super(failure.error.message);
    this.name = "ReferenceMarketOperationError";
    this.failure = failure;
    operationFailures.set(this, failure);
    Object.freeze(this);
  }
}

export const getReferenceMarketOperationFailure = (error: unknown): ApplicationFailure | undefined =>
  typeof error === "object" && error !== null ? operationFailures.get(error) : undefined;

export const normalizeReferenceMarketError = (error: unknown): ReferenceMarketOperationError => {
  if (getReferenceMarketOperationFailure(error) !== undefined) return error as ReferenceMarketOperationError;
  const inherited = getChainOperationFailure(error) ??
    getRuntimeOperationFailure(error) ??
    getTokenCatalogOperationFailure(error);
  return new ReferenceMarketOperationError(
    inherited ?? createReferenceMarketFailure("internal_error"),
  );
};
