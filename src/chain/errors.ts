import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { walletInterfaceErrorMappings } from "../wallet/errors.js";
import {
  chainErrorDefinitions,
  chainInterfaceErrorMappingDefinitions,
} from "./error-definitions.js";
import { chainErrorRegistry } from "./error-registry.js";
import { getChainRpcErrorCode, type ChainRpcErrorCode } from "./rpc.js";

export type ChainErrorCode = typeof chainErrorDefinitions[number]["code"];

export { chainErrorRegistry } from "./error-registry.js";

export const chainInterfaceErrorMappings = walletInterfaceErrorMappings.extend(
  chainErrorRegistry,
  chainInterfaceErrorMappingDefinitions,
);

export const createChainFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(chainErrorRegistry, code);

const chainOperationFailures = new WeakMap<object, ApplicationFailure>();

export class ChainOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(codeOrFailure: string | ApplicationFailure) {
    const failure = typeof codeOrFailure === "string"
      ? createChainFailure(codeOrFailure)
      : codeOrFailure;
    const definition = chainErrorRegistry.get(failure.error.code);
    if (
      failure.ok !== false ||
      failure.error.category !== definition.category ||
      failure.error.message !== definition.message ||
      failure.error.retryable !== definition.retryable
    ) {
      throw new TypeError("Chain application failure is not canonical.");
    }
    super(failure.error.message);
    this.name = "ChainOperationError";
    this.failure = failure;
    chainOperationFailures.set(this, failure);
    Object.freeze(this);
  }
}

export const getChainOperationFailure = (error: unknown): ApplicationFailure | undefined =>
  typeof error === "object" && error !== null
    ? chainOperationFailures.get(error)
    : undefined;

export type ChainInvocationStopReason =
  | "caller_aborted"
  | "application_closed"
  | "deadline_reached";

const stopReasons = new WeakMap<object, ChainInvocationStopReason>();

const failureCodeForStopReason = (
  reason: ChainInvocationStopReason,
): "request_aborted" | "runtime_state_unavailable" | "chain_response_unavailable" => {
  switch (reason) {
    case "caller_aborted": return "request_aborted";
    case "application_closed": return "runtime_state_unavailable";
    case "deadline_reached": return "chain_response_unavailable";
  }
};

export const createChainInvocationStoppedError = (
  reason: ChainInvocationStopReason,
): ChainOperationError => {
  const error = new ChainOperationError(failureCodeForStopReason(reason));
  stopReasons.set(error, reason);
  return error;
};

export const getChainInvocationStopReason = (
  error: unknown,
): ChainInvocationStopReason | undefined =>
  typeof error === "object" && error !== null
    ? stopReasons.get(error)
    : undefined;

const failureCodeForRpcError = (
  code: ChainRpcErrorCode,
  callerSignal: AbortSignal,
): ChainRpcErrorCode => {
  if (code === "request_aborted") {
    return callerSignal.aborted
      ? "request_aborted"
      : "chain_response_unavailable";
  }
  return code;
};

export const admitChainReadFailure = (
  error: unknown,
  callerSignal: AbortSignal,
): ApplicationFailure | undefined => {
  const operationFailure = getChainOperationFailure(error);
  if (operationFailure !== undefined) return operationFailure;

  const rpcCode = getChainRpcErrorCode(error);
  return rpcCode === undefined
    ? undefined
    : createChainFailure(failureCodeForRpcError(rpcCode, callerSignal));
};
