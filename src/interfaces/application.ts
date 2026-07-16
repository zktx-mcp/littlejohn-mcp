import type {
  InterfaceOwnerApplication,
  InterfaceOwnerApplicationFactory,
} from "../runtime/index.js";
import type { WalletInterfaceOperations } from "../wallet/contracts.js";
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
import { extendInterfaceSupportManifest } from "./support.js";

export interface InterfaceApplicationDependencies {
  readonly loadAssets: () => Promise<BrowserAssetBundle>;
  readonly createCredentials: () => BrowserRequestCredentialAuthority;
}

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
      supportManifest,
    });
    const routes = extendBrowserInterfaceRoutes({
      routes: publicRoutes,
      credentials,
      assets,
      walletOperations: context.walletOperations,
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
