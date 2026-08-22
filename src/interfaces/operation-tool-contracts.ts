import {
  marketPortfolioApplicationContracts,
  type AnyMarketPortfolioApplicationContract,
} from "../market-portfolio/contracts.js";
import {
  tokenCatalogApplicationContracts,
  type AnyTokenCatalogApplicationContract,
} from "../token-catalog/contract-schema.js";
import {
  walletManagementContracts,
  type AnyWalletManagementContract,
} from "../wallet/management-contracts.js";

export interface OperationToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export type OperationToolVisibility =
  | readonly ["model"]
  | readonly ["app"]
  | readonly ["model", "app"];

export interface OperationCliIdentity {
  readonly domain: "market" | "token" | "wallet";
  readonly command: string;
  readonly argumentSyntax: string;
}

export type OperationApplicationContract =
  | AnyWalletManagementContract
  | AnyTokenCatalogApplicationContract
  | AnyMarketPortfolioApplicationContract;

export interface OperationToolContract {
  readonly action: "review" | "decide" | "get_operation" | "cancel_operation";
  readonly contract: OperationApplicationContract;
  readonly mcp: Readonly<{
    readonly name: string;
    readonly description: string;
    readonly annotations: OperationToolAnnotations;
    readonly visibility: OperationToolVisibility;
    readonly createsView: boolean;
  }>;
  readonly cli?: OperationCliIdentity;
  readonly recoveryOperation?: OperationToolContract;
}

const readAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}) satisfies OperationToolAnnotations;

const reviewAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}) satisfies OperationToolAnnotations;

const decisionAnnotations = (destructiveHint: boolean, openWorldHint: boolean) => Object.freeze({
  readOnlyHint: false,
  destructiveHint,
  idempotentHint: true,
  openWorldHint,
}) satisfies OperationToolAnnotations;

const tool = <const Contract extends OperationToolContract>(input: Contract): Readonly<Contract> =>
  Object.freeze({
    ...input,
    mcp: Object.freeze(input.mcp),
    ...(input.cli === undefined ? {} : { cli: Object.freeze(input.cli) }),
  }) as Readonly<Contract>;

const walletOperation = tool({
  action: "get_operation",
  contract: walletManagementContracts.operation,
  mcp: {
    name: "wallet_get_operation",
    description: "Read one exact durable Wallet operation.",
    annotations: readAnnotations,
    visibility: ["model", "app"],
    createsView: false,
  },
  cli: { domain: "wallet", command: "operation", argumentSyntax: "<operation-id> [--json]" },
} satisfies OperationToolContract);

const tokenOperation = tool({
  action: "get_operation",
  contract: tokenCatalogApplicationContracts.operation,
  mcp: {
    name: "token_get_operation",
    description: "Read one exact durable token-selection operation.",
    annotations: readAnnotations,
    visibility: ["model", "app"],
    createsView: false,
  },
  cli: { domain: "token", command: "operation", argumentSyntax: "<operation-id> [--json]" },
} satisfies OperationToolContract);

const watchlistOperation = tool({
  action: "get_operation",
  contract: marketPortfolioApplicationContracts.operation,
  mcp: {
    name: "market_get_watchlist_operation",
    description: "Read one exact durable reference-watchlist operation.",
    annotations: readAnnotations,
    visibility: ["model", "app"],
    createsView: false,
  },
  cli: { domain: "market", command: "watchlist-operation", argumentSyntax: "<operation-id> [--json]" },
} satisfies OperationToolContract);

export const operationToolContracts = Object.freeze({
  walletReview: tool({
    action: "review",
    contract: walletManagementContracts.review,
    mcp: {
      name: "wallet_get_connection_change_review",
      description: "Create one immutable Wallet connection-change Review.",
      annotations: reviewAnnotations,
      visibility: ["model"],
      createsView: true,
    },
  }),
  walletConnect: tool({
    action: "decide",
    contract: walletManagementContracts.connect,
    mcp: {
      name: "wallet_start_connection",
      description: "Accept one exact Wallet connection Review.",
      annotations: decisionAnnotations(false, true),
      visibility: ["app"],
      createsView: false,
    },
    cli: { domain: "wallet", command: "connect", argumentSyntax: "" },
    recoveryOperation: walletOperation,
  }),
  walletDisconnect: tool({
    action: "decide",
    contract: walletManagementContracts.disconnect,
    mcp: {
      name: "wallet_start_disconnection",
      description: "Accept one exact Wallet disconnection Review.",
      annotations: decisionAnnotations(true, true),
      visibility: ["app"],
      createsView: false,
    },
    cli: { domain: "wallet", command: "disconnect", argumentSyntax: "" },
    recoveryOperation: walletOperation,
  }),
  walletOperation,
  walletCancel: tool({
    action: "cancel_operation",
    contract: walletManagementContracts.cancelOperation,
    mcp: {
      name: "wallet_cancel_operation",
      description: "Cancel one exact active Wallet connection operation.",
      annotations: decisionAnnotations(false, true),
      visibility: ["app"],
      createsView: false,
    },
    cli: { domain: "wallet", command: "cancel", argumentSyntax: "<operation-id>" },
    recoveryOperation: walletOperation,
  }),
  tokenReview: tool({
    action: "review",
    contract: tokenCatalogApplicationContracts.selectionChangeReview,
    mcp: {
      name: "token_get_selection_change_review",
      description: "Create one immutable token-selection change Review.",
      annotations: reviewAnnotations,
      visibility: ["model"],
      createsView: true,
    },
  }),
  tokenAdd: tool({
    action: "decide",
    contract: tokenCatalogApplicationContracts.addSelection,
    mcp: {
      name: "token_add_selection",
      description: "Accept one exact token-selection addition Review.",
      annotations: decisionAnnotations(false, true),
      visibility: ["app"],
      createsView: false,
    },
    cli: { domain: "token", command: "add", argumentSyntax: "<token-address>" },
    recoveryOperation: tokenOperation,
  }),
  tokenRemove: tool({
    action: "decide",
    contract: tokenCatalogApplicationContracts.removeSelection,
    mcp: {
      name: "token_remove_selection",
      description: "Accept one exact token-selection removal Review.",
      annotations: decisionAnnotations(true, false),
      visibility: ["app"],
      createsView: false,
    },
    cli: { domain: "token", command: "remove", argumentSyntax: "<token-address> --revision <revision>" },
    recoveryOperation: tokenOperation,
  }),
  tokenOperation,
  watchlistReview: tool({
    action: "review",
    contract: marketPortfolioApplicationContracts.watchlistChangeReview,
    mcp: {
      name: "market_get_watchlist_change_review",
      description: "Create one immutable reference-watchlist change Review.",
      annotations: reviewAnnotations,
      visibility: ["model"],
      createsView: true,
    },
  }),
  watchlistAdd: tool({
    action: "decide",
    contract: marketPortfolioApplicationContracts.add,
    mcp: {
      name: "market_add_watchlist_pair",
      description: "Accept one exact reference-watchlist addition Review.",
      annotations: decisionAnnotations(false, false),
      visibility: ["app"],
      createsView: false,
    },
    cli: { domain: "market", command: "add-pair", argumentSyntax: "<pair-id> --revision <revision>" },
    recoveryOperation: watchlistOperation,
  }),
  watchlistRemove: tool({
    action: "decide",
    contract: marketPortfolioApplicationContracts.remove,
    mcp: {
      name: "market_remove_watchlist_pair",
      description: "Accept one exact reference-watchlist removal Review.",
      annotations: decisionAnnotations(true, false),
      visibility: ["app"],
      createsView: false,
    },
    cli: { domain: "market", command: "remove-pair", argumentSyntax: "<pair-id> --revision <revision>" },
    recoveryOperation: watchlistOperation,
  }),
  watchlistReorder: tool({
    action: "decide",
    contract: marketPortfolioApplicationContracts.reorder,
    mcp: {
      name: "market_reorder_watchlist_pairs",
      description: "Accept one exact reference-watchlist reorder Review.",
      annotations: decisionAnnotations(false, false),
      visibility: ["app"],
      createsView: false,
    },
    cli: { domain: "market", command: "reorder-pairs", argumentSyntax: "<pair-id>... --revision <revision>" },
    recoveryOperation: watchlistOperation,
  }),
  watchlistOperation,
} satisfies Readonly<Record<string, OperationToolContract>>);

export const operationToolContractList: readonly OperationToolContract[] = Object.freeze(
  Object.values(operationToolContracts),
);

export const operationMcpToolNames = Object.freeze(
  operationToolContractList.map((entry) => entry.mcp.name),
);

export const operationCliCommandIdentities = Object.freeze(
  operationToolContractList.flatMap((entry) => entry.cli === undefined ? [] : [entry.cli]),
);
