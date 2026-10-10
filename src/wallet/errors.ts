import {WalletOperationError, getWalletOperationFailure} from "./operation-error.js";
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

export const normalizeWalletError = (error: unknown): WalletOperationError => {
  if (getWalletOperationFailure(error) !== undefined) return error as WalletOperationError;
  const runtimeFailure = getRuntimeOperationFailure(error);
  return new WalletOperationError(runtimeFailure?.error.code ?? "internal_error");
};
