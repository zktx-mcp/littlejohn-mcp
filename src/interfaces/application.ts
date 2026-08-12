import type { AccountAssetApplicationPort } from "../account-assets/index.js";
import type { CapabilityBinding } from "../core/index.js";
import type { ReferenceMarketApplicationPort } from "../market-portfolio/index.js";
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
import { extendReferenceMarketInterfaceRoutes } from "./reference-market-http.js";
import { extendInterfaceSupportManifest } from "./support.js";

export interface InterfaceOwnerApplicationContext
  extends RuntimeApplicationContext, Omit<TokenCatalogConsumerPorts, "accountTokenSelectionStore"> {
  readonly supportManifest: ProtocolRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly walletOperations: WalletManagementPort;
  readonly chainReads: ChainReadCapabilityPort;
  readonly uniswapV2Quote: CapabilityBinding<typeof uniswapV2QuoteCapability>;
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly accountAssets: AccountAssetApplicationPort;
  readonly referenceMarkets: ReferenceMarketApplicationPort;
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
      supportManifest,
    });
    const tokenRoutes = extendTokenCatalogQueryRoutes({
      routes: publicRoutes,
      inspection: context.tokenInspection,
      queries: context.tokenCatalogQueries,
    });
    const referenceMarketRoutes = extendReferenceMarketInterfaceRoutes({
      routes: tokenRoutes,
      referenceMarkets: context.referenceMarkets,
    });
    const routes = extendOperationRoutes({
      routes: referenceMarketRoutes,
      wallet: context.walletOperations,
      token: context.tokenCatalogManagement,
      market: context.referenceMarkets,
    });
    return Object.freeze({
      routes,
      supportManifest,
      close: async (): Promise<void> => undefined,
    });
  };

export const createInterfaceOwnerApplication = createInterfaceOwnerApplicationFactory();
