import { uniswapV4PoolsCapability } from "../protocols/uniswap-v4/pools.js";
import { officialAssetInterfaceErrorMappings } from "../registry/errors.js";
import { stockTokenPricesInterfaceErrorMappings } from "../stock-token-prices/errors.js";
import type { CapabilityBinding } from "../core/index.js";
import { uniswapV2InterfaceErrorMappings } from "../protocols/uniswap-v2/errors.js";
import {
  CapabilityBindingRegistry,
  captureCanonicalJson,
  type AnyReadCapabilityDefinition,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import { chainInterfaceErrorMappings } from "../chain/error-mappings.js";
import {
  tokenCatalogInterfaceErrorMappings,
} from "../token-catalog/errors.js";
import { walletInterfaceErrorMappings } from "../wallet/errors.js";
import { uniswapV2QuoteCapability } from "../protocols/uniswap-v2/client.js";
import type {
  ChainReadCapabilityPort,
  WalletConnectionReadCapabilityPort,
} from "../runtime/application-context.js";
import type {
  TokenCatalogInspectionPort,
} from "../token-catalog/ports.js";
import {
  stockTokenTradeHistoryInterfaceErrorMappings,
} from "../stock-token-trade-history/errors.js";
import {
  type StockTokenTradeHistoryReadCapabilityPort,
} from "../stock-token-trade-history/ports.js";
import type { InterfaceRuntimeSupportManifest } from "../runtime/support-manifest.js";
import type { StockTokenPriceReadPort } from "../stock-token-prices/ports.js";
import type {
  RouteContext,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/http-routing.js";
import {
  accountBalanceInterface,
  addressInspectInterface,
  capabilityCatalogInterface,
  chainStatusInterface,
  interfaceReadCapabilityRegistry,
  stockTokenTradeHistoryInterface,
  stockTokenPricesInterface, stockTokensInterface,
  tokenInspectInterface,
  transactionInspectInterface,
  type ReadInterfaceIdentity,
  uniswapV2QuoteInterface,
  uniswapV4PoolsInterface,
  walletConnectionInterface,
} from "./identities.js";
import { composeInterfaceCapabilityCatalog } from "./support.js";

export const publicInterfaceRoutes = Object.freeze({
  accountBalanceQueries: accountBalanceInterface.http.path,
  addressInspections: addressInspectInterface.http.path,
  capabilities: capabilityCatalogInterface.http.path,
  chainStatus: chainStatusInterface.http.path,
  tokenInspections: tokenInspectInterface.http.path,
  transactionInspections: transactionInspectInterface.http.path,
  stockTokenTradeHistoryQueries: stockTokenTradeHistoryInterface.http.path,
  stockTokenPriceQueries: stockTokenPricesInterface.http.path,
  stockTokens: stockTokensInterface.http.path,
  uniswapV2ExactInputQuotes: uniswapV2QuoteInterface.http.path,
  walletConnection: walletConnectionInterface.http.path,
});

const success = (body: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(body) });
const failure = (applicationFailure: ApplicationFailure): RouteResult => ({
  ok: false,
  failure: applicationFailure,
});

const invoke = async (
  bindings: CapabilityBindingRegistry,
  definition: AnyReadCapabilityDefinition,
  context: RouteContext,
): Promise<RouteResult> => {
  const result = await bindings.invoke(definition, context.body, { signal: context.signal });
  return result.ok ? success(result) : failure(result);
};

const readRoutes = (
  bindings: CapabilityBindingRegistry,
  identities: readonly ReadInterfaceIdentity[],
) => identities.map((identity) => ({
  method: identity.http.method,
  mutation: "none" as const,
  pathPattern: identity.http.path,
  successStatus: 200 as const,
  handler: (context: RouteContext) => invoke(bindings, identity.definition, context),
}));

export const createPublicReadBindings = (input: {
  readonly chainReads: ChainReadCapabilityPort;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly uniswapV2Quote: CapabilityBinding<typeof uniswapV2QuoteCapability>;
  readonly uniswapV4Pools: CapabilityBinding<typeof uniswapV4PoolsCapability>;
  readonly tradeHistory: StockTokenTradeHistoryReadCapabilityPort;
  readonly prices: StockTokenPriceReadPort;
}): CapabilityBindingRegistry => new CapabilityBindingRegistry(interfaceReadCapabilityRegistry, [
    input.chainReads.accountBalance,
    input.chainReads.addressInspect,
    input.chainReads.chainStatus,
    input.tokenInspection,
    input.chainReads.transactionInspect,
    input.tradeHistory.binding,
    input.prices.prices,
    input.prices.tokens,
    input.uniswapV2Quote,
    input.uniswapV4Pools,
    input.walletConnection.connection,
  ]);

export const extendPublicInterfaceRoutes = (input: {
  readonly routes: RuntimeRouteRegistry;
  readonly bindings: CapabilityBindingRegistry;
  readonly supportManifest: InterfaceRuntimeSupportManifest;
}): RuntimeRouteRegistry => {
  const bindings = input.bindings;
  const catalog = composeInterfaceCapabilityCatalog(input.supportManifest);

  const walletRoutes = input.routes.extend(
    readRoutes(bindings, [walletConnectionInterface]),
    walletInterfaceErrorMappings,
  );
  const chainRoutes = walletRoutes.extend(readRoutes(bindings, [
    accountBalanceInterface,
    addressInspectInterface,
    chainStatusInterface,
    transactionInspectInterface,
  ]), chainInterfaceErrorMappings);
  const tokenRoutes = chainRoutes.extend([
    ...readRoutes(bindings, [tokenInspectInterface]),
    {
      method: capabilityCatalogInterface.http.method,
      mutation: "none",
      pathPattern: capabilityCatalogInterface.http.path,
      successStatus: 200,
      handler: async () => success(catalog as unknown as CanonicalJson),
    },
  ], tokenCatalogInterfaceErrorMappings);
  const protocolRoutes = tokenRoutes.extend(
    readRoutes(bindings, [uniswapV2QuoteInterface]),
    uniswapV2InterfaceErrorMappings,
  );
  const nativeRoutes = protocolRoutes.extend([{ method: "POST", mutation: "declared_control", pathPattern: uniswapV4PoolsInterface.http.path,
    successStatus: 200, handler: (context) => invoke(bindings, uniswapV4PoolsCapability, context) }], officialAssetInterfaceErrorMappings);
  return nativeRoutes.extend(
    readRoutes(bindings, [stockTokenTradeHistoryInterface, stockTokensInterface]),
    stockTokenTradeHistoryInterfaceErrorMappings,
  ).extend(
    readRoutes(bindings, [stockTokenPricesInterface]),
    stockTokenPricesInterfaceErrorMappings,
  );
};
