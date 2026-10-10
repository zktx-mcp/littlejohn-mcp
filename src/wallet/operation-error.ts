import {createApplicationFailure, type ApplicationFailure} from "../core/client.js";
import {walletErrorRegistry} from "./error-registry.js";

export const createWalletFailure = (code: string): ApplicationFailure => createApplicationFailure(walletErrorRegistry, code);

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
