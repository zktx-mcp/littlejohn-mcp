import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { normalizeTokenCatalogError } from "../token-catalog/operation-error.js";
import {
  tokenCatalogErrorRegistry,
} from "../token-catalog/errors.js";

export const createAccountAssetFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(tokenCatalogErrorRegistry, code);

const operationFailures = new WeakMap<object, ApplicationFailure>();

export class AccountAssetOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(code: string) {
    const failure = createAccountAssetFailure(code);
    super(failure.error.message);
    this.name = "AccountAssetOperationError";
    this.failure = failure;
    operationFailures.set(this, failure);
    Object.freeze(this);
  }
}

export const normalizeAccountAssetError = (error: unknown): AccountAssetOperationError => {
  const own = typeof error === "object" && error !== null
    ? operationFailures.get(error)
    : undefined;
  if (own !== undefined) return error as AccountAssetOperationError;
  return new AccountAssetOperationError(normalizeTokenCatalogError(error).failure.error.code);
};
