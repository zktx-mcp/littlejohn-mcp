import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import {
  getRuntimeOperationFailure,
  runtimeInterfaceErrorMappings,
} from "../runtime/errors.js";
import {
  walletErrorDefinitions,
  walletInterfaceErrorMappingDefinitions,
} from "./error-definitions.js";
import { walletErrorRegistry } from "./error-registry.js";

export type WalletErrorCode = typeof walletErrorDefinitions[number]["code"];

export { walletErrorRegistry } from "./error-registry.js";

export const walletInterfaceErrorMappings = runtimeInterfaceErrorMappings.extend(
  walletErrorRegistry,
  walletInterfaceErrorMappingDefinitions,
);

export const createWalletFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(walletErrorRegistry, code);

const walletOperationFailures = new WeakMap<object, ApplicationFailure>();

export class WalletOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(code: string) {
    const failure = createWalletFailure(code);
    super(failure.error.message);
    this.name = "WalletOperationError";
    this.failure = failure;
    walletOperationFailures.set(this, failure);
    Object.freeze(this);
  }
}

export const getWalletOperationFailure = (error: unknown): ApplicationFailure | undefined =>
  typeof error === "object" && error !== null
    ? walletOperationFailures.get(error)
    : undefined;

export const normalizeWalletError = (error: unknown): WalletOperationError => {
  if (getWalletOperationFailure(error) !== undefined) return error as WalletOperationError;
  const runtimeFailure = getRuntimeOperationFailure(error);
  return new WalletOperationError(runtimeFailure?.error.code ?? "internal_error");
};
