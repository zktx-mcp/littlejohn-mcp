export const walletSessionUnusableErrorDefinition = Object.freeze({
  code: "wallet_session_unusable",
  category: "wallet",
  message: "The WalletConnect session cannot satisfy this request.",
  retryable: false,
} as const);

export const walletTimeoutErrorDefinition = Object.freeze({
  code: "wallet_timeout",
  category: "wallet",
  message: "The wallet request timed out.",
  retryable: true,
} as const);

export const walletErrorDefinitions = Object.freeze([
  {
    code: "wallet_not_connected",
    category: "wallet",
    message: "No usable Robinhood Wallet connection is active.",
    retryable: false,
  },
  walletSessionUnusableErrorDefinition,
  {
    code: "wallet_user_rejected",
    category: "wallet",
    message: "The user rejected the wallet request.",
    retryable: false,
  },
  walletTimeoutErrorDefinition,
  {
    code: "interactive_terminal_required",
    category: "input",
    message: "This command requires an interactive terminal.",
    retryable: false,
  },
] as const);

export const walletInterfaceErrorMappingDefinitions = Object.freeze([
  { code: "wallet_not_connected", httpStatus: 409, problemTitle: "Wallet not connected", cliExitCode: 5 },
  { code: "wallet_session_unusable", httpStatus: 409, problemTitle: "Wallet session unusable", cliExitCode: 5 },
  { code: "wallet_user_rejected", httpStatus: 409, problemTitle: "Wallet request rejected", cliExitCode: 5 },
  { code: "wallet_timeout", httpStatus: 504, problemTitle: "Wallet request timed out", cliExitCode: 4 },
  { code: "interactive_terminal_required", httpStatus: 422, problemTitle: "Interactive terminal required", cliExitCode: 2 },
] as const);
