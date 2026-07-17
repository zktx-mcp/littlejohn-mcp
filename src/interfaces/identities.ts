import {
  accountBalanceCapability,
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
  readonly domain: "read" | "wallet";
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

export const readInterfaceIdentities = Object.freeze([
  accountBalanceInterface,
  chainStatusInterface,
  contractInspectInterface,
  transactionInspectInterface,
  walletConnectionInterface,
]);

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
  chainStatusInterface.cli,
  contractInspectInterface.cli,
  transactionInspectInterface.cli,
  accountBalanceInterface.cli,
  walletConnectionInterface.cli,
  ...walletInterfaceBindingList.flatMap((binding) =>
    binding.cli === undefined ? [] : [binding.cli]),
]);

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
  capabilityCatalogInterface.mcp.name,
  ...walletInterfaceBindingList.flatMap((binding) =>
    binding.mcp === undefined ? [] : [binding.mcp.name]),
].sort(compareCodePointSequences));
