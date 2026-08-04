import {
  accountBalanceCapability,
  CapabilityRegistry,
  captureCanonicalJson,
  chainStatusCapability,
  compareCodePointSequences,
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  operationIdSchema,
  readBoundaryFailureCodes,
  transactionInspectCapability,
  walletConnectionCapability,
  type ApplicationErrorRegistry,
  type ApplicationFailure,
  type ApplicationContractPublicInput,
  type CanonicalJson,
  type OperationId,
  type AnyReadCapabilityDefinition,
} from "../core/index.js";
import { chainErrorRegistry, chainInterfaceErrorMappings } from "../chain/errors.js";
import {
  accountAssetApplicationContracts,
  accountAssetCollectionRequestBody,
  accountAssetControlRoutes,
  accountAssetInterfaceErrorMappings,
  type AnyAccountAssetApplicationContract,
  type AccountAssetCollectionSuccess,
} from "../account-assets/index.js";
import {
  referenceMarketApplicationContracts,
  referenceMarketCapabilities,
  referenceMarketErrorRegistry,
  referenceMarketInterfaceErrorMappings,
  type AnyReferenceMarketApplicationContract,
} from "../market-portfolio/index.js";
import {
  uniswapV2InterfaceErrorMappings,
  uniswapV2ErrorRegistry,
  uniswapV2QuoteCapability,
} from "../protocols/uniswap-v2/index.js";
import {
  tokenCatalogApplicationContracts,
  tokenCatalogErrorRegistry,
  tokenCatalogInterfaceErrorMappings,
  tokenCatalogOperationConfirmationContract,
  tokenCatalogOperationIdSchema,
  tokenCatalogControlRoutes,
  tokenSelectionListRequestBody,
  tokenInspectCapability,
  type TokenCatalogOperation,
  type TokenCatalogCancellationResult,
  type TokenCatalogConfirmedOperation,
  type TokenCatalogOperationConfirmationInput,
  type TokenCatalogOperationResult,
  type TokenCatalogOperationStartResult,
  type TokenSelectionInput,
  type TokenSelectionListResult,
  type TokenAdditionStartRequest,
  type TokenSelectionDetail,
  type TokenRemovalStartInput,
  type TokenCatalogOperationKind,
  type TokenCatalogInteractionInterface,
  type AnyTokenCatalogApplicationContract,
} from "../token-catalog/index.js";
import {
  walletManagementContracts,
  walletOperationConfirmationContract,
  type AnyWalletManagementContract,
} from "../wallet/management-contracts.js";
import {
  parseWalletManagementOperation,
  parseWalletOperationPresentation,
  parseWalletOperationStartResult,
  type WalletManagementOperation,
  type WalletOperationPresentation,
  type WalletOperationStartResult,
} from "../wallet/contracts.js";
import { walletErrorRegistry, walletInterfaceErrorMappings } from "../wallet/errors.js";
import type {
  WalletInteractionInterface,
  WalletOperationKind,
} from "../wallet/operation-state.js";
import { walletControlResources } from "../wallet/routes.js";
import type { CanonicalDispatchAuthority } from "./http-client.js";
import type { ReferenceMarketDeliveryAction } from "./reference-market-delivery.js";
import type { OperationDeliveryAction } from "./operation-delivery.js";
import type { InterfaceErrorMappingRegistry } from "../runtime/errors.js";
import type { RuntimeHttpRequest } from "../runtime/http-boundary.js";
import {
  publicInspectionPaths,
  referenceMarketPublicRoutes,
} from "./browser-contract.js";

export const uniswapV2PublicRoutes = Object.freeze({
  exactInputQuotes: "/api/v1/uniswap-v2-exact-input-quotes",
} as const);

export const referenceMarketLocalMutationPaths = Object.freeze({
  add: "/api/v1/internal/control/reference-market-watchlist/entry-additions",
  remove: "/api/v1/internal/control/reference-market-watchlist/entry-removals",
  reorder: "/api/v1/internal/control/reference-market-watchlist/order-replacements",
} as const satisfies Readonly<Record<ReferenceMarketDeliveryAction, string>>);

declare const localOperationIdentityType: unique symbol;

export interface LocalOperationIdentity<Input = unknown, Success = unknown> {
  readonly [localOperationIdentityType]: readonly [Input, Success];
}

type LocalOperationHttpRequest = RuntimeHttpRequest;
type LocalOperationReadInput = Readonly<{ operationId: OperationId }>;

interface LocalOperationContract<Input> {
  readonly errorRegistry: ApplicationErrorRegistry;
  parseInput(value: unknown): Input;
  normalizeFailure(value: unknown): ApplicationFailure;
}

export interface LocalOperationRecoveryObservation<Input = unknown, Success = unknown> {
  readonly target: LocalOperationIdentity<LocalOperationReadInput, unknown>;
  admitObservedResult(input: Input, operationId: OperationId, value: unknown): Success;
}

export interface LocalOperationBinding<Input = unknown, Success = unknown> {
  readonly action: "read" | OperationDeliveryAction;
  readonly contract: LocalOperationContract<Input>;
  readonly errorMappings: InterfaceErrorMappingRegistry;
  operationId(input: Input, allocated: OperationId | undefined): OperationId | undefined;
  actionRequest(input: Input, operationId: OperationId | undefined): LocalOperationHttpRequest;
  parseActionResponse(input: Input, operationId: OperationId | undefined, value: unknown): Success;
  readonly recoveryObservation?: LocalOperationRecoveryObservation<Input, Success>;
}

interface InterfaceToolDeliveryRecovery {
  readonly targetBinding: "operation";
}

export interface InterfaceToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface CliInterfaceIdentity {
  readonly domain: "market" | "read" | "token" | "uniswap-v2" | "wallet";
  readonly command: string;
  readonly argumentSyntax: string;
}

export interface ReadInterfaceIdentity {
  readonly definition: AnyReadCapabilityDefinition;
  readonly capabilityId: ReturnType<typeof getCapabilityDefinitionSnapshot>["capabilityId"];
  readonly http: Readonly<{ method: "GET" | "POST"; path: string }>;
  readonly mcp: Readonly<{
    name: string;
    description: string;
    annotations: InterfaceToolAnnotations;
  }>;
  readonly cli: Readonly<CliInterfaceIdentity>;
  readonly responseAuthority: CanonicalDispatchAuthority;
}

const chainResponseAuthority = Object.freeze({
  applicationErrors: chainErrorRegistry,
  interfaceMappings: chainInterfaceErrorMappings,
});
const walletResponseAuthority = Object.freeze({
  applicationErrors: walletErrorRegistry,
  interfaceMappings: walletInterfaceErrorMappings,
});
const tokenResponseAuthority = Object.freeze({
  applicationErrors: tokenCatalogErrorRegistry,
  interfaceMappings: tokenCatalogInterfaceErrorMappings,
});
const accountAssetResponseAuthority = Object.freeze({
  applicationErrors: tokenCatalogErrorRegistry,
  interfaceMappings: accountAssetInterfaceErrorMappings,
});
const referenceMarketResponseAuthority = Object.freeze({
  applicationErrors: referenceMarketErrorRegistry,
  interfaceMappings: referenceMarketInterfaceErrorMappings,
});
const uniswapV2ResponseAuthority = Object.freeze({
  applicationErrors: uniswapV2ErrorRegistry,
  interfaceMappings: uniswapV2InterfaceErrorMappings,
});

const readAnnotations = (openWorldHint: boolean): InterfaceToolAnnotations => Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint,
});

const identity = <Definition extends AnyReadCapabilityDefinition>(input: {
  readonly definition: Definition;
  readonly http: ReadInterfaceIdentity["http"];
  readonly mcp: Omit<ReadInterfaceIdentity["mcp"], "annotations"> & {
    readonly openWorldHint: boolean;
  };
  readonly cli: ReadInterfaceIdentity["cli"];
  readonly responseAuthority: CanonicalDispatchAuthority;
}): ReadInterfaceIdentity & { readonly definition: Definition } => Object.freeze({
  definition: input.definition,
  capabilityId: getCapabilityDefinitionSnapshot(input.definition).capabilityId,
  http: Object.freeze(input.http),
  mcp: Object.freeze({
    name: input.mcp.name,
    description: input.mcp.description,
    annotations: readAnnotations(input.mcp.openWorldHint),
  }),
  cli: Object.freeze(input.cli),
  responseAuthority: input.responseAuthority,
});

export const chainStatusInterface = identity({
  definition: chainStatusCapability,
  http: { method: "GET", path: "/api/v1/chain-status" },
  mcp: {
    name: "read_get_chain_status",
    description: "Read the current Robinhood Chain status.",
    openWorldHint: true,
  },
  cli: { domain: "read", command: "chain-status", argumentSyntax: "[--json]" },
  responseAuthority: chainResponseAuthority,
});

export const contractInspectInterface = identity({
  definition: contractInspectCapability,
  http: { method: "POST", path: publicInspectionPaths.contractQueries },
  mcp: {
    name: "read_inspect_contract",
    description: "Inspect contract runtime code at one Robinhood Chain block.",
    openWorldHint: true,
  },
  cli: {
    domain: "read",
    command: "contract",
    argumentSyntax: "<address> --block <latest|block-number> [--json]",
  },
  responseAuthority: chainResponseAuthority,
});

export const transactionInspectInterface = identity({
  definition: transactionInspectCapability,
  http: { method: "POST", path: "/api/v1/transaction-inspections" },
  mcp: {
    name: "read_inspect_transaction",
    description: "Inspect one Robinhood Chain transaction and receipt.",
    openWorldHint: true,
  },
  cli: { domain: "read", command: "transaction", argumentSyntax: "<transaction-hash> [--json]" },
  responseAuthority: chainResponseAuthority,
});

export const accountBalanceInterface = identity({
  definition: accountBalanceCapability,
  http: { method: "POST", path: "/api/v1/account-balance-queries" },
  mcp: {
    name: "read_get_account_balance",
    description: "Read exact native and token balances at one Robinhood Chain block.",
    openWorldHint: true,
  },
  cli: {
    domain: "read",
    command: "balance",
    argumentSyntax: "(--address <address> | --active) --native <true|false> [--token <address>]... --block <latest|block-number> [--json]",
  },
  responseAuthority: chainResponseAuthority,
});

export const walletConnectionInterface = identity({
  definition: walletConnectionCapability,
  http: { method: "GET", path: "/api/v1/wallet/connection" },
  mcp: {
    name: "wallet_get_connection",
    description: "Read the current Robinhood Wallet connection projection.",
    openWorldHint: false,
  },
  cli: { domain: "wallet", command: "status", argumentSyntax: "[--json]" },
  responseAuthority: walletResponseAuthority,
});

export const tokenInspectInterface = identity({
  definition: tokenInspectCapability,
  http: { method: "POST", path: publicInspectionPaths.tokenQueries },
  mcp: {
    name: "token_inspect_contract",
    description: "Inspect one token contract at one Robinhood Chain block.",
    openWorldHint: true,
  },
  cli: {
    domain: "token",
    command: "inspect",
    argumentSyntax: "<token-address> --block <latest|block-number> [--json]",
  },
  responseAuthority: tokenResponseAuthority,
});

export const uniswapV2QuoteInterface = identity({
  definition: uniswapV2QuoteCapability,
  http: { method: "POST", path: uniswapV2PublicRoutes.exactInputQuotes },
  mcp: {
    name: "uniswap_v2_quote_exact_input",
    description: "Quote exact raw input across the declared Uniswap V2 routes.",
    openWorldHint: true,
  },
  cli: {
    domain: "uniswap-v2",
    command: "quote-exact-input",
    argumentSyntax: "--factory <factory-address> --token-in <token-address> --token-out <token-address> --amount-in <raw-uint256> --block <latest|block-number> [--json]",
  },
  responseAuthority: uniswapV2ResponseAuthority,
});

export const readInterfaceIdentities = Object.freeze([
  accountBalanceInterface,
  chainStatusInterface,
  contractInspectInterface,
  tokenInspectInterface,
  transactionInspectInterface,
  uniswapV2QuoteInterface,
  walletConnectionInterface,
].sort((left, right) => compareCodePointSequences(left.capabilityId, right.capabilityId)));

export const interfaceReadCapabilityRegistry = new CapabilityRegistry(
  readInterfaceIdentities.map((identity) => identity.definition),
);

export const capabilityCatalogInterface = Object.freeze({
  failureCodes: readBoundaryFailureCodes,
  http: Object.freeze({ method: "GET" as const, path: "/api/v1/capabilities" }),
  mcp: Object.freeze({
    name: "read_list_capabilities",
    description: "List the canonical read capability catalog.",
    annotations: readAnnotations(false),
  }),
  responseAuthority: chainResponseAuthority,
});

export interface WalletInterfaceBinding {
  readonly action: "start" | "get_operation" | "cancel_operation" | "current_operation";
  readonly contract: AnyWalletManagementContract;
  readonly mcp?: Readonly<{
    readonly name: string;
    readonly description: string;
    readonly annotations: InterfaceToolAnnotations;
    readonly deliveryRecovery?: InterfaceToolDeliveryRecovery;
  }>;
  readonly cli?: Readonly<CliInterfaceIdentity>;
}

const walletBinding = <const Binding extends WalletInterfaceBinding>(
  input: Binding,
): Readonly<Binding> => Object.freeze({
  ...input,
  contract: input.contract,
  ...(input.mcp === undefined ? {} : { mcp: Object.freeze(input.mcp) }),
  ...(input.cli === undefined ? {} : { cli: Object.freeze(input.cli) }),
}) as Readonly<Binding>;

const startAnnotations = (openWorldHint: boolean): InterfaceToolAnnotations => Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint,
});

const operationDeliveryRecovery = Object.freeze({ targetBinding: "operation" } as const);

export interface TokenCatalogInterfaceBinding {
  readonly action: "get" | "list" | "start" | "get_operation" | "cancel_operation";
  readonly contract: AnyTokenCatalogApplicationContract;
  readonly mcp: Readonly<{
    readonly name: string;
    readonly description: string;
    readonly annotations: InterfaceToolAnnotations;
    readonly deliveryRecovery?: InterfaceToolDeliveryRecovery;
  }>;
  readonly cli: Readonly<CliInterfaceIdentity>;
}

export interface AccountAssetInterfaceBinding {
  readonly action: "list" | "get";
  readonly contract: AnyAccountAssetApplicationContract;
  readonly responseAuthority: CanonicalDispatchAuthority;
  readonly control?: Readonly<{ method: "POST"; path: string }>;
  readonly mcp?: Readonly<{
    readonly name: string;
    readonly description: string;
    readonly annotations: InterfaceToolAnnotations;
  }>;
  readonly cli?: Readonly<CliInterfaceIdentity>;
}

export interface ReferenceMarketInterfaceBinding {
  readonly action: "price" | "history" | "watchlist" | "add" | "remove" | "reorder";
  readonly contract: AnyReferenceMarketApplicationContract;
  readonly responseAuthority: CanonicalDispatchAuthority;
  readonly http: Readonly<{ method: "POST"; path: string }>;
  readonly mcp: Readonly<{
    readonly name: string;
    readonly description: string;
    readonly annotations: InterfaceToolAnnotations;
  }>;
  readonly cli: Readonly<CliInterfaceIdentity>;
}

const referenceMarketBinding = <const Binding extends ReferenceMarketInterfaceBinding>(
  input: Binding,
): Readonly<Binding> => {
  if (input.contract.capabilityId !== referenceMarketCapabilities[input.action]) {
    throw new TypeError("Reference market interface action and contract are inconsistent.");
  }
  return Object.freeze({
    ...input,
    contract: input.contract,
    responseAuthority: input.responseAuthority,
    http: Object.freeze(input.http),
    mcp: Object.freeze(input.mcp),
    cli: Object.freeze(input.cli),
  }) as Readonly<Binding>;
};

export const referenceMarketInterfaceBindings = Object.freeze({
  price: referenceMarketBinding({
    action: "price",
    contract: referenceMarketApplicationContracts.price,
    responseAuthority: referenceMarketResponseAuthority,
    http: { method: "POST", path: referenceMarketPublicRoutes.priceQueries },
    mcp: {
      name: "market_get_reference_price",
      description: "Read one Chainlink reference price on Robinhood Chain.",
      annotations: readAnnotations(true),
    },
    cli: { domain: "market", command: "price", argumentSyntax: "<pair-id> [--json]" },
  }),
  history: referenceMarketBinding({
    action: "history",
    contract: referenceMarketApplicationContracts.history,
    responseAuthority: referenceMarketResponseAuthority,
    http: { method: "POST", path: referenceMarketPublicRoutes.historyQueries },
    mcp: {
      name: "market_get_reference_history",
      description: "Read exact Chainlink reference-price candles on Robinhood Chain.",
      annotations: readAnnotations(true),
    },
    cli: { domain: "market", command: "history", argumentSyntax: "<pair-id> --window <1d|7d|30d> [--json]" },
  }),
  watchlist: referenceMarketBinding({
    action: "watchlist",
    contract: referenceMarketApplicationContracts.watchlist,
    responseAuthority: referenceMarketResponseAuthority,
    http: { method: "POST", path: referenceMarketPublicRoutes.watchlistQueries },
    mcp: {
      name: "market_get_watchlist",
      description: "Read the current wallet account's reference-pair watchlist.",
      annotations: readAnnotations(false),
    },
    cli: { domain: "market", command: "watchlist", argumentSyntax: "[--json]" },
  }),
  add: referenceMarketBinding({
    action: "add",
    contract: referenceMarketApplicationContracts.add,
    responseAuthority: referenceMarketResponseAuthority,
    http: { method: "POST", path: referenceMarketLocalMutationPaths.add },
    mcp: {
      name: "market_add_watchlist_pair",
      description: "Add one supported reference pair to the current wallet account's watchlist.",
      annotations: startAnnotations(false),
    },
    cli: { domain: "market", command: "add-pair", argumentSyntax: "<pair-id> --revision <revision> [--json]" },
  }),
  remove: referenceMarketBinding({
    action: "remove",
    contract: referenceMarketApplicationContracts.remove,
    responseAuthority: referenceMarketResponseAuthority,
    http: { method: "POST", path: referenceMarketLocalMutationPaths.remove },
    mcp: {
      name: "market_remove_watchlist_pair",
      description: "Remove one reference pair from the current wallet account's watchlist.",
      annotations: Object.freeze({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      }),
    },
    cli: { domain: "market", command: "remove-pair", argumentSyntax: "<pair-id> --revision <revision> [--json]" },
  }),
  reorder: referenceMarketBinding({
    action: "reorder",
    contract: referenceMarketApplicationContracts.reorder,
    responseAuthority: referenceMarketResponseAuthority,
    http: { method: "POST", path: referenceMarketLocalMutationPaths.reorder },
    mcp: {
      name: "market_reorder_watchlist_pairs",
      description: "Replace the complete order of the current wallet account's reference-pair watchlist.",
      annotations: startAnnotations(false),
    },
    cli: {
      domain: "market",
      command: "reorder-pairs",
      argumentSyntax: "<pair-id>... --revision <revision> [--json]",
    },
  }),
});

export const referenceMarketInterfaceBindingList: readonly ReferenceMarketInterfaceBinding[] = Object.freeze(
  Object.values(referenceMarketInterfaceBindings)
    .sort((left, right) => compareCodePointSequences(left.contract.capabilityId, right.contract.capabilityId)),
);

export const accountAssetInterfaceBindings = Object.freeze({
  collection: Object.freeze({
    action: "list",
    contract: accountAssetApplicationContracts.collection,
    responseAuthority: accountAssetResponseAuthority,
    control: Object.freeze({ method: "POST", path: accountAssetControlRoutes.queries }),
    mcp: Object.freeze({
      name: "account_list_assets",
      description: "List native and added-token assets for the connected wallet account.",
      annotations: readAnnotations(true),
    }),
    cli: Object.freeze({
      domain: "read",
      command: "assets",
      argumentSyntax: "[--limit <1..5>] [--cursor <token-address>] [--json]",
    }),
  }),
  exact: Object.freeze({
    action: "get",
    contract: accountAssetApplicationContracts.exact,
    responseAuthority: accountAssetResponseAuthority,
  }),
});

export const accountAssetInterfaceBindingList: readonly AccountAssetInterfaceBinding[] = Object.freeze(
  Object.values(accountAssetInterfaceBindings),
);

const tokenCatalogBinding = <const Binding extends TokenCatalogInterfaceBinding>(
  input: Binding,
): Readonly<Binding> => Object.freeze({
  ...input,
  contract: input.contract,
  mcp: Object.freeze(input.mcp),
  cli: Object.freeze(input.cli),
}) as Readonly<Binding>;

const tokenCatalogInterfaceBindingDefinitions = Object.freeze({
  selection: tokenCatalogBinding({
    action: "get",
    contract: tokenCatalogApplicationContracts.selection,
    mcp: {
      name: "token_get_selection",
      description: "Read one token selection for the current wallet account.",
      annotations: readAnnotations(false),
    },
    cli: { domain: "token", command: "get", argumentSyntax: "<token-address> [--json]" },
  }),
  selections: tokenCatalogBinding({
    action: "list",
    contract: tokenCatalogApplicationContracts.selections,
    mcp: {
      name: "token_list_selections",
      description: "List token selections for the current wallet account.",
      annotations: readAnnotations(false),
    },
    cli: {
      domain: "token",
      command: "list",
      argumentSyntax: "[--limit <1..25>] [--cursor <token-address>] [--json]",
    },
  }),
  startAddition: tokenCatalogBinding({
    action: "start",
    contract: tokenCatalogApplicationContracts.startAddition,
    mcp: {
      name: "token_start_addition",
      description: "Start adding one token to the current wallet account.",
      annotations: startAnnotations(true),
      deliveryRecovery: operationDeliveryRecovery,
    },
    cli: {
      domain: "token",
      command: "add",
      argumentSyntax: "<token-address>",
    },
  }),
  startRemoval: tokenCatalogBinding({
    action: "start",
    contract: tokenCatalogApplicationContracts.startRemoval,
    mcp: {
      name: "token_start_removal",
      description: "Start removing one token from the current wallet account.",
      annotations: startAnnotations(false),
      deliveryRecovery: operationDeliveryRecovery,
    },
    cli: {
      domain: "token",
      command: "remove",
      argumentSyntax: "<token-address> --revision <revision>",
    },
  }),
  operation: tokenCatalogBinding({
    action: "get_operation",
    contract: tokenCatalogApplicationContracts.operation,
    mcp: {
      name: "token_get_operation",
      description: "Read one retained account token operation.",
      annotations: readAnnotations(false),
    },
    cli: { domain: "token", command: "operation", argumentSyntax: "<operation-id> [--json]" },
  }),
  cancelOperation: tokenCatalogBinding({
    action: "cancel_operation",
    contract: tokenCatalogApplicationContracts.cancelOperation,
    mcp: {
      name: "token_cancel_operation",
      description: "Cancel one cancellable account token operation.",
      annotations: Object.freeze({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }),
      deliveryRecovery: operationDeliveryRecovery,
    },
    cli: { domain: "token", command: "cancel", argumentSyntax: "<operation-id> [--json]" },
  }),
});

const walletInterfaceBindingDefinitions = Object.freeze({
  connect: walletBinding({
    action: "start",
    contract: walletManagementContracts.connect,
    mcp: {
      name: "wallet_start_connection",
      description: "Connect Robinhood Wallet or return the current valid connection.",
      annotations: startAnnotations(true),
      deliveryRecovery: operationDeliveryRecovery,
    },
    cli: { domain: "wallet", command: "connect", argumentSyntax: "" },
  }),
  disconnect: walletBinding({
    action: "start",
    contract: walletManagementContracts.disconnect,
    mcp: {
      name: "wallet_start_disconnection",
      description: "Start a Robinhood Wallet disconnection operation for local browser confirmation.",
      annotations: startAnnotations(false),
      deliveryRecovery: operationDeliveryRecovery,
    },
    cli: { domain: "wallet", command: "disconnect", argumentSyntax: "" },
  }),
  operation: walletBinding({
    action: "get_operation",
    contract: walletManagementContracts.operation,
    mcp: {
      name: "wallet_get_operation",
      description: "Read one retained wallet management operation.",
      annotations: readAnnotations(false),
    },
    cli: { domain: "wallet", command: "operation", argumentSyntax: "<operation-id> [--json]" },
  }),
  cancelOperation: walletBinding({
    action: "cancel_operation",
    contract: walletManagementContracts.cancelOperation,
    mcp: {
      name: "wallet_cancel_operation",
      description: "Cancel one cancellable wallet management operation.",
      annotations: Object.freeze({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      }),
      deliveryRecovery: operationDeliveryRecovery,
    },
    cli: { domain: "wallet", command: "cancel", argumentSyntax: "<operation-id>" },
  }),
  currentOperation: walletBinding({
    action: "current_operation",
    contract: walletManagementContracts.currentOperation,
  }),
});

const localOperationBindings = new WeakMap<object, object>();

const localOperationIdentity = <Input, Success>(
  binding: LocalOperationBinding<Input, Success>,
): LocalOperationIdentity<Input, Success> => {
  const identity = Object.freeze({}) as LocalOperationIdentity<Input, Success>;
  localOperationBindings.set(identity, Object.freeze(binding));
  return identity;
};

const localOperationRecoveryObservation = <Input, Success, Observed>(
  target: LocalOperationIdentity<LocalOperationReadInput, Observed>,
  admitObservedResult: (input: Input, operationId: OperationId, value: Observed) => Success,
): LocalOperationRecoveryObservation<Input, Success> => Object.freeze({
  target: target as LocalOperationIdentity<LocalOperationReadInput, unknown>,
  admitObservedResult: (input: Input, operationId: OperationId, value: unknown) =>
    admitObservedResult(input, operationId, value as Observed),
});

export const resolveLocalOperationIdentity = <Input, Success>(
  identity: LocalOperationIdentity<Input, Success>,
): LocalOperationBinding<Input, Success> => {
  const binding = localOperationBindings.get(identity as object);
  if (binding === undefined) throw new TypeError("Local operation identity is invalid.");
  return binding as LocalOperationBinding<Input, Success>;
};

const unexpectedLocalOperationAction = (action: never): never => {
  throw new TypeError(`Local operation action is invalid: ${String(action)}.`);
};

export const readLocalOperationDeliveryAction = (
  identity: LocalOperationIdentity,
): OperationDeliveryAction => {
  const action = resolveLocalOperationIdentity(identity).action;
  switch (action) {
    case "start":
    case "cancel": return action;
    case "read": throw new TypeError("A read identity has no delivery action.");
    case "confirm": throw new TypeError("A confirmation identity has no MCP delivery action.");
    default: return unexpectedLocalOperationAction(action);
  }
};

const requiredOperationId = (operationId: OperationId | undefined): OperationId => {
  if (operationId === undefined) throw new TypeError("Operation ID is required.");
  return operationId;
};

const operationInputId = (input: Readonly<{ operationId: OperationId }>): OperationId =>
  operationIdSchema.parse(input.operationId);

const walletStartLocalIdentity = (
  kind: WalletOperationKind,
  interactionInterface: WalletInteractionInterface,
): LocalOperationIdentity<
  ReturnType<typeof walletManagementContracts.connect.parseInput>,
  WalletOperationStartResult
> => {
  const contract = walletManagementContracts[kind];
  const parseResponse = (
    publicInput: ReturnType<typeof contract.parseInput>,
    operationId: OperationId | undefined,
    value: unknown,
  ): WalletOperationStartResult => {
    const id = requiredOperationId(operationId);
    return contract.parseBoundSuccess(
      publicInput,
      { operationId: id, interactionInterface },
      parseWalletOperationStartResult(value),
    );
  };
  return localOperationIdentity({
    action: "start",
    contract: contract.applicationContract,
    errorMappings: walletInterfaceErrorMappings,
    operationId: (_input, allocated) => requiredOperationId(allocated),
    actionRequest: (_input, operationId) => ({
      method: walletControlResources.operations.method,
      path: walletControlResources.operations.path,
      body: captureCanonicalJson({
        control: {
          operationId: requiredOperationId(operationId),
          interactionInterface,
        },
        request: { kind, connectionRevision: null },
      }),
    }),
    parseActionResponse: parseResponse,
    recoveryObservation: localOperationRecoveryObservation(
      walletOperationReadIdentity,
      (publicInput, operationId, operation) => parseResponse(publicInput, operationId, {
        status: "operation_started",
        operation,
      }),
    ),
  });
};

type WalletOperationInput = ReturnType<typeof walletManagementContracts.operation.parseInput>;

const walletOperationReadIdentity = localOperationIdentity<
  WalletOperationInput,
  WalletManagementOperation
>({
  action: "read",
  contract: walletManagementContracts.operation.applicationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: (input) => operationInputId(input),
  actionRequest: (_input, operationId) => ({
    method: walletControlResources.operation.method,
    path: walletControlResources.operation.path(requiredOperationId(operationId)),
  }),
  parseActionResponse: (input, _operationId, value) =>
    walletManagementContracts.operation.parsePublicSuccess(
      input,
      parseWalletManagementOperation(value),
    ),
});

const walletPresentationReadIdentity = localOperationIdentity<
  WalletOperationInput,
  WalletOperationPresentation
>({
  action: "read",
  contract: walletManagementContracts.operation.applicationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: (input) => operationInputId(input),
  actionRequest: (_input, operationId) => ({
    method: walletControlResources.presentation.method,
    path: walletControlResources.presentation.path(requiredOperationId(operationId)),
  }),
  parseActionResponse: (input, _operationId, value) => {
    const presentation = parseWalletOperationPresentation(value);
    return Object.freeze({
      ...presentation,
      operation: walletManagementContracts.operation.parsePublicSuccess(
        input,
        presentation.operation,
      ),
    });
  },
});

const walletCancelLocalIdentity = localOperationIdentity<
  ReturnType<typeof walletManagementContracts.cancelOperation.parseInput>,
  WalletManagementOperation
>({
  action: "cancel",
  contract: walletManagementContracts.cancelOperation.applicationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: (input) => operationInputId(input),
  actionRequest: (input, operationId) => ({
    method: walletControlResources.cancellation.method,
    path: walletControlResources.cancellation.path(requiredOperationId(operationId)),
    body: captureCanonicalJson({ connectionRevision: input.connectionRevision }),
  }),
  parseActionResponse: (input, _operationId, value) =>
    walletManagementContracts.cancelOperation.parsePublicSuccess(
      input,
      parseWalletManagementOperation(value),
    ),
  recoveryObservation: localOperationRecoveryObservation(
    walletOperationReadIdentity,
    (input, _operationId, operation) => walletManagementContracts.cancelOperation.parsePublicSuccess(
      input,
      operation,
    ),
  ),
});

type WalletConfirmationInput = ReturnType<typeof walletOperationConfirmationContract.parseInput>;

const walletConfirmationLocalIdentity = localOperationIdentity<
  WalletConfirmationInput,
  WalletManagementOperation
>({
  action: "confirm",
  contract: walletOperationConfirmationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: (input) => operationInputId(input),
  actionRequest: (input, operationId) => ({
    method: walletControlResources.confirmation.method,
    path: walletControlResources.confirmation.path(requiredOperationId(operationId)),
    body: captureCanonicalJson({ connectionRevision: input.connectionRevision }),
  }),
  parseActionResponse: (input, operationId, value) => {
    const id = requiredOperationId(operationId);
    return walletOperationConfirmationContract.parseBoundSuccess(
      input,
      { operationId: id, interactionInterface: "cli" },
      parseWalletManagementOperation(value),
    );
  },
  recoveryObservation: localOperationRecoveryObservation(
    walletOperationReadIdentity,
    (input, operationId, operation) => {
      const id = requiredOperationId(operationId);
      return walletOperationConfirmationContract.parseBoundSuccess(
        input,
        { operationId: id, interactionInterface: "cli" },
        operation,
      );
    },
  ),
});

const tokenOperationId = (input: Readonly<{ operationId: OperationId }>): OperationId =>
  tokenCatalogOperationIdSchema.parse(input.operationId);

const tokenStartLocalIdentity = <Input>(input: Readonly<{
  kind: TokenCatalogOperationKind;
  interactionInterface: TokenCatalogInteractionInterface;
  contract: Readonly<{
    applicationContract: LocalOperationContract<Input>;
    parseBoundSuccess(
      publicInput: unknown,
      internalContext: unknown,
      value: unknown,
    ): TokenCatalogOperationStartResult;
  }>;
}>): LocalOperationIdentity<Input, TokenCatalogOperationStartResult> => localOperationIdentity({
  action: "start",
  contract: input.contract.applicationContract,
  errorMappings: tokenCatalogInterfaceErrorMappings,
  operationId: (_publicInput, allocated) => requiredOperationId(allocated),
  actionRequest: (publicInput, operationId) => ({
    method: "POST",
    path: tokenCatalogControlRoutes.operations,
    body: captureCanonicalJson({
      control: {
        operationId: requiredOperationId(operationId),
        interactionInterface: input.interactionInterface,
      },
      request: {
        kind: input.kind,
        ...(publicInput as Readonly<Record<string, CanonicalJson>>),
      },
    }),
  }),
  parseActionResponse: (publicInput, operationId, value) => input.contract.parseBoundSuccess(
    publicInput,
    {
      operationId: requiredOperationId(operationId),
      interactionInterface: input.interactionInterface,
    },
    value,
  ) as TokenCatalogOperationStartResult,
  recoveryObservation: localOperationRecoveryObservation(
    tokenOperationReadIdentity,
    (publicInput, operationId, operationResult) => input.contract.parseBoundSuccess(
      publicInput,
      {
        operationId: requiredOperationId(operationId),
        interactionInterface: input.interactionInterface,
      },
      { operation: operationResult.operation },
    ) as TokenCatalogOperationStartResult,
  ),
});

const tokenSelectionReadIdentity = localOperationIdentity<
  TokenSelectionInput,
  TokenSelectionDetail
>({
  action: "read",
  contract: tokenCatalogApplicationContracts.selection.applicationContract,
  errorMappings: tokenCatalogInterfaceErrorMappings,
  operationId: () => undefined,
  actionRequest: (input) => ({
    method: "GET",
    path: tokenCatalogControlRoutes.selection(input.asset.chainId, input.asset.address),
  }),
  parseActionResponse: (input, _operationId, value) =>
    tokenCatalogApplicationContracts.selection.parsePublicSuccess(input, value),
});

const tokenSelectionsReadIdentity = localOperationIdentity<
  ReturnType<typeof tokenCatalogApplicationContracts.selections.parseInput>,
  TokenSelectionListResult
>({
  action: "read",
  contract: tokenCatalogApplicationContracts.selections.applicationContract,
  errorMappings: tokenCatalogInterfaceErrorMappings,
  operationId: () => undefined,
  actionRequest: (input) => ({
    method: "POST",
    path: tokenCatalogControlRoutes.selectionQueries,
    body: captureCanonicalJson(tokenSelectionListRequestBody(
      input as Parameters<typeof tokenSelectionListRequestBody>[0],
    )),
  }),
  parseActionResponse: (input, _operationId, value) =>
    tokenCatalogApplicationContracts.selections.parsePublicSuccess(input, value),
});

const tokenOperationReadIdentity = localOperationIdentity<
  ReturnType<typeof tokenCatalogApplicationContracts.operation.parseInput>,
  TokenCatalogOperationResult
>({
  action: "read",
  contract: tokenCatalogApplicationContracts.operation.applicationContract,
  errorMappings: tokenCatalogInterfaceErrorMappings,
  operationId: (input) => tokenOperationId(input),
  actionRequest: (_input, operationId) => ({
    method: "GET",
    path: tokenCatalogControlRoutes.operation(requiredOperationId(operationId)),
  }),
  parseActionResponse: (input, _operationId, value) =>
    tokenCatalogApplicationContracts.operation.parsePublicSuccess(input, value),
});

const tokenCancelLocalIdentity = localOperationIdentity<
  ReturnType<typeof tokenCatalogApplicationContracts.cancelOperation.parseInput>,
  TokenCatalogCancellationResult
>({
  action: "cancel",
  contract: tokenCatalogApplicationContracts.cancelOperation.applicationContract,
  errorMappings: tokenCatalogInterfaceErrorMappings,
  operationId: (input) => tokenOperationId(input),
  actionRequest: (_input, operationId) => ({
    method: "DELETE",
    path: tokenCatalogControlRoutes.operation(requiredOperationId(operationId)),
  }),
  parseActionResponse: (input, _operationId, value) =>
    tokenCatalogApplicationContracts.cancelOperation.parsePublicSuccess(input, value),
  recoveryObservation: localOperationRecoveryObservation(
    tokenOperationReadIdentity,
    (input, _operationId, result) => {
      if (result.operation.state !== "cancelled") {
        throw new TypeError("The exact operation does not prove cancellation.");
      }
      return tokenCatalogApplicationContracts.cancelOperation.parsePublicSuccess(input, result);
    },
  ),
});

const tokenConfirmationLocalIdentity = localOperationIdentity<
  TokenCatalogOperationConfirmationInput,
  TokenCatalogConfirmedOperation
>({
  action: "confirm",
  contract: tokenCatalogOperationConfirmationContract.applicationContract,
  errorMappings: tokenCatalogInterfaceErrorMappings,
  operationId: (input) => tokenOperationId(input),
  actionRequest: (input, operationId) => ({
    method: "POST",
    path: tokenCatalogControlRoutes.confirmation(requiredOperationId(operationId)),
    body: captureCanonicalJson({ reviewDigest: input.reviewDigest }),
  }),
  parseActionResponse: (input, operationId, value) =>
    tokenCatalogOperationConfirmationContract.parseBoundSuccess(
      input,
      { operationId: requiredOperationId(operationId), interactionInterface: "cli" },
      value,
    ),
  recoveryObservation: localOperationRecoveryObservation(
    tokenOperationReadIdentity,
    (input, operationId, result) => tokenCatalogOperationConfirmationContract.parseBoundSuccess(
      input,
      { operationId: requiredOperationId(operationId), interactionInterface: "cli" },
      result.operation,
    ),
  ),
});

const accountAssetCollectionReadIdentity = localOperationIdentity<
  ReturnType<typeof accountAssetApplicationContracts.collection.parseInput>,
  AccountAssetCollectionSuccess
>({
  action: "read",
  contract: accountAssetApplicationContracts.collection.applicationContract,
  errorMappings: accountAssetInterfaceErrorMappings,
  operationId: () => undefined,
  actionRequest: (input) => ({
    method: "POST",
    path: accountAssetControlRoutes.queries,
    body: captureCanonicalJson(accountAssetCollectionRequestBody(input)),
  }),
  parseActionResponse: (input, _operationId, value) =>
    accountAssetApplicationContracts.collection.parsePublicSuccess(input, value),
});

const tokenStartIdentities = (interactionInterface: TokenCatalogInteractionInterface) => Object.freeze({
  addition: tokenStartLocalIdentity<TokenAdditionStartRequest>({
    kind: "add",
    interactionInterface,
    contract: tokenCatalogApplicationContracts.startAddition,
  }),
  removal: tokenStartLocalIdentity<TokenRemovalStartInput>({
    kind: "remove",
    interactionInterface,
    contract: tokenCatalogApplicationContracts.startRemoval,
  }),
});

export const walletLocalOperationIdentities = Object.freeze({
  cli: Object.freeze({
    connect: walletStartLocalIdentity("connect", "cli"),
    disconnect: walletStartLocalIdentity("disconnect", "cli"),
    operation: walletOperationReadIdentity,
    presentation: walletPresentationReadIdentity,
    cancel: walletCancelLocalIdentity,
    confirm: walletConfirmationLocalIdentity,
  }),
  mcp: Object.freeze({
    connect: walletStartLocalIdentity("connect", "web"),
    disconnect: walletStartLocalIdentity("disconnect", "web"),
    operation: walletOperationReadIdentity,
    cancel: walletCancelLocalIdentity,
  }),
});

export const tokenLocalOperationIdentities = Object.freeze({
  shared: Object.freeze({
    selection: tokenSelectionReadIdentity,
    selections: tokenSelectionsReadIdentity,
    operation: tokenOperationReadIdentity,
    cancel: tokenCancelLocalIdentity,
  }),
  cli: Object.freeze({
    ...tokenStartIdentities("cli"),
    confirm: tokenConfirmationLocalIdentity,
  }),
  mcp: tokenStartIdentities("web"),
});

type AnyLocalOperationIdentity = LocalOperationIdentity<unknown, unknown>;
type OperationInterfaceBinding = WalletInterfaceBinding | TokenCatalogInterfaceBinding;

export interface LocalOperationInterfaceCatalogEntry<
  Binding extends OperationInterfaceBinding = OperationInterfaceBinding,
> {
  readonly binding: Binding;
  readonly identity: AnyLocalOperationIdentity;
  readonly deliveryRecovery?: Readonly<{
    readonly target: LocalOperationInterfaceCatalogEntry<Binding>;
  }>;
}

const walletBindingKeys = Object.freeze([
  "connect",
  "disconnect",
  "operation",
  "cancelOperation",
  "currentOperation",
] as const);
const walletOperationBindingKeys = Object.freeze([
  "connect",
  "disconnect",
  "operation",
  "cancelOperation",
] as const);
type WalletOperationBindingKey = typeof walletOperationBindingKeys[number];

const tokenBindingKeys = Object.freeze([
  "selection",
  "selections",
  "startAddition",
  "startRemoval",
  "operation",
  "cancelOperation",
] as const);
const tokenOperationBindingKeys = Object.freeze([
  "startAddition",
  "startRemoval",
  "operation",
  "cancelOperation",
] as const);
type TokenOperationBindingKey = typeof tokenOperationBindingKeys[number];

type WalletBindingMap = Readonly<Record<typeof walletBindingKeys[number], WalletInterfaceBinding>>;
type TokenBindingMap = Readonly<Record<typeof tokenBindingKeys[number], TokenCatalogInterfaceBinding>>;
type WalletOperationIdentityMap = Readonly<Record<WalletOperationBindingKey, AnyLocalOperationIdentity>>;
type TokenOperationIdentityMap = Readonly<Record<TokenOperationBindingKey, AnyLocalOperationIdentity>>;

const assertExactRecordKeys = (
  value: object,
  expected: readonly string[],
): void => {
  const actual = Object.keys(value).sort(compareCodePointSequences);
  const required = [...expected].sort(compareCodePointSequences);
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError("Interface catalog keys are incomplete.");
  }
};

type OperationInterfaceAction = "start" | "cancel_operation" | "get_operation";
const localActionByInterfaceAction = Object.freeze({
  start: "start",
  cancel_operation: "cancel",
  get_operation: "read",
} as const satisfies Readonly<Record<OperationInterfaceAction, "start" | "cancel" | "read">>);

const expectedLocalAction = (
  action: OperationInterfaceBinding["action"],
): "start" | "cancel" | "read" | undefined =>
  Object.hasOwn(localActionByInterfaceAction, action)
    ? localActionByInterfaceAction[action as OperationInterfaceAction]
    : undefined;

const assertExactRecordValues = (
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
  message: string,
): void => {
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) throw new TypeError(message);
  }
};

const admitOperationInterfaceEntries = <Binding extends OperationInterfaceBinding>(
  bindings: Readonly<Record<string, Binding>>,
  identities: Readonly<Record<string, AnyLocalOperationIdentity>>,
  exactOperationContract: Binding["contract"],
): Readonly<Record<string, LocalOperationInterfaceCatalogEntry<Binding>>> => {
  const targetBinding = bindings["operation"];
  const targetIdentity = identities["operation"];
  if (
    targetBinding === undefined ||
    targetIdentity === undefined ||
    targetBinding.action !== "get_operation" ||
    targetBinding.mcp === undefined ||
    targetBinding.contract !== exactOperationContract ||
    targetBinding.mcp.deliveryRecovery !== undefined
  ) {
    throw new TypeError("Operation-read binding is invalid.");
  }
  const targetLocalBinding = resolveLocalOperationIdentity(targetIdentity);
  if (targetLocalBinding.action !== "read") {
    throw new TypeError("Operation-read identity action is invalid.");
  }
  if (targetLocalBinding.contract !== exactOperationContract.applicationContract) {
    throw new TypeError("Operation-read identity contract is invalid.");
  }
  if (targetLocalBinding.recoveryObservation !== undefined) {
    throw new TypeError("Operation-read identity recovery is invalid.");
  }
  const target = Object.freeze({
    binding: targetBinding,
    identity: targetIdentity,
  }) satisfies LocalOperationInterfaceCatalogEntry<Binding>;
  const entries: Record<string, LocalOperationInterfaceCatalogEntry<Binding>> = { operation: target };

  for (const [key, binding] of Object.entries(bindings)) {
    const action = expectedLocalAction(binding.action);
    const identity = identities[key];
    const relation = binding.mcp?.deliveryRecovery;
    if (action === undefined) {
      if (identity !== undefined || relation !== undefined) {
        throw new TypeError("Non-operation binding owns a recovery relationship.");
      }
      continue;
    }
    if (identity === undefined) throw new TypeError("Operation binding identity is missing.");
    if (action === "read") {
      if (key !== "operation" || identity !== targetIdentity || relation !== undefined) {
        throw new TypeError("Operation-read relationship is invalid.");
      }
      continue;
    }
    if (binding.mcp === undefined || relation?.targetBinding !== "operation") {
      throw new TypeError("Mutation binding recovery relationship is missing.");
    }
    assertExactRecordKeys(relation, ["targetBinding"]);
    const localBinding = resolveLocalOperationIdentity(identity);
    if (localBinding.action !== action) {
      throw new TypeError("Mutation binding action is invalid.");
    }
    if (localBinding.contract !== binding.contract.applicationContract) {
      throw new TypeError("Mutation binding contract is invalid.");
    }
    if (localBinding.recoveryObservation?.target !== targetIdentity) {
      throw new TypeError("Mutation binding recovery target is invalid.");
    }
    entries[key] = Object.freeze({
      binding,
      identity,
      deliveryRecovery: Object.freeze({ target }),
    });
  }
  if (Object.keys(entries).length !== Object.keys(identities).length) {
    throw new TypeError("Operation relationship catalog is incomplete.");
  }
  return Object.freeze(entries);
};

const expectedWalletOperationIdentities = Object.freeze({
  connect: walletLocalOperationIdentities.mcp.connect,
  disconnect: walletLocalOperationIdentities.mcp.disconnect,
  operation: walletLocalOperationIdentities.mcp.operation,
  cancelOperation: walletLocalOperationIdentities.mcp.cancel,
}) satisfies WalletOperationIdentityMap;

const expectedTokenOperationIdentities = Object.freeze({
  startAddition: tokenLocalOperationIdentities.mcp.addition,
  startRemoval: tokenLocalOperationIdentities.mcp.removal,
  operation: tokenLocalOperationIdentities.shared.operation,
  cancelOperation: tokenLocalOperationIdentities.shared.cancel,
}) satisfies TokenOperationIdentityMap;

export const admitWalletInterfaceCatalog = <const Bindings extends WalletBindingMap>(input: Readonly<{
  bindings: Bindings;
  identities: WalletOperationIdentityMap;
}>): Readonly<{
  bindings: Bindings;
  bindingList: readonly WalletInterfaceBinding[];
  localOperations: Readonly<Record<
    WalletOperationBindingKey,
    LocalOperationInterfaceCatalogEntry<WalletInterfaceBinding>
  >>;
}> => {
  assertExactRecordKeys(input.bindings, walletBindingKeys);
  assertExactRecordKeys(input.identities, walletOperationBindingKeys);
  const bindings = Object.freeze({ ...input.bindings }) as Bindings;
  const localOperations = admitOperationInterfaceEntries<WalletInterfaceBinding>(
    bindings,
    input.identities,
    walletManagementContracts.operation,
  ) as Readonly<Record<
    WalletOperationBindingKey,
    LocalOperationInterfaceCatalogEntry<WalletInterfaceBinding>
  >>;
  assertExactRecordValues(
    bindings,
    walletInterfaceBindingDefinitions,
    "Wallet interface binding identity is invalid.",
  );
  assertExactRecordValues(
    input.identities,
    expectedWalletOperationIdentities,
    "Wallet operation identity is invalid.",
  );
  return Object.freeze({
    bindings,
    bindingList: Object.freeze(Object.values(bindings)),
    localOperations,
  });
};

export const admitTokenCatalogInterfaceCatalog = <const Bindings extends TokenBindingMap>(input: Readonly<{
  bindings: Bindings;
  identities: TokenOperationIdentityMap;
}>): Readonly<{
  bindings: Bindings;
  bindingList: readonly TokenCatalogInterfaceBinding[];
  localOperations: Readonly<Record<
    TokenOperationBindingKey,
    LocalOperationInterfaceCatalogEntry<TokenCatalogInterfaceBinding>
  >>;
}> => {
  assertExactRecordKeys(input.bindings, tokenBindingKeys);
  assertExactRecordKeys(input.identities, tokenOperationBindingKeys);
  const bindings = Object.freeze({ ...input.bindings }) as Bindings;
  const localOperations = admitOperationInterfaceEntries<TokenCatalogInterfaceBinding>(
    bindings,
    input.identities,
    tokenCatalogApplicationContracts.operation,
  ) as Readonly<Record<
    TokenOperationBindingKey,
    LocalOperationInterfaceCatalogEntry<TokenCatalogInterfaceBinding>
  >>;
  assertExactRecordValues(
    bindings,
    tokenCatalogInterfaceBindingDefinitions,
    "Token interface binding identity is invalid.",
  );
  assertExactRecordValues(
    input.identities,
    expectedTokenOperationIdentities,
    "Token operation identity is invalid.",
  );
  return Object.freeze({
    bindings,
    bindingList: Object.freeze(Object.values(bindings)
      .sort((left, right) => compareCodePointSequences(left.contract.capabilityId, right.contract.capabilityId))),
    localOperations,
  });
};

const walletInterfaceCatalog = admitWalletInterfaceCatalog({
  bindings: walletInterfaceBindingDefinitions,
  identities: expectedWalletOperationIdentities,
});
const tokenCatalogInterfaceCatalog = admitTokenCatalogInterfaceCatalog({
  bindings: tokenCatalogInterfaceBindingDefinitions,
  identities: expectedTokenOperationIdentities,
});

export const walletInterfaceBindings = walletInterfaceCatalog.bindings;
export const walletInterfaceBindingList = walletInterfaceCatalog.bindingList;
export const walletMcpLocalOperationCatalog = walletInterfaceCatalog.localOperations;
export const tokenCatalogInterfaceBindings = tokenCatalogInterfaceCatalog.bindings;
export const tokenCatalogInterfaceBindingList = tokenCatalogInterfaceCatalog.bindingList;
export const tokenMcpLocalOperationCatalog = tokenCatalogInterfaceCatalog.localOperations;

export const accountAssetLocalOperationIdentities = Object.freeze({
  collection: accountAssetCollectionReadIdentity,
});

export const declaredCliCommandIdentities = Object.freeze([
  ...accountAssetInterfaceBindingList.flatMap((binding) =>
    binding.cli === undefined ? [] : [binding.cli]),
  ...readInterfaceIdentities.map((identity) => identity.cli),
  ...referenceMarketInterfaceBindingList.map((binding) => binding.cli),
  ...tokenCatalogInterfaceBindingList.map((binding) => binding.cli),
  ...walletInterfaceBindingList.flatMap((binding) =>
    binding.cli === undefined ? [] : [binding.cli]),
].sort((left, right) => compareCodePointSequences(
  `${left.domain}\0${left.command}`,
  `${right.domain}\0${right.command}`,
)));

const cliExecutableName = "littlejohn" as const;

const cliUsage = (identity: CliInterfaceIdentity): string =>
  `${cliExecutableName} ${identity.domain} ${identity.command}${
    identity.argumentSyntax.length === 0 ? "" : ` ${identity.argumentSyntax}`
  }`;

export const cliHelpText = [
  "Usage:",
  ...declaredCliCommandIdentities.map((identity) => `  ${cliUsage(identity)}`),
  `  ${cliExecutableName} --help`,
  "",
].join("\n");

export const declaredMcpToolNames = Object.freeze([
  ...accountAssetInterfaceBindingList.flatMap((binding) =>
    binding.mcp === undefined ? [] : [binding.mcp.name]),
  ...readInterfaceIdentities.map((entry) => entry.mcp.name),
  ...referenceMarketInterfaceBindingList.map((binding) => binding.mcp.name),
  ...tokenCatalogInterfaceBindingList.map((binding) => binding.mcp.name),
  capabilityCatalogInterface.mcp.name,
  ...walletInterfaceBindingList.flatMap((binding) =>
    binding.mcp === undefined ? [] : [binding.mcp.name]),
].sort(compareCodePointSequences));
