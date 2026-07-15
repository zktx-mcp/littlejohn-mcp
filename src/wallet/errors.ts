import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import {
  RuntimeOperationError,
  runtimeErrorRegistry,
  runtimeInterfaceErrorMappings,
} from "../runtime/index.js";

const walletDefinitions = [
  {
    code: "wallet_not_connected",
    category: "wallet",
    message: "No usable Robinhood Wallet connection is active.",
    retryable: false,
  },
  {
    code: "wallet_session_unusable",
    category: "wallet",
    message: "The WalletConnect session cannot satisfy this request.",
    retryable: false,
  },
  {
    code: "wallet_user_rejected",
    category: "wallet",
    message: "The user rejected the wallet request.",
    retryable: false,
  },
  {
    code: "wallet_timeout",
    category: "wallet",
    message: "The wallet request timed out.",
    retryable: true,
  },
  {
    code: "interactive_terminal_required",
    category: "input",
    message: "This command requires an interactive terminal.",
    retryable: false,
  },
] as const;

export type WalletErrorCode = typeof walletDefinitions[number]["code"];

export const walletErrorRegistry = runtimeErrorRegistry.extend(walletDefinitions);

export const walletInterfaceErrorMappings = runtimeInterfaceErrorMappings.extend(walletErrorRegistry, [
  {
    code: "wallet_not_connected",
    httpStatus: 409,
    problemTitle: "Wallet not connected",
    cliExitCode: 5,
  },
  {
    code: "wallet_session_unusable",
    httpStatus: 409,
    problemTitle: "Wallet session unusable",
    cliExitCode: 5,
  },
  {
    code: "wallet_user_rejected",
    httpStatus: 409,
    problemTitle: "Wallet request rejected",
    cliExitCode: 5,
  },
  {
    code: "wallet_timeout",
    httpStatus: 504,
    problemTitle: "Wallet request timed out",
    cliExitCode: 4,
  },
  {
    code: "interactive_terminal_required",
    httpStatus: 422,
    problemTitle: "Interactive terminal required",
    cliExitCode: 2,
  },
]);

export const createWalletFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(walletErrorRegistry, code);

export class WalletOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(code: string) {
    const failure = createWalletFailure(code);
    super(failure.error.message);
    this.name = "WalletOperationError";
    this.failure = failure;
    Object.freeze(this);
  }
}

export const normalizeWalletError = (error: unknown): WalletOperationError =>
  error instanceof WalletOperationError
    ? error
    : error instanceof RuntimeOperationError
      ? new WalletOperationError(error.failure.error.code)
      : new WalletOperationError("internal_error");
