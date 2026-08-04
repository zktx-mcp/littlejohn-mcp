import type {
  ChainReadCapabilityPort,
  RuntimeApplicationContext,
  WalletConnectionReadCapabilityPort,
} from "../runtime/application-context.js";
import type { CapabilityBinding } from "../core/index.js";
import type { uniswapV2QuoteCapability } from "../protocols/uniswap-v2/index.js";
import type {
  HttpOwnerApplication,
} from "../runtime/http-owner.js";
import type {
  InterfaceRuntimeSupportManifest,
  ProtocolRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import type { WalletInterfaceOperations } from "../wallet/contracts.js";
import {
  extendTokenCatalogControlRouteRegistry,
  type TokenCatalogConsumerPorts,
  type TokenCatalogInspectionPort,
} from "../token-catalog/index.js";
import type { AccountAssetApplicationPort } from "../account-assets/index.js";
import type { ReferenceMarketApplicationPort } from "../market-portfolio/index.js";
import {
  loadBrowserAssetBundle,
  type BrowserAssetBundle,
} from "./browser-assets.js";
import {
  createBrowserRequestCredentialAuthority,
  type BrowserRequestCredentialAuthority,
} from "./browser-credentials.js";
import { extendBrowserInterfaceRoutes } from "./browser-routes.js";
import { extendPublicInterfaceRoutes } from "./http-routes.js";
import { extendReferenceMarketInterfaceRoutes } from "./reference-market-http.js";
import { extendInterfaceSupportManifest } from "./support.js";

export interface InterfaceApplicationDependencies {
  readonly loadAssets: () => Promise<BrowserAssetBundle>;
  readonly createCredentials: () => BrowserRequestCredentialAuthority;
}

export interface InterfaceOwnerApplicationContext<WalletOperations extends object>
  extends RuntimeApplicationContext, Omit<TokenCatalogConsumerPorts, "accountTokenSelectionStore"> {
  readonly supportManifest: ProtocolRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly walletOperations: WalletOperations;
  readonly chainReads: ChainReadCapabilityPort;
  readonly uniswapV2Quote: CapabilityBinding<typeof uniswapV2QuoteCapability>;
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly accountAssets: AccountAssetApplicationPort;
  readonly referenceMarkets: ReferenceMarketApplicationPort;
}

export interface InterfaceOwnerApplication extends HttpOwnerApplication {
  readonly supportManifest: InterfaceRuntimeSupportManifest;
}

export type InterfaceOwnerApplicationFactory<WalletOperations extends object> = (
  context: InterfaceOwnerApplicationContext<WalletOperations>,
) => Promise<InterfaceOwnerApplication> | InterfaceOwnerApplication;

const defaultDependencies: InterfaceApplicationDependencies = Object.freeze({
  loadAssets: () => loadBrowserAssetBundle(),
  createCredentials: () => createBrowserRequestCredentialAuthority(),
});

export const createInterfaceOwnerApplicationFactory = (
  dependencies: InterfaceApplicationDependencies = defaultDependencies,
): InterfaceOwnerApplicationFactory<WalletInterfaceOperations> => async (context): Promise<InterfaceOwnerApplication> => {
  const assets = await dependencies.loadAssets();
  const credentials = dependencies.createCredentials();
  try {
    const supportManifest = extendInterfaceSupportManifest(context.supportManifest);
    const publicRoutes = extendPublicInterfaceRoutes({
      routes: context.routes,
      chainReads: context.chainReads,
      walletConnection: context.walletConnection,
      tokenInspection: context.tokenInspection,
      uniswapV2Quote: context.uniswapV2Quote,
      supportManifest,
    });
    const controlRoutes = extendTokenCatalogControlRouteRegistry({
      routes: publicRoutes,
      inspection: context.tokenInspection,
      queries: context.tokenCatalogQueries,
      webStart: context.tokenCatalogWebStart,
      interactiveCli: context.tokenCatalogInteractiveCli,
      nonInteractiveOperations: context.tokenCatalogNonInteractiveOperations,
    });
    const referenceMarketRoutes = extendReferenceMarketInterfaceRoutes({
      routes: controlRoutes,
      referenceMarkets: context.referenceMarkets,
    });
    const routes = extendBrowserInterfaceRoutes({
      routes: referenceMarketRoutes,
      credentials,
      assets,
      walletOperations: context.walletOperations,
      accountAssets: context.accountAssets,
      tokenCatalogWebStart: context.tokenCatalogWebStart,
      tokenCatalogBrowserOperations: context.tokenCatalogBrowserOperations,
    });
    return Object.freeze({
      routes,
      supportManifest,
      close: async (): Promise<void> => { credentials.close(); },
    });
  } catch (error) {
    credentials.close();
    throw error;
  }
};

export const createInterfaceOwnerApplication = createInterfaceOwnerApplicationFactory();
