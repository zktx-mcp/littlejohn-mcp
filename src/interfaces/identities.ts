import {
  accountBalanceCapability,
  capabilityIdSchema,
  chainStatusCapability,
  compareCodePointSequences,
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  transactionInspectCapability,
  walletConnectionCapability,
  type AnyReadCapabilityDefinition,
  type CapabilityId,
} from "../core/index.js";
import { walletManagementCapabilityIds } from "../wallet/contracts.js";
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
}): ReadInterfaceIdentity => Object.freeze({
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
  http: Object.freeze({ method: "GET" as const, path: "/api/v1/capabilities" }),
  mcp: Object.freeze({
    name: "read_list_capabilities",
    description: "List the canonical read capability catalog.",
    annotations: readAnnotations(false),
  }),
});

interface WalletToolInterfaceIdentity {
  readonly capabilityId: CapabilityId;
  readonly name: string;
  readonly description: string;
  readonly annotations: InterfaceToolAnnotations;
  readonly http: Readonly<{
    readonly method: "GET" | "POST" | "DELETE";
    readonly path: string | ((operationId: string) => string);
  }>;
  readonly cli: Readonly<CliInterfaceIdentity>;
  readonly operationKind?: "connect" | "disconnect";
}

const walletToolIdentity = (input: Omit<WalletToolInterfaceIdentity, "capabilityId"> & {
  readonly capabilityId: string;
}): WalletToolInterfaceIdentity => Object.freeze({
  ...input,
  capabilityId: capabilityIdSchema.parse(input.capabilityId),
  http: Object.freeze(input.http),
  cli: Object.freeze(input.cli),
});

const startAnnotations = (openWorldHint: boolean): InterfaceToolAnnotations => Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint,
});

export const walletToolInterfaces = Object.freeze({
  startConnection: walletToolIdentity({
    capabilityId: walletManagementCapabilityIds.connect,
    name: "wallet_start_connection",
    description: "Start a Robinhood Wallet connection operation for local browser review.",
    annotations: startAnnotations(true),
    http: { method: "POST", path: walletControlRoutes.operations },
    cli: { domain: "wallet", command: "connect", argumentSyntax: "" },
    operationKind: "connect",
  }),
  startDisconnection: walletToolIdentity({
    capabilityId: walletManagementCapabilityIds.disconnect,
    name: "wallet_start_disconnection",
    description: "Start a Robinhood Wallet disconnection operation for local browser review.",
    annotations: startAnnotations(false),
    http: { method: "POST", path: walletControlRoutes.operations },
    cli: { domain: "wallet", command: "disconnect", argumentSyntax: "" },
    operationKind: "disconnect",
  }),
  getOperation: walletToolIdentity({
    capabilityId: walletManagementCapabilityIds.operation,
    name: "wallet_get_operation",
    description: "Read one retained wallet management operation.",
    annotations: readAnnotations(false),
    http: { method: "GET", path: walletControlRoutes.operation },
    cli: { domain: "wallet", command: "operation", argumentSyntax: "<operation-id> [--json]" },
  }),
  cancelOperation: walletToolIdentity({
    capabilityId: walletManagementCapabilityIds.cancelOperation,
    name: "wallet_cancel_operation",
    description: "Cancel one cancellable wallet management operation.",
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    }),
    http: { method: "DELETE", path: walletControlRoutes.operation },
    cli: { domain: "wallet", command: "cancel", argumentSyntax: "<operation-id>" },
  }),
});

export const declaredCliCommandIdentities = Object.freeze([
  chainStatusInterface.cli,
  contractInspectInterface.cli,
  transactionInspectInterface.cli,
  accountBalanceInterface.cli,
  walletConnectionInterface.cli,
  walletToolInterfaces.startConnection.cli,
  walletToolInterfaces.startDisconnection.cli,
  walletToolInterfaces.getOperation.cli,
  walletToolInterfaces.cancelOperation.cli,
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
  walletToolInterfaces.startConnection.name,
  walletToolInterfaces.startDisconnection.name,
  walletToolInterfaces.getOperation.name,
  walletToolInterfaces.cancelOperation.name,
].sort(compareCodePointSequences));
