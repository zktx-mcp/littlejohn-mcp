import { createApplicationFailure, type ApplicationFailure } from "../core/index.js";
import { getChainOperationFailure } from "../chain/errors.js";
import { getRuntimeOperationFailure } from "../runtime/errors.js";
import { getWalletOperationFailure } from "../wallet/errors.js";
import { tokenCatalogErrorRegistry } from "./errors.js";

const operationFailures = new WeakMap<object, ApplicationFailure>();

export class TokenCatalogOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(code: string) {
    const failure = createApplicationFailure(tokenCatalogErrorRegistry, code);
    super(failure.error.message);
    this.name = "TokenCatalogOperationError";
    this.failure = failure;
    operationFailures.set(this, failure);
    Object.freeze(this);
  }
}

export const getTokenCatalogOperationFailure = (error: unknown): ApplicationFailure | undefined =>
  typeof error === "object" && error !== null ? operationFailures.get(error) : undefined;

export const normalizeTokenCatalogError = (error: unknown): TokenCatalogOperationError => {
  if (getTokenCatalogOperationFailure(error) !== undefined) return error as TokenCatalogOperationError;
  const inheritedFailure = getChainOperationFailure(error) ??
    getWalletOperationFailure(error) ??
    getRuntimeOperationFailure(error);
  return new TokenCatalogOperationError(inheritedFailure?.error.code ?? "internal_error");
};
