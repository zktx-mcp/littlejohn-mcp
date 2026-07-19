import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { walletErrorRegistry, walletInterfaceErrorMappings } from "../wallet/errors.js";
import {
  chainErrorDefinitions,
  chainInterfaceErrorMappingDefinitions,
} from "./error-definitions.js";

export type ChainErrorCode = typeof chainErrorDefinitions[number]["code"];

export const chainErrorRegistry = walletErrorRegistry.extend(chainErrorDefinitions);

export const chainInterfaceErrorMappings = walletInterfaceErrorMappings.extend(
  chainErrorRegistry,
  chainInterfaceErrorMappingDefinitions,
);

export const createChainFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(chainErrorRegistry, code);

const chainOperationFailures = new WeakMap<object, ApplicationFailure>();

export class ChainOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(code: string) {
    const failure = createChainFailure(code);
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
