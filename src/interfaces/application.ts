import { PresentationCardApplication } from "./mcp-app/card-application.js";
import { extendCardRoutes } from "./mcp-app/card-controls.js";
import type { PresentationCardStore } from "./mcp-app/card-contract.js";
import type { PresentationSnapshotStore } from "../runtime/presentation-snapshot.js";
import type { CanonicalClock } from "../core/index.js";
import { extendExchangeRoutes } from "./exchange-routes.js";
import { extendSigningRoutes } from "./signing-routes.js";
import { extendReviewPresentationRoutes } from "./review-presentation-routes.js";
import type { SigningApplicationPort } from "../review/signing-application-contracts.js";
import type { ExchangeApplicationPort } from "../review/application-contracts.js";
import type { ReceiptActivityPort } from "../receipt-activity/application-contracts.js";
import type { ReviewPresentationSource } from "../runtime/presentation-snapshot.js";
import type { uniswapV4PoolsCapability } from "../protocols/uniswap-v4/pools.js";
import type { AccountAssetApplicationPort } from "../account-assets/index.js";
import type { CapabilityBinding } from "../core/index.js";
import type { StockTokenTradeHistoryReadCapabilityPort } from "../stock-token-trade-history/index.js";
import type { StockTokenPriceReadPort } from "../stock-token-prices/ports.js";
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
import { extendPublicInterfaceRoutes, createPublicReadBindings } from "./http-routes.js";
import { captureCanonicalJson } from "../core/index.js";
import { stockTokenTradeHistoryCapability } from "../stock-token-trade-history/contracts.js";
import { extendOperationRoutes } from "./operation-routes.js";
import { extendInterfaceSupportManifest } from "./support.js";

export interface InterfaceOwnerApplicationContext
  extends RuntimeApplicationContext, Omit<TokenCatalogConsumerPorts, "accountTokenSelectionStore"> {
  readonly supportManifest: ProtocolRuntimeSupportManifest;
  readonly cardStore: PresentationCardStore;
  readonly snapshots: PresentationSnapshotStore;
  readonly clock: CanonicalClock;
  readonly exchange: ExchangeApplicationPort;
  readonly signing: SigningApplicationPort;
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
  readonly prices: StockTokenPriceReadPort;
}

export interface InterfaceOwnerApplication extends HttpOwnerApplication {
  readonly supportManifest: InterfaceRuntimeSupportManifest;
}

export type InterfaceOwnerApplicationFactory = (
  context: InterfaceOwnerApplicationContext,
) => Promise<InterfaceOwnerApplication> | InterfaceOwnerApplication;

export const createInterfaceOwnerApplicationFactory = (): InterfaceOwnerApplicationFactory =>
  async (context): Promise<InterfaceOwnerApplication> => {
    const supportManifest = extendInterfaceSupportManifest(context.supportManifest);
    const readBindings = createPublicReadBindings({
      chainReads: context.chainReads,
      walletConnection: context.walletConnection,
      tokenInspection: context.tokenInspection,
      uniswapV2Quote: context.uniswapV2Quote,
      uniswapV4Pools: context.uniswapV4Pools,
      tradeHistory: context.tradeHistory,
      prices: context.prices,
    });
    const publicRoutes = extendPublicInterfaceRoutes({ routes: context.routes, bindings: readBindings, supportManifest });
    const tokenRoutes = extendTokenCatalogQueryRoutes({
      routes: publicRoutes,
      inspection: context.tokenInspection,
      queries: context.tokenCatalogQueries,
    });
    const cards = new PresentationCardApplication({
      ownerSignal: context.signal,
      clock: context.clock, store: context.cardStore, snapshots: context.snapshots,
      reviews: context.reviewPresentations, domains: {
        wallet: context.walletOperations, token: context.tokenCatalogManagement,
        signing: context.signing, exchange: context.exchange,
      },
      readExecution: { async execute(input, signal) {
        const result = await readBindings.invoke(stockTokenTradeHistoryCapability, input, { signal });
        return result.ok ? captureCanonicalJson(result) : result;
      } },
    });
    const registration = context.startupResources.register(cards);
    await cards.initialize();
    const operationRoutes = extendOperationRoutes({
      routes: tokenRoutes,
      wallet: context.walletOperations,
      token: context.tokenCatalogManagement,
      cards,
    });
    const exchangeRoutes = extendExchangeRoutes({ routes: operationRoutes, exchange: context.exchange, activity: context.activity, cards });
    const signingRoutes = extendSigningRoutes(exchangeRoutes, context.signing, cards);
    const reviewRoutes = extendReviewPresentationRoutes(signingRoutes, context.reviewPresentations);
    const routes = extendCardRoutes(reviewRoutes, cards);
    registration.transfer();
    return Object.freeze({
      routes,
      supportManifest,
      close: (): Promise<void> => cards.close(),
    });
  };

export const createInterfaceOwnerApplication = createInterfaceOwnerApplicationFactory();
