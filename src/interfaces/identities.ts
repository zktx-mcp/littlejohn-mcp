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
  accountAssetErrorRegistry,
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
  type AnyTokenCatalogApplicationContract,
} from "../token-catalog/index.js";
import {
  walletManagementContracts,
  walletOperationConfirmationContract,
  type AnyWalletManagementContract,
} from "../wallet/management-contracts.js";
import {
  parseWalletOperationResponse,
  parseWalletOperationStartResponse,
  type WalletManagementOperation,
  type WalletOperationResponse,
  type WalletOperationStartResponse,
} from "../wallet/contracts.js";
import { walletErrorRegistry, walletInterfaceErrorMappings } from "../wallet/errors.js";
import type {
  WalletInteractionInterface,
  WalletOperationKind,
} from "../wallet/operation-state.js";
import { walletControlRoutes } from "../wallet/routes.js";
import type { CanonicalDispatchAuthority } from "./http-client.js";
import type { ReferenceMarketDeliveryAction } from "./reference-market-delivery.js";
import type { OperationDeliveryAction } from "./operation-delivery.js";
import type { InterfaceErrorMappingRegistry } from "../runtime/errors.js";
import type { RouteMethod } from "../runtime/http-routing.js";
import { referenceMarketPublicRoutes } from "./browser-contract.js";

export const referenceMarketLocalMutationPaths = Object.freeze({
  add: "/api/v1/internal/control/reference-market-watchlist/entry-additions",
  remove: "/api/v1/internal/control/reference-market-watchlist/entry-removals",
  reorder: "/api/v1/internal/control/reference-market-watchlist/order-replacements",
} as const satisfies Readonly<Record<ReferenceMarketDeliveryAction, string>>);

declare const localOperationIdentityType: unique symbol;

export interface LocalOperationIdentity<Input = unknown, Success = unknown> {
  readonly [localOperationIdentityType]: readonly [Input, Success];
}

interface LocalOperationHttpRequest {
  readonly method: RouteMethod;
  readonly path: string;
  readonly body?: CanonicalJson;
}

interface LocalOperationContract<Input> {
  readonly errorRegistry: ApplicationErrorRegistry;
  parseInput(value: unknown): Input;
  normalizeFailure(value: unknown): ApplicationFailure;
}

export interface LocalOperationBinding<Input = unknown, Success = unknown> {
  readonly action: "read" | OperationDeliveryAction;
  readonly contract: LocalOperationContract<Input>;
  readonly errorMappings: InterfaceErrorMappingRegistry;
  operationId(input: Input, allocated: OperationId | undefined): OperationId | undefined;
  actionRequest(input: Input, operationId: OperationId | undefined): LocalOperationHttpRequest;
  parseActionResponse(input: Input, operationId: OperationId | undefined, value: unknown): Success;
  readonly recoveryRequest?: (operationId: OperationId) => LocalOperationHttpRequest;
  readonly parseRecoveryResponse?: (input: Input, operationId: OperationId, value: unknown) => Success;
}

export interface InterfaceToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface CliInterfaceIdentity {
  readonly domain: "market" | "read" | "token" | "wallet";
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
  readonly web?: true;
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
  applicationErrors: accountAssetErrorRegistry,
  interfaceMappings: accountAssetInterfaceErrorMappings,
});
const referenceMarketResponseAuthority = Object.freeze({
  applicationErrors: referenceMarketErrorRegistry,
  interfaceMappings: referenceMarketInterfaceErrorMappings,
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
  readonly web?: true;
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
  ...(input.web === undefined ? {} : { web: true as const }),
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
  http: { method: "POST", path: "/api/v1/contract-inspections" },
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
  http: { method: "POST", path: "/api/v1/token-inspections" },
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
  web: true,
});

export const readInterfaceIdentities = Object.freeze([
  accountBalanceInterface,
  chainStatusInterface,
  contractInspectInterface,
  tokenInspectInterface,
  transactionInspectInterface,
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
  readonly control?: Readonly<{
    readonly method: "GET" | "POST" | "DELETE";
    readonly path: string | ((operationId: string) => string);
  }>;
  readonly mcp?: Readonly<{
    readonly name: string;
    readonly description: string;
    readonly annotations: InterfaceToolAnnotations;
  }>;
  readonly cli?: Readonly<CliInterfaceIdentity>;
  readonly operationKind?: WalletOperationKind;
  readonly web?: "start" | "current" | "operation" | "cancel";
}

const walletBinding = <const Binding extends WalletInterfaceBinding>(
  input: Binding,
): Readonly<Binding> => Object.freeze({
  ...input,
  contract: input.contract,
  ...(input.control === undefined ? {} : { control: Object.freeze(input.control) }),
  ...(input.mcp === undefined ? {} : { mcp: Object.freeze(input.mcp) }),
  ...(input.cli === undefined ? {} : { cli: Object.freeze(input.cli) }),
}) as Readonly<Binding>;

const startAnnotations = (openWorldHint: boolean): InterfaceToolAnnotations => Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint,
});

export interface TokenCatalogInterfaceBinding {
  readonly action: "get" | "list" | "start" | "get_operation" | "cancel_operation";
  readonly contract: AnyTokenCatalogApplicationContract;
  readonly mcp: Readonly<{
    readonly name: string;
    readonly description: string;
    readonly annotations: InterfaceToolAnnotations;
  }>;
  readonly cli: Readonly<CliInterfaceIdentity>;
  readonly operationKind?: TokenCatalogOperationKind;
  readonly web: true;
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
  readonly web: true;
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
  readonly web: true;
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
    web: true,
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
    web: true,
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
    web: true,
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
    web: true,
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
    web: true,
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
    web: true,
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
    web: true,
  }),
  exact: Object.freeze({
    action: "get",
    contract: accountAssetApplicationContracts.exact,
    responseAuthority: accountAssetResponseAuthority,
    web: true,
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

export const tokenCatalogInterfaceBindings = Object.freeze({
  selection: tokenCatalogBinding({
    action: "get",
    contract: tokenCatalogApplicationContracts.selection,
    mcp: {
      name: "token_get_selection",
      description: "Read one token selection for the current wallet account.",
      annotations: readAnnotations(false),
    },
    cli: { domain: "token", command: "get", argumentSyntax: "<token-address> [--json]" },
    web: true,
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
    web: true,
  }),
  startAddition: tokenCatalogBinding({
    action: "start",
    contract: tokenCatalogApplicationContracts.startAddition,
    mcp: {
      name: "token_start_addition",
      description: "Start adding one token to the current wallet account.",
      annotations: startAnnotations(true),
    },
    cli: {
      domain: "token",
      command: "add",
      argumentSyntax: "<token-address>",
    },
    operationKind: "add",
    web: true,
  }),
  startRemoval: tokenCatalogBinding({
    action: "start",
    contract: tokenCatalogApplicationContracts.startRemoval,
    mcp: {
      name: "token_start_removal",
      description: "Start removing one token from the current wallet account.",
      annotations: startAnnotations(false),
    },
    cli: {
      domain: "token",
      command: "remove",
      argumentSyntax: "<token-address> --revision <revision>",
    },
    operationKind: "remove",
    web: true,
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
    web: true,
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
    },
    cli: { domain: "token", command: "cancel", argumentSyntax: "<operation-id> [--json]" },
    web: true,
  }),
});

export const tokenCatalogInterfaceBindingList: readonly TokenCatalogInterfaceBinding[] = Object.freeze(
  Object.values(tokenCatalogInterfaceBindings)
    .sort((left, right) => compareCodePointSequences(left.contract.capabilityId, right.contract.capabilityId)),
);

export const walletInterfaceBindings = Object.freeze({
  connect: walletBinding({
    action: "start",
    contract: walletManagementContracts.connect,
    control: { method: "POST", path: walletControlRoutes.operations },
    mcp: {
      name: "wallet_start_connection",
      description: "Connect Robinhood Wallet or return the current valid connection.",
      annotations: startAnnotations(true),
    },
    cli: { domain: "wallet", command: "connect", argumentSyntax: "" },
    operationKind: "connect",
    web: "start",
  }),
  disconnect: walletBinding({
    action: "start",
    contract: walletManagementContracts.disconnect,
    control: { method: "POST", path: walletControlRoutes.operations },
    mcp: {
      name: "wallet_start_disconnection",
      description: "Start a Robinhood Wallet disconnection operation for local browser confirmation.",
      annotations: startAnnotations(false),
    },
    cli: { domain: "wallet", command: "disconnect", argumentSyntax: "" },
    operationKind: "disconnect",
    web: "start",
  }),
  operation: walletBinding({
    action: "get_operation",
    contract: walletManagementContracts.operation,
    control: { method: "GET", path: walletControlRoutes.operation },
    mcp: {
      name: "wallet_get_operation",
      description: "Read one retained wallet management operation.",
      annotations: readAnnotations(false),
    },
    cli: { domain: "wallet", command: "operation", argumentSyntax: "<operation-id> [--json]" },
    web: "operation",
  }),
  cancelOperation: walletBinding({
    action: "cancel_operation",
    contract: walletManagementContracts.cancelOperation,
    control: { method: "DELETE", path: walletControlRoutes.operation },
    mcp: {
      name: "wallet_cancel_operation",
      description: "Cancel one cancellable wallet management operation.",
      annotations: Object.freeze({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      }),
    },
    cli: { domain: "wallet", command: "cancel", argumentSyntax: "<operation-id>" },
    web: "cancel",
  }),
  currentOperation: walletBinding({
    action: "current_operation",
    contract: walletManagementContracts.currentOperation,
    web: "current",
  }),
});

export const walletInterfaceBindingList: readonly WalletInterfaceBinding[] = Object.freeze(
  Object.values(walletInterfaceBindings),
);

const localOperationBindings = new WeakMap<object, object>();

const localOperationIdentity = <Input, Success>(
  binding: LocalOperationBinding<Input, Success>,
): LocalOperationIdentity<Input, Success> => {
  const identity = Object.freeze({}) as LocalOperationIdentity<Input, Success>;
  localOperationBindings.set(identity, Object.freeze(binding));
  return identity;
};

export const resolveLocalOperationIdentity = <Input, Success>(
  identity: LocalOperationIdentity<Input, Success>,
): LocalOperationBinding<Input, Success> => {
  const binding = localOperationBindings.get(identity as object);
  if (binding === undefined) throw new TypeError("Local operation identity is invalid.");
  return binding as LocalOperationBinding<Input, Success>;
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
  WalletOperationStartResponse
> => {
  const contract = walletManagementContracts[kind];
  const parseResponse = (
    publicInput: ReturnType<typeof contract.parseInput>,
    operationId: OperationId | undefined,
    value: unknown,
  ): WalletOperationStartResponse => {
    const id = requiredOperationId(operationId);
    const response = parseWalletOperationStartResponse(value);
    if (interactionInterface !== "cli" && response.qr !== undefined) {
      throw new TypeError("QR material is not available to this interaction interface.");
    }
    return Object.freeze({
      ...response,
      result: contract.parseBoundSuccess(
        publicInput,
        { operationId: id, interactionInterface },
        response.result,
      ),
    });
  };
  return localOperationIdentity({
    action: "start",
    contract: contract.applicationContract,
    errorMappings: walletInterfaceErrorMappings,
    operationId: (_input, allocated) => requiredOperationId(allocated),
    actionRequest: (_input, operationId) => ({
      method: "POST",
      path: walletControlRoutes.operations,
      body: captureCanonicalJson({
        control: {
          operationId: requiredOperationId(operationId),
          interactionInterface,
        },
        request: { kind, connectionRevision: null },
      }),
    }),
    parseActionResponse: parseResponse,
    recoveryRequest: (operationId) => ({
      method: "GET",
      path: walletControlRoutes.operation(operationId),
    }),
    parseRecoveryResponse: (publicInput, operationId, value) => {
      const response = parseWalletOperationResponse(value);
      return parseResponse(publicInput, operationId, {
        result: { status: "operation_started", operation: response.operation },
        ...(response.qr === undefined ? {} : { qr: response.qr }),
      });
    },
  });
};

type WalletOperationInput = ReturnType<typeof walletManagementContracts.operation.parseInput>;

const walletOperationReadIdentity = (
  allowQr: boolean,
): LocalOperationIdentity<WalletOperationInput, WalletOperationResponse> => {
  const contract = walletManagementContracts.operation;
  return localOperationIdentity({
    action: "read",
    contract: contract.applicationContract,
    errorMappings: walletInterfaceErrorMappings,
    operationId: (input) => operationInputId(input),
    actionRequest: (_input, operationId) => ({
      method: "GET",
      path: walletControlRoutes.operation(requiredOperationId(operationId)),
    }),
    parseActionResponse: (input, _operationId, value) => {
      const response = parseWalletOperationResponse(value);
      if (!allowQr && response.qr !== undefined) {
        throw new TypeError("QR material is not available to this interaction interface.");
      }
      return Object.freeze({
        ...response,
        operation: contract.parsePublicSuccess(input, response.operation),
      });
    },
  });
};

const walletCancelLocalIdentity = localOperationIdentity<
  ReturnType<typeof walletManagementContracts.cancelOperation.parseInput>,
  WalletOperationResponse
>({
  action: "cancel",
  contract: walletManagementContracts.cancelOperation.applicationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: (input) => operationInputId(input),
  actionRequest: (_input, operationId) => ({
    method: "DELETE",
    path: walletControlRoutes.operation(requiredOperationId(operationId)),
  }),
  parseActionResponse: (input, _operationId, value) => {
    const response = parseWalletOperationResponse(value);
    return Object.freeze({
      ...response,
      operation: walletManagementContracts.cancelOperation.parsePublicSuccess(
        input,
        response.operation,
      ),
    });
  },
  recoveryRequest: (operationId) => ({
    method: "GET",
    path: walletControlRoutes.operation(operationId),
  }),
  parseRecoveryResponse: (input, _operationId, value) => {
    const response = parseWalletOperationResponse(value);
    const operation = walletManagementContracts.cancelOperation.parsePublicSuccess(
      input,
      response.operation,
    );
    if (operation.state !== "cancelled") {
      throw new TypeError("The exact operation does not prove cancellation.");
    }
    return Object.freeze({ ...response, operation });
  },
});

type WalletConfirmationInput = ReturnType<typeof walletOperationConfirmationContract.parseInput>;

const walletConfirmationLocalIdentity = localOperationIdentity<
  WalletConfirmationInput,
  WalletOperationResponse
>({
  action: "confirm",
  contract: walletOperationConfirmationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: (input) => operationInputId(input),
  actionRequest: (input, operationId) => ({
    method: "POST",
    path: walletControlRoutes.confirmation(requiredOperationId(operationId)),
    body: captureCanonicalJson({ connectionRevision: input.connectionRevision }),
  }),
  parseActionResponse: (input, operationId, value) => {
    const id = requiredOperationId(operationId);
    const response = parseWalletOperationResponse(value);
    return Object.freeze({
      ...response,
      operation: walletOperationConfirmationContract.parseBoundSuccess(
        input,
        { operationId: id, interactionInterface: "cli" },
        response.operation,
      ),
    });
  },
  recoveryRequest: (operationId) => ({
    method: "GET",
    path: walletControlRoutes.operation(operationId),
  }),
  parseRecoveryResponse: (input, operationId, value) => {
    const id = requiredOperationId(operationId);
    const response = parseWalletOperationResponse(value);
    return Object.freeze({
      ...response,
      operation: walletOperationConfirmationContract.parseBoundSuccess(
        input,
        { operationId: id, interactionInterface: "cli" },
        response.operation,
      ),
    });
  },
});

const tokenOperationId = (input: Readonly<{ operationId: OperationId }>): OperationId =>
  tokenCatalogOperationIdSchema.parse(input.operationId);

const tokenStartLocalIdentity = <Input>(input: Readonly<{
  kind: TokenCatalogOperationKind;
  interactionInterface: "cli" | "web";
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
  recoveryRequest: (operationId) => ({
    method: "GET",
    path: tokenCatalogControlRoutes.operation(operationId),
  }),
  parseRecoveryResponse: (publicInput, operationId, value) => {
    const operationResult = tokenCatalogApplicationContracts.operation.parsePublicSuccess(
      { operationId: requiredOperationId(operationId) },
      value,
    );
    return input.contract.parseBoundSuccess(
      publicInput,
      {
        operationId: requiredOperationId(operationId),
        interactionInterface: input.interactionInterface,
      },
      { operation: operationResult.operation },
    ) as TokenCatalogOperationStartResult;
  },
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
  recoveryRequest: (operationId) => ({
    method: "GET",
    path: tokenCatalogControlRoutes.operation(operationId),
  }),
  parseRecoveryResponse: (input, _operationId, value) => {
    const result = tokenCatalogApplicationContracts.operation.parsePublicSuccess(input, value);
    if (result.operation.state !== "cancelled") {
      throw new TypeError("The exact operation does not prove cancellation.");
    }
    return tokenCatalogApplicationContracts.cancelOperation.parsePublicSuccess(input, result);
  },
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
  recoveryRequest: (operationId) => ({
    method: "GET",
    path: tokenCatalogControlRoutes.operation(operationId),
  }),
  parseRecoveryResponse: (input, operationId, value) => {
    const result = tokenCatalogApplicationContracts.operation.parsePublicSuccess(input, value);
    return tokenCatalogOperationConfirmationContract.parseBoundSuccess(
      input,
      { operationId: requiredOperationId(operationId), interactionInterface: "cli" },
      result.operation,
    );
  },
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

const tokenStartIdentities = (interactionInterface: "cli" | "web") => Object.freeze({
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
    operation: walletOperationReadIdentity(true),
    cancel: walletCancelLocalIdentity,
    confirm: walletConfirmationLocalIdentity,
  }),
  mcp: Object.freeze({
    connect: walletStartLocalIdentity("connect", "web"),
    disconnect: walletStartLocalIdentity("disconnect", "web"),
    operation: walletOperationReadIdentity(false),
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
