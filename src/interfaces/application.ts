import { extendExchangeRoutes } from "./exchange-routes.js";
import type { ExchangeApplicationPort } from "../review/application-contracts.js";
import type { ReceiptActivityPort } from "../receipt-activity/application-contracts.js";
import type { ReviewPresentationSource } from "../runtime/presentation-snapshot.js";
import type { uniswapV4PoolsCapability } from "../protocols/uniswap-v4/pools.js";
import type { AccountAssetApplicationPort } from "../account-assets/index.js";
import type { CapabilityBinding } from "../core/index.js";
import type { StockTokenTradeHistoryReadCapabilityPort } from "../stock-token-trade-history/index.js";
import type { uniswapV2QuoteCapability } from "../protocols/uniswap-v2/index.js";
import type {
  ChainReadCapabilityPort,
  RuntimeApplicationContext,
  WalletConnectionReadCapabilityPort,
} from "../runtime/application-context.js";
import type { HttpOwnerApplication } from "../runtime/http-owner.js";
import type {
  InterfaceRuntimeSupportManifest,
  ProtocolRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import {
  extendTokenCatalogQueryRoutes,
  type TokenCatalogConsumerPorts,
  type TokenCatalogInspectionPort,
} from "../token-catalog/index.js";
import type { WalletManagementPort } from "../wallet/contracts.js";
import { extendPublicInterfaceRoutes } from "./http-routes.js";
import { extendOperationRoutes } from "./operation-routes.js";
import { extendInterfaceSupportManifest } from "./support.js";

export interface InterfaceOwnerApplicationContext
  extends RuntimeApplicationContext, Omit<TokenCatalogConsumerPorts, "accountTokenSelectionStore"> {
  readonly supportManifest: ProtocolRuntimeSupportManifest;
  readonly exchange: ExchangeApplicationPort;
  readonly activity: ReceiptActivityPort;
  readonly reviewPresentations: ReviewPresentationSource;
  readonly uniswapV4Pools: CapabilityBinding<typeof uniswapV4PoolsCapability>;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly walletOperations: WalletManagementPort;
  readonly chainReads: ChainReadCapabilityPort;
  readonly uniswapV2Quote: CapabilityBinding<typeof uniswapV2QuoteCapability>;
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly accountAssets: AccountAssetApplicationPort;
  readonly tradeHistory: StockTokenTradeHistoryReadCapabilityPort;
}

export interface InterfaceOwnerApplication extends HttpOwnerApplication {
  readonly supportManifest: InterfaceRuntimeSupportManifest;
}

export type InterfaceOwnerApplicationFactory = (
  context: InterfaceOwnerApplicationContext,
) => Promise<InterfaceOwnerApplication> | InterfaceOwnerApplication;

export const createInterfaceOwnerApplicationFactory = (): InterfaceOwnerApplicationFactory =>
  (context): InterfaceOwnerApplication => {
    const supportManifest = extendInterfaceSupportManifest(context.supportManifest);
    const publicRoutes = extendPublicInterfaceRoutes({
      routes: context.routes,
      chainReads: context.chainReads,
      walletConnection: context.walletConnection,
      tokenInspection: context.tokenInspection,
      uniswapV2Quote: context.uniswapV2Quote,
      uniswapV4Pools: context.uniswapV4Pools,
      tradeHistory: context.tradeHistory,
      supportManifest,
    });
    const tokenRoutes = extendTokenCatalogQueryRoutes({
      routes: publicRoutes,
      inspection: context.tokenInspection,
      queries: context.tokenCatalogQueries,
    });
    const operationRoutes = extendOperationRoutes({
      routes: tokenRoutes,
      wallet: context.walletOperations,
      token: context.tokenCatalogManagement,
    });
    const routes = extendExchangeRoutes({ routes: operationRoutes, exchange: context.exchange, activity: context.activity, presentations: context.reviewPresentations });
    return Object.freeze({
      routes,
      supportManifest,
      close: async (): Promise<void> => undefined,
    });
  };

export const createInterfaceOwnerApplication = createInterfaceOwnerApplicationFactory();
