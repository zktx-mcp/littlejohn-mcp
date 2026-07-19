import {
  accountBalanceCapability,
  CapabilityRegistry,
  chainStatusCapability,
  compareCodePointSequences,
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  readCapabilityCommonFailureCodes,
  transactionInspectCapability,
  walletConnectionCapability,
  type AnyReadCapabilityDefinition,
} from "../core/index.js";
import {
  tokenCatalogApplicationContracts,
  tokenInspectCapability,
  type TokenCatalogOperationKind,
  type AnyTokenCatalogApplicationContract,
} from "../token-catalog/index.js";
import {
  walletManagementContracts,
  type AnyWalletManagementContract,
} from "../wallet/management-contracts.js";
import type { WalletOperationKind } from "../wallet/operation-state.js";
import { walletControlRoutes } from "../wallet/routes.js";

export interface InterfaceToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface CliInterfaceIdentity {
  readonly domain: "read" | "token" | "wallet";
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
  readonly web?: true;
}

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
  failureCodes: readCapabilityCommonFailureCodes,
  http: Object.freeze({ method: "GET" as const, path: "/api/v1/capabilities" }),
  mcp: Object.freeze({
    name: "read_list_capabilities",
    description: "List the canonical read capability catalog.",
    annotations: readAnnotations(false),
  }),
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

const tokenCatalogBinding = <const Binding extends TokenCatalogInterfaceBinding>(
  input: Binding,
): Readonly<Binding> => Object.freeze({
  ...input,
  contract: input.contract,
  mcp: Object.freeze(input.mcp),
  cli: Object.freeze(input.cli),
}) as Readonly<Binding>;

export const tokenCatalogInterfaceBindings = Object.freeze({
  registration: tokenCatalogBinding({
    action: "get",
    contract: tokenCatalogApplicationContracts.registration,
    mcp: {
      name: "token_get_registration",
      description: "Read one token registration for the current wallet account.",
      annotations: readAnnotations(false),
    },
    cli: { domain: "token", command: "get", argumentSyntax: "<token-address> [--json]" },
    web: true,
  }),
  registrations: tokenCatalogBinding({
    action: "list",
    contract: tokenCatalogApplicationContracts.registrations,
    mcp: {
      name: "token_list_registrations",
      description: "List token registrations for the current wallet account.",
      annotations: readAnnotations(false),
    },
    cli: {
      domain: "token",
      command: "list",
      argumentSyntax: "[--limit <1..25>] [--cursor <token-address>] [--json]",
    },
    web: true,
  }),
  startRegistration: tokenCatalogBinding({
    action: "start",
    contract: tokenCatalogApplicationContracts.startRegistration,
    mcp: {
      name: "token_start_registration",
      description: "Start a token registration operation for local browser confirmation.",
      annotations: startAnnotations(true),
    },
    cli: {
      domain: "token",
      command: "register",
      argumentSyntax: "<token-address> [--label <text>] [--visibility <visible|hidden>]",
    },
    operationKind: "register",
    web: true,
  }),
  startRegistrationUpdate: tokenCatalogBinding({
    action: "start",
    contract: tokenCatalogApplicationContracts.startRegistrationUpdate,
    mcp: {
      name: "token_start_registration_update",
      description: "Start a token registration settings update for local browser confirmation.",
      annotations: startAnnotations(false),
    },
    cli: {
      domain: "token",
      command: "update",
      argumentSyntax: "<token-address> --revision <revision> [--label <text> | --clear-label] [--visibility <visible|hidden>]",
    },
    operationKind: "update_registration",
    web: true,
  }),
  startUnregistration: tokenCatalogBinding({
    action: "start",
    contract: tokenCatalogApplicationContracts.startUnregistration,
    mcp: {
      name: "token_start_unregistration",
      description: "Start token removal for local browser confirmation.",
      annotations: startAnnotations(false),
    },
    cli: {
      domain: "token",
      command: "unregister",
      argumentSyntax: "<token-address> --revision <revision>",
    },
    operationKind: "unregister",
    web: true,
  }),
  operation: tokenCatalogBinding({
    action: "get_operation",
    contract: tokenCatalogApplicationContracts.operation,
    mcp: {
      name: "token_get_operation",
      description: "Read one retained token catalog operation.",
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
      description: "Cancel one cancellable token catalog operation.",
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

export const declaredCliCommandIdentities = Object.freeze([
  ...readInterfaceIdentities.map((identity) => identity.cli),
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
  ...readInterfaceIdentities.map((entry) => entry.mcp.name),
  ...tokenCatalogInterfaceBindingList.map((binding) => binding.mcp.name),
  capabilityCatalogInterface.mcp.name,
  ...walletInterfaceBindingList.flatMap((binding) =>
    binding.mcp === undefined ? [] : [binding.mcp.name]),
].sort(compareCodePointSequences));
