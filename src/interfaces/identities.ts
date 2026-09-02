import {
  accountBalanceCapability,
  CapabilityRegistry,
  captureCanonicalJson,
  chainStatusCapability,
  compareCodePointSequences,
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  readBoundaryFailureCodes,
  transactionInspectCapability,
  walletConnectionCapability,
  type AnyReadCapabilityDefinition,
  type CapabilityData,
  type CapabilitySuccess,
} from "../core/index.js";
import { chainErrorRegistry, chainInterfaceErrorMappings } from "../chain/errors.js";
import {
  accountAssetApplicationContracts,
  accountAssetCollectionRequestBody,
  accountAssetControlRoutes,
  accountAssetInterfaceErrorMappings,
  type AccountAssetCollectionSuccess,
  type AnyAccountAssetApplicationContract,
} from "../account-assets/index.js";
import {
  stockTokenTradeHistoryCapability,
  stockTokenTradeHistoryErrorRegistry,
  stockTokenTradeHistoryInterfaceErrorMappings,
} from "../stock-token-trade-history/index.js";
import {
  uniswapV2ErrorRegistry,
  uniswapV2InterfaceErrorMappings,
  uniswapV2QuoteCapability,
} from "../protocols/uniswap-v2/index.js";
import {
  tokenCatalogApplicationContracts,
  tokenCatalogControlRoutes,
  tokenCatalogErrorRegistry,
  tokenCatalogInterfaceErrorMappings,
  tokenInspectCapability,
  tokenSelectionListRequestBody,
  type AnyTokenCatalogApplicationContract,
  type TokenSelectionDetail,
  type TokenSelectionInput,
  type TokenSelectionListResult,
} from "../token-catalog/index.js";
import { walletErrorRegistry, walletInterfaceErrorMappings } from "../wallet/errors.js";
import type { CanonicalDispatchAuthority } from "./http-client.js";
import { stockTokenTradeHistoryHumanSummary } from
  "./stock-token-trade-history-presentation.js";
import {
  createLocalOperationIdentity,
} from "./local-operation.js";
import { presentationMcpTools } from "./mcp-app/contracts.js";
import {
  operationCliCommandIdentities,
  operationMcpToolNames,
  type OperationToolAnnotations,
} from "./operation-bindings.js";

export const publicInspectionPaths = Object.freeze({
  contractQueries: "/api/v1/contract-inspections",
  tokenQueries: "/api/v1/token-inspections",
} as const);

export const stockTokenTradeHistoryPublicRoute =
  "/api/v1/stock-token-trade-history-queries" as const;

export const uniswapV2PublicRoutes = Object.freeze({
  exactInputQuotes: "/api/v1/uniswap-v2-exact-input-quotes",
} as const);

export type InterfaceToolAnnotations = OperationToolAnnotations;

export interface CliInterfaceIdentity {
  readonly domain: "market" | "read" | "token" | "uniswap-v2" | "wallet";
  readonly command: string;
  readonly argumentSyntax: string;
}

export interface ReadInterfaceIdentity<
  Definition extends AnyReadCapabilityDefinition = AnyReadCapabilityDefinition,
> {
  readonly definition: Definition;
  readonly capabilityId: ReturnType<typeof getCapabilityDefinitionSnapshot>["capabilityId"];
  readonly http: Readonly<{ method: "GET" | "POST"; path: string }>;
  readonly mcp: Readonly<{
    name: string;
    description: string;
    annotations: InterfaceToolAnnotations;
  }>;
  readonly cli: Readonly<CliInterfaceIdentity>;
  readonly responseAuthority: CanonicalDispatchAuthority;
  readonly projectSuccessText?: (
    success: CapabilitySuccess<CapabilityData<Definition>>,
  ) => string;
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
const stockTokenTradeHistoryResponseAuthority = Object.freeze({
  applicationErrors: stockTokenTradeHistoryErrorRegistry,
  interfaceMappings: stockTokenTradeHistoryInterfaceErrorMappings,
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
  readonly projectSuccessText?: (
    success: CapabilitySuccess<CapabilityData<Definition>>,
  ) => string;
}): ReadInterfaceIdentity<Definition> => Object.freeze({
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
  ...(input.projectSuccessText === undefined
    ? {}
    : { projectSuccessText: input.projectSuccessText }),
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

export const stockTokenTradeHistoryInterface = identity({
  definition: stockTokenTradeHistoryCapability,
  http: { method: "POST", path: stockTokenTradeHistoryPublicRoute },
  mcp: {
    name: "market_get_stock_token_trade_history",
    description: "Read finalized Stock Token/USDG trades for one requested period. A partial position with a candle retains the full stored natural interval and may include activity outside represented request bounds; only a complete position with no candle establishes no qualifying Swap.",
    openWorldHint: true,
  },
  cli: {
    domain: "market",
    command: "stock-token-trade-history",
    argumentSyntax: "<symbol> [--period <count> --unit <day|week|month|year>] [--json]",
  },
  responseAuthority: stockTokenTradeHistoryResponseAuthority,
  projectSuccessText: (success) => stockTokenTradeHistoryHumanSummary(success.data),
});

export const readInterfaceIdentities = Object.freeze([
  accountBalanceInterface,
  chainStatusInterface,
  contractInspectInterface,
  stockTokenTradeHistoryInterface,
  tokenInspectInterface,
  transactionInspectInterface,
  uniswapV2QuoteInterface,
  walletConnectionInterface,
].sort((left, right) => compareCodePointSequences(left.capabilityId, right.capabilityId)));

export const interfaceReadCapabilityRegistry = new CapabilityRegistry(
  readInterfaceIdentities.map((entry) => entry.definition),
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
      argumentSyntax: "[--limit <1..5>] [--cursor <cursor-json>] [--json]",
    }),
  }),
  exact: Object.freeze({
    action: "get",
    contract: accountAssetApplicationContracts.exact,
    responseAuthority: accountAssetResponseAuthority,
  }),
});

export const accountAssetInterfaceBindingList: readonly AccountAssetInterfaceBinding[] =
  Object.freeze(Object.values(accountAssetInterfaceBindings));

export interface TokenCatalogInterfaceBinding {
  readonly action: "get" | "list";
  readonly contract: AnyTokenCatalogApplicationContract;
  readonly mcp: Readonly<{
    readonly name: string;
    readonly description: string;
    readonly annotations: InterfaceToolAnnotations;
  }>;
  readonly cli: Readonly<CliInterfaceIdentity>;
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
});

export const tokenCatalogInterfaceBindingList: readonly TokenCatalogInterfaceBinding[] =
  Object.freeze(Object.values(tokenCatalogInterfaceBindings)
    .sort((left, right) => compareCodePointSequences(
      left.contract.capabilityId,
      right.contract.capabilityId,
    )));

const tokenSelectionReadIdentity = createLocalOperationIdentity<
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

const tokenSelectionsReadIdentity = createLocalOperationIdentity<
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
    body: captureCanonicalJson(tokenSelectionListRequestBody(input)),
  }),
  parseActionResponse: (input, _operationId, value) =>
    tokenCatalogApplicationContracts.selections.parsePublicSuccess(input, value),
});

const accountAssetCollectionReadIdentity = createLocalOperationIdentity<
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

export const tokenLocalReadIdentities = Object.freeze({
  selection: tokenSelectionReadIdentity,
  selections: tokenSelectionsReadIdentity,
});

export const accountAssetLocalOperationIdentities = Object.freeze({
  collection: accountAssetCollectionReadIdentity,
});

export const declaredCliCommandIdentities: readonly CliInterfaceIdentity[] = Object.freeze([
  ...accountAssetInterfaceBindingList.flatMap((entry) => entry.cli === undefined ? [] : [entry.cli]),
  ...readInterfaceIdentities.map((entry) => entry.cli),
  ...tokenCatalogInterfaceBindingList.map((entry) => entry.cli),
  ...operationCliCommandIdentities,
].sort((left, right) => compareCodePointSequences(
  `${left.domain}\0${left.command}`,
  `${right.domain}\0${right.command}`,
)));

const cliExecutableName = "littlejohn" as const;

const cliUsage = (entry: CliInterfaceIdentity): string =>
  `${cliExecutableName} ${entry.domain} ${entry.command}${
    entry.argumentSyntax.length === 0 ? "" : ` ${entry.argumentSyntax}`
  }`;

export const cliHelpText = [
  "Usage:",
  ...declaredCliCommandIdentities.map((entry) => `  ${cliUsage(entry)}`),
  `  ${cliExecutableName} --help`,
  "",
].join("\n");

export const declaredMcpToolNames = Object.freeze([
  ...accountAssetInterfaceBindingList.flatMap((entry) => entry.mcp === undefined ? [] : [entry.mcp.name]),
  ...readInterfaceIdentities.map((entry) => entry.mcp.name),
  ...tokenCatalogInterfaceBindingList.map((entry) => entry.mcp.name),
  capabilityCatalogInterface.mcp.name,
  ...Object.values(presentationMcpTools),
  ...operationMcpToolNames,
].sort(compareCodePointSequences));
