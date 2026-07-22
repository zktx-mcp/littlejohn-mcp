import type {
  WalletConnectionReadCapabilityPort,
  WalletOwnerApplicationContext,
} from "../runtime/application-context.js";
import type { HttpOwnerApplication } from "../runtime/http-owner.js";
import {
  extendWalletRuntimeSupportManifest,
  type WalletRuntimeSupportManifest,
  type InitialRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import {
  getCapabilityDefinitionSnapshot,
  walletConnectionCapability,
} from "../core/index.js";
import {
  type WalletInterfaceOperations,
} from "./contracts.js";
import { walletManagementCapabilityIdList } from "./management-contracts.js";
import {
  createWalletCoordinator,
  type ActiveWalletReadPort,
  type WalletCoordinatorPort,
} from "./coordinator.js";
import { extendWalletControlRouteRegistry } from "./routes.js";
import {
  createWalletConnectClient,
  createWalletConnectAcquisitionScope,
  type WalletConnectClientAcquisition,
  type WalletConnectAcquisitionRegistry,
  type WalletConnectClientConfiguration,
} from "./walletconnect-client.js";
import {
  assertWalletConnectPrivateStore,
  secureWalletConnectPrivateStore,
} from "./private-store.js";

const walletInternalAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "internal" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
  web: "unavailable" as const,
});

export const extendWalletSupportManifest = (
  parent: InitialRuntimeSupportManifest,
): WalletRuntimeSupportManifest => extendWalletRuntimeSupportManifest(parent, {
  registrations: walletManagementCapabilityIdList.map((capabilityId) => ({
    capabilityId,
    availability: walletInternalAvailability,
  })),
  changes: [{
    capabilityId: getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId,
    availability: walletInternalAvailability,
  }],
});

type WalletConnectClientFactory = (
  configuration: WalletConnectClientConfiguration,
  acquisitionResources: WalletConnectAcquisitionRegistry,
  signal: AbortSignal,
) => Promise<WalletConnectClientAcquisition>;

export interface WalletOwnerApplication<
  ActiveWallet extends object,
  WalletOperations extends object,
> extends HttpOwnerApplication {
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
  readonly walletOperations: WalletOperations;
}

export type WalletOwnerApplicationFactory<
  ActiveWallet extends object,
  WalletOperations extends object,
> = (
  context: WalletOwnerApplicationContext,
) => Promise<WalletOwnerApplication<ActiveWallet, WalletOperations>> |
  WalletOwnerApplication<ActiveWallet, WalletOperations>;

export const createWalletOwnerApplicationFactory = (
  createClient: WalletConnectClientFactory,
): WalletOwnerApplicationFactory<
  ActiveWalletReadPort,
  WalletInterfaceOperations
> => {
  if (typeof createClient !== "function") {
    throw new TypeError("Wallet client factory must be a function.");
  }

  const createApplication = async (
    context: WalletOwnerApplicationContext,
  ): Promise<WalletOwnerApplication<
    ActiveWalletReadPort,
    WalletInterfaceOperations
  >> => {
    const privateStoreDirectory = await context.wallet.privateStoreDirectory.ensureDirectory();
    await secureWalletConnectPrivateStore(privateStoreDirectory);
    const acquisitionScope = createWalletConnectAcquisitionScope();
    const startupRegistration = context.startupResources.register(acquisitionScope);
    try {
      const acquisition = await createClient(Object.freeze({
        wallet: context.wallet.configuration,
        privateStoreDirectory,
      }), acquisitionScope.resources, context.signal);
      await assertWalletConnectPrivateStore(privateStoreDirectory);
      const createdCoordinator: WalletCoordinatorPort = await createWalletCoordinator({
        client: acquisition.client,
        wallet: context.wallet,
      });
      acquisition.replace(createdCoordinator);
      const walletOperations: WalletInterfaceOperations = Object.freeze({
        operation: createdCoordinator.operation,
        confirmation: createdCoordinator.webConfirmation,
        presentation: createdCoordinator.operationPresentation,
        currentProjection: createdCoordinator.currentOperationProjection,
      });
      let coordinatorClosed = false;
      let applicationClosed = false;
      let activeClose: Promise<void> | undefined;
      const closeApplication = (): Promise<void> => {
        if (applicationClosed) return Promise.resolve();
        if (activeClose !== undefined) return activeClose;
        let resolveClose!: () => void;
        let rejectClose!: (error: unknown) => void;
        const tracked = new Promise<void>((resolve, reject) => {
          resolveClose = resolve;
          rejectClose = reject;
        });
        activeClose = tracked;
        void (async () => {
          let closeFailure: unknown;
          if (!coordinatorClosed) {
            try {
              await createdCoordinator.close();
              coordinatorClosed = true;
            } catch (error) { closeFailure = error; }
          }
          try { await assertWalletConnectPrivateStore(privateStoreDirectory); }
          catch (error) { closeFailure ??= error; }
          if (closeFailure !== undefined) throw closeFailure;
        })().then(
          () => {
            applicationClosed = true;
            if (activeClose === tracked) activeClose = undefined;
            resolveClose();
          },
          (error: unknown) => {
            if (activeClose === tracked) activeClose = undefined;
            rejectClose(error);
          },
        );
        return tracked;
      };
      const application = Object.freeze({
        routes: extendWalletControlRouteRegistry({
          routes: context.routes,
          operations: createdCoordinator,
          cliConfirmation: createdCoordinator.cliConfirmation,
          walletConnection: createdCoordinator.walletConnection,
        }),
        supportManifest: extendWalletSupportManifest(context.supportManifest),
        walletConnection: createdCoordinator.walletConnection,
        activeWallet: createdCoordinator.activeWallet,
        walletOperations,
        close: closeApplication,
      });
      acquisition.replace(application);
      startupRegistration.replace(acquisitionScope, application);
      acquisition.transfer();
      startupRegistration.transfer();
      return application;
    } catch (error) {
      try { await acquisitionScope.close(); }
      catch { /* The HTTP owner retains failed cleanup authority. */ }
      throw error;
    }
  };

  return Object.freeze(createApplication);
};

export const createWalletOwnerApplication = createWalletOwnerApplicationFactory(
  createWalletConnectClient,
);
