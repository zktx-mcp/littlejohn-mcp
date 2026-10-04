import type {
  WalletConnectionReadCapabilityPort,
  WalletOwnerApplicationContext,
} from "../runtime/application-context.js";
import type { HttpOwnerApplication } from "../runtime/http-owner.js";
import {
  isProcessTerminalRequiredError,
  requireProcessTermination,
  runtimeProcessTerminal,
  type RuntimeShutdownOutcome,
} from "../runtime/shutdown.js";
import { extendWalletRuntimeSupportManifest, type RuntimeSupportManifest } from "../runtime/support-manifest.js";
import {compareCodePointSequences, getCapabilityDefinitionSnapshot} from "../core/index.js";
import {walletConnectionCapability} from "./connection-capability.js";
import {
  type WalletManagementPort,
} from "./contracts.js";
import { walletManagementCapabilityIdList } from "./management-contracts.js";
import {
  createWalletCoordinator,
  type ActiveWalletReadPort,
  type WalletCoordinatorPort,
} from "./coordinator.js";
import {
  createWalletConnectClient,
  createWalletConnectAcquisitionScope,
  type WalletConnectClientAcquisition,
  type WalletConnectAcquisitionRegistration,
  type WalletConnectClientConfiguration,
} from "./walletconnect-client.js";
import { openWalletConnectStorage } from "./walletconnect-storage.js";
import type { WalletRequestPort } from "./request-contract.js";

const walletInternalAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "internal" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
});

export const extendWalletSupportManifest = (
  parent: RuntimeSupportManifest,
): RuntimeSupportManifest => extendWalletRuntimeSupportManifest(parent, {
  registrations: [...walletManagementCapabilityIdList]
    .sort(compareCodePointSequences)
    .map((capabilityId) => ({
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
  storageRegistration: WalletConnectAcquisitionRegistration,
  signal: AbortSignal,
) => Promise<WalletConnectClientAcquisition>;

export interface WalletOwnerApplication<
  ActiveWallet extends object,
  WalletOperations extends object,
> extends HttpOwnerApplication {
  readonly supportManifest: RuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
  readonly walletOperations: WalletOperations;
  readonly walletRequests: WalletRequestPort;
  shutdown(): Promise<RuntimeShutdownOutcome>;
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
  WalletManagementPort
> => {
  if (typeof createClient !== "function") {
    throw new TypeError("Wallet client factory must be a function.");
  }

  const createApplication = async (
    context: WalletOwnerApplicationContext,
  ): Promise<WalletOwnerApplication<
    ActiveWalletReadPort,
    WalletManagementPort
  >> => {
    const privateStoreDirectory = await context.wallet.privateStoreDirectory.ensureDirectory();
    const acquisitionScope = createWalletConnectAcquisitionScope();
    const startupRegistration = context.startupResources.register(acquisitionScope);
    try {
      const storageOwner = await openWalletConnectStorage(privateStoreDirectory);
      const storageRegistration = acquisitionScope.resources.register(storageOwner);
      const acquisition = await createClient(Object.freeze({
        wallet: context.wallet.configuration,
        storageOwner,
        createSessionSource: (topic: string) =>
          context.wallet.sourceAuthority.createSessionSource(topic),
      }), storageRegistration, context.signal);
      const createdCoordinator: WalletCoordinatorPort = await createWalletCoordinator({
        client: acquisition.client,
        wallet: context.wallet,
      });
      const walletOperations: WalletManagementPort = createdCoordinator;
      const shutdown = async (): Promise<RuntimeShutdownOutcome> => {
        try { await createdCoordinator.close(); }
        catch (error) { throw requireProcessTermination(error); }
        return runtimeProcessTerminal;
      };
      const application = Object.freeze({
        routes: context.routes,
        supportManifest: extendWalletSupportManifest(context.supportManifest),
        walletConnection: createdCoordinator.walletConnection,
        activeWallet: createdCoordinator.activeWallet,
        walletOperations,
        walletRequests: Object.freeze({
          hasPendingRequest: () => acquisition.client.hasPendingRequest(),
          startRequest: (input: Parameters<WalletRequestPort["startRequest"]>[0]) => acquisition.client.startRequest(input),
        }),
        shutdown,
        close: async (): Promise<void> => {
          await shutdown();
          throw requireProcessTermination();
        },
      });
      acquisition.replace(application);
      startupRegistration.replace(acquisitionScope, application);
      acquisition.transfer();
      startupRegistration.transfer();
      return application;
    } catch (error) {
      if (isProcessTerminalRequiredError(error)) throw error;
      try { await acquisitionScope.close(); }
      catch (cleanupError) {
        if (isProcessTerminalRequiredError(cleanupError)) {
          throw requireProcessTermination(error);
        }
        /* The HTTP owner retains failed local cleanup authority. */
      }
      throw error;
    }
  };

  return Object.freeze(createApplication);
};

export const createWalletOwnerApplication = createWalletOwnerApplicationFactory(
  createWalletConnectClient,
);
