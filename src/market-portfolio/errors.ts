import { getChainOperationFailure } from "../chain/errors.js";
import { getChainInvocationStopReason } from "../chain/invocation-lifecycle.js";
import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { getRuntimeOperationFailure } from "../runtime/errors.js";
import { getTokenCatalogOperationFailure } from "../token-catalog/operation-error.js";
import { tokenCatalogInterfaceErrorMappings } from "../token-catalog/errors.js";
import { referenceMarketErrorRegistry } from "./error-registry.js";
import { referenceMarketInterfaceErrorMappingDefinitions } from "./error-definitions.js";

export const referenceMarketInterfaceErrorMappings = tokenCatalogInterfaceErrorMappings.extend(
  referenceMarketErrorRegistry,
  referenceMarketInterfaceErrorMappingDefinitions,
);

export const createReferenceMarketFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(referenceMarketErrorRegistry, code);

const operationFailures = new WeakMap<object, ApplicationFailure>();

export class ReferenceMarketOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(code: string) {
    const failure = createReferenceMarketFailure(code);
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
  const chainStop = getChainInvocationStopReason(error);
  if (chainStop !== undefined) {
    return new ReferenceMarketOperationError(
      chainStop === "caller_aborted" ? "request_aborted" : "source_unavailable",
    );
  }
  const inherited = getChainOperationFailure(error) ??
    getRuntimeOperationFailure(error) ??
    getTokenCatalogOperationFailure(error);
  return new ReferenceMarketOperationError(inherited?.error.code ?? "internal_error");
};
