import { exchangeBindings, activityBindings, exchangeCliIdentities } from "./exchange-bindings.js";
import { signingBindings, signingCliIdentities } from "./signing-bindings.js";
import { uniswapV4PoolsCapability } from "../protocols/uniswap-v4/pools.js";
import { officialAssetErrorRegistry } from "../registry/error-registry.js";
import { officialAssetInterfaceErrorMappings } from "../registry/errors.js";
import { uniswapV2InterfaceErrorMappings } from "../protocols/uniswap-v2/errors.js";
import { uniswapV2ErrorRegistry } from "../protocols/uniswap-v2/errors.js";
import {
  accountBalanceCapability,
  addressInspectCapability,
  CapabilityRegistry,
  captureCanonicalJson,
  parseCapabilityInput, parseCapabilitySuccess, applicationFailureSchemaFor,
  chainStatusCapability,
  compareCodePointSequences,
  getCapabilityDefinitionSnapshot,
  readBoundaryFailureCodes,
  transactionInspectCapability,
  walletConnectionCapability,
  type AnyReadCapabilityDefinition,
  type CapabilityData,
  type CapabilitySuccess,
} from "../core/index.js";
import { chainInterfaceErrorMappings } from "../chain/error-mappings.js";
import {
  chainErrorRegistry,
} from "../chain/error-registry.js";
import {
  accountAssetApplicationContracts,
  type AccountAssetCollectionSuccess,
  type AnyAccountAssetApplicationContract,
} from "../account-assets/client.js";
import {
  accountAssetCollectionRequestBody,
  accountAssetControlRoutes,
} from "../account-assets/client.js";
import { accountAssetInterfaceErrorMappings } from "../account-assets/error-mappings.js";
import {
  stockTokenTradeHistoryCapability,
  stockTokenTradeHistoryErrorRegistry,
} from "../stock-token-trade-history/contracts.js";
import { stockTokenPricesCapability, stockTokensCapability, stockTokenPricesErrorRegistry } from "../stock-token-prices/contracts.js";
import { stockTokenPricesInterfaceErrorMappings } from "../stock-token-prices/errors.js";
import { stockTokenPricesHumanSummary, stockTokensHumanSummary } from "./stock-token-price-presentation.js";
import {
  stockTokenTradeHistoryInterfaceErrorMappings,
} from "../stock-token-trade-history/errors.js";
import {
  uniswapV2QuoteCapability,
} from "../protocols/uniswap-v2/client.js";
import {
  tokenCatalogApplicationContracts,
  tokenInspectCapability,
  type AnyTokenCatalogApplicationContract,
  type TokenSelectionDetail,
  type TokenSelectionInput,
  type TokenSelectionListResult,
} from "../token-catalog/client.js";
import {
  tokenCatalogControlRoutes,
  tokenSelectionListRequestBody,
  tokenSelectionRequestBody,
} from "../token-catalog/client.js";
import {
  tokenCatalogErrorRegistry,
  tokenCatalogInterfaceErrorMappings,
} from "../token-catalog/errors.js";
import { walletErrorRegistry, walletInterfaceErrorMappings } from "../wallet/errors.js";
import type { CanonicalDispatchAuthority } from "./http-client.js";
import type { CapabilityCatalog } from "../runtime/support-manifest.js";
import { stockTokenTradeHistoryHumanSummary } from
  "./stock-token-trade-history-presentation.js";
import {
  createLocalOperationIdentity,
} from "./local-operation.js";
import { presentationMcpTools } from "./mcp-app/contracts.js";
import { cardToolContracts, cardReadStartTool } from "./mcp-app/card-tool-contracts.js";
import {
  operationCliCommandIdentities,
  operationMcpToolNames,
  type OperationToolAnnotations,
} from "./operation-bindings.js";

export const publicInspectionPaths = Object.freeze({
  addressQueries: "/api/v1/address-inspections",
  tokenQueries: "/api/v1/token-inspections",
} as const);

export const stockTokenTradeHistoryPublicRoute =
  "/api/v1/stock-token-trade-history-queries" as const;

export const uniswapV2PublicRoutes = Object.freeze({
  exactInputQuotes: "/api/v1/uniswap-v2-exact-input-quotes",
} as const);

export type InterfaceToolAnnotations = OperationToolAnnotations;

export interface CliInterfaceIdentity {
  readonly domain: "market" | "read" | "token" | "uniswap-v2" | "uniswap-v4" | "wallet" | "exchange" | "activity" | "signing";
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

export const addressInspectInterface = identity({
  definition: addressInspectCapability,
  http: { method: "POST", path: publicInspectionPaths.addressQueries },
  mcp: {
    name: "read_inspect_address",
    description: "Inspect address runtime code at one Robinhood Chain block.",
    openWorldHint: true,
  },
  cli: {
    domain: "read",
    command: "address",
    argumentSyntax: "(<address> | --active) --block <latest|block-number> [--json]",
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

export const uniswapV4PoolsInterface: ReadInterfaceIdentity<typeof uniswapV4PoolsCapability> = Object.freeze({
  definition: uniswapV4PoolsCapability, capabilityId: getCapabilityDefinitionSnapshot(uniswapV4PoolsCapability).capabilityId,
  http: { method: "POST" as const, path: "/api/v1/internal/control/uniswap-v4/pool-queries" },
  mcp: { name: "uniswap_v4_list_pools", description: "Refresh official asset membership and list the packaged USDG pool candidates. This does not establish current liquidity or execution.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  cli: { domain: "uniswap-v4" as const, command: "list-pools", argumentSyntax: "<stock-token-address> [--json]" },
  responseAuthority: { applicationErrors: officialAssetErrorRegistry, interfaceMappings: officialAssetInterfaceErrorMappings },
});
const poolsFailureSchema = applicationFailureSchemaFor(officialAssetErrorRegistry, getCapabilityDefinitionSnapshot(uniswapV4PoolsCapability).failureCodes);
export const uniswapV4PoolsLocalIdentity = createLocalOperationIdentity({ action: "read",
  contract: { errorRegistry: officialAssetErrorRegistry, parseInput: (value: unknown) => parseCapabilityInput(uniswapV4PoolsCapability, value),
    normalizeFailure: (value: unknown) => poolsFailureSchema.parse(value) },
  errorMappings: officialAssetInterfaceErrorMappings, operationId: () => undefined,
  actionRequest: (input) => ({ method: "POST", path: uniswapV4PoolsInterface.http.path, body: captureCanonicalJson(input) }),
  parseActionResponse: (input, _operation, value) => parseCapabilitySuccess(uniswapV4PoolsCapability, input, value),
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

const stockTokenPriceResponseAuthority = Object.freeze({
  applicationErrors: stockTokenPricesErrorRegistry, interfaceMappings: stockTokenPricesInterfaceErrorMappings,
});
export const stockTokenPricesInterface = identity({
  definition: stockTokenPricesCapability,
  http: { method: "POST", path: "/api/v1/stock-token-price-queries" },
  mcp: { name: "market_get_stock_token_prices",
    description: "Read current on-chain Stock Token/USDG pool spot prices and fees for the returned candidates. Supply a symbol or exact token address. This is not every pool, a USD valuation, an execution quote or a best-price selection.", openWorldHint: true },
  cli: { domain: "market", command: "stock-token-prices", argumentSyntax: "(<symbol> | --token <address>) [--json]" },
  responseAuthority: stockTokenPriceResponseAuthority,
  projectSuccessText: (success) => stockTokenPricesHumanSummary(success.data),
});
export const stockTokensInterface = identity({
  definition: stockTokensCapability, http: { method: "GET", path: "/api/v1/stock-tokens" },
  mcp: { name: "market_list_stock_tokens", description: "List the current official Stock Token catalog. Membership does not establish a USDG pool or current price.", openWorldHint: true },
  cli: { domain: "market", command: "stock-tokens", argumentSyntax: "[--json]" },
  responseAuthority: stockTokenPriceResponseAuthority,
  projectSuccessText: (success) => stockTokensHumanSummary(success.data),
});

export const readInterfaceIdentities = Object.freeze([
  accountBalanceInterface,
  addressInspectInterface,
  chainStatusInterface,
  stockTokenTradeHistoryInterface,
  stockTokenPricesInterface,
  stockTokensInterface,
  tokenInspectInterface,
  transactionInspectInterface,
  uniswapV2QuoteInterface,
  walletConnectionInterface,
].sort((left, right) => compareCodePointSequences(left.capabilityId, right.capabilityId)));

export const interfaceReadCapabilityRegistry = new CapabilityRegistry(
  [...readInterfaceIdentities.map((entry) => entry.definition), uniswapV4PoolsCapability],
);

export const capabilityCatalogInterface = Object.freeze({
  projectSuccessText: (catalog: CapabilityCatalog): string => [
    "Read capabilities:",
    ...catalog.capabilities.map((entry) => `${entry.capabilityId}: ${entry.availability.overall}`),
  ].join("\n"),
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
  readonly action: "list";
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
      description: "List native and selected-token assets for one selected account. A first page replaces the bounded Official Asset snapshot and may initialize defaults for an already retained account.",
      annotations: Object.freeze({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      }),
    }),
    cli: Object.freeze({
      domain: "read",
      command: "assets",
      argumentSyntax: "(--address <address> | --active) [--limit <1..5>] [--cursor <cursor-json>] [--json]",
    }),
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
      description: "Read one token selection for the selected account.",
      annotations: readAnnotations(false),
    },
    cli: { domain: "token", command: "get", argumentSyntax: "<token-address> (--address <address> | --active) [--json]" },
  }),
  selections: tokenCatalogBinding({
    action: "list",
    contract: tokenCatalogApplicationContracts.selections,
    mcp: {
      name: "token_list_selections",
      description: "List token selections for the selected account.",
      annotations: readAnnotations(false),
    },
    cli: {
      domain: "token",
      command: "list",
      argumentSyntax: "(--address <address> | --active) [--limit <1..25>] [--cursor <token-address>] [--json]",
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
    method: "POST",
    path: tokenCatalogControlRoutes.selectionQueries,
    body: captureCanonicalJson(tokenSelectionRequestBody(input)),
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
    path: tokenCatalogControlRoutes.selectionListQueries,
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
  uniswapV4PoolsInterface.cli,
  ...tokenCatalogInterfaceBindingList.map((entry) => entry.cli),
  ...operationCliCommandIdentities,
  ...exchangeCliIdentities,
  ...signingCliIdentities,
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
  uniswapV4PoolsInterface.mcp.name,
  ...tokenCatalogInterfaceBindingList.map((entry) => entry.mcp.name),
  capabilityCatalogInterface.mcp.name,
  ...Object.values(presentationMcpTools),
  ...Object.values(cardToolContracts).map((entry) => entry.mcp.name),
  cardReadStartTool.mcp.name,
  ...operationMcpToolNames,
  ...Object.values(exchangeBindings).map((entry) => entry.mcp.name),
  ...Object.values(activityBindings).map((entry) => entry.mcp.name),
  ...Object.values(signingBindings).map((entry) => entry.mcp.name),
].sort(compareCodePointSequences));
