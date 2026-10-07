import type {
  WalletConnectionReadCapabilityPort,
  WalletOwnerApplicationContext,
} from "../runtime/application-context.js";
import type { HttpOwnerApplication } from "../runtime/http-owner.js";
import {
  requireProcessTermination,
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
import type { WalletConnectClientPort } from "./client-contract.js";
import { WalletSdkWorkerClient } from "./worker-client.js";
import { runtimeReleased } from "../runtime/shutdown.js";
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
  wallet: WalletOwnerApplicationContext["wallet"],
  signal: AbortSignal,
) => WalletConnectClientPort | Promise<WalletConnectClientPort>;

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
    const client = await createClient(context.wallet, context.signal);
    const resource = Object.freeze({ close: () => client.contain() });
    try {
      const startupRegistration = context.startupResources.register(resource);
      const createdCoordinator: WalletCoordinatorPort = await createWalletCoordinator({ client, wallet: context.wallet });
      let shutdownWork: Promise<RuntimeShutdownOutcome> | undefined;
      const shutdown = (): Promise<RuntimeShutdownOutcome> => {
        if (shutdownWork !== undefined) return shutdownWork;
        const containment = client.contain();
        shutdownWork = Promise.all([containment, createdCoordinator.close()]).then(() => runtimeReleased);
        return shutdownWork;
      };
      const application = Object.freeze({
        routes: context.routes,
        supportManifest: extendWalletSupportManifest(context.supportManifest),
        walletConnection: createdCoordinator.walletConnection,
        activeWallet: createdCoordinator.activeWallet,
        walletOperations: createdCoordinator as WalletManagementPort,
        walletRequests: Object.freeze({
          hasPendingRequest: () => client.hasPendingRequest(),
          startRequest: (input: Parameters<WalletRequestPort["startRequest"]>[0]) => client.startRequest(input),
        }),
        shutdown,
        close: async (): Promise<void> => { await shutdown(); },
      });
      startupRegistration.replace(resource, application);
      startupRegistration.transfer();
      return application;
    } catch (error) {
      try { await client.contain(); }
      catch { throw requireProcessTermination(error); }
      throw error;
    }

  };

  return Object.freeze(createApplication);
};

export const createWalletOwnerApplication = createWalletOwnerApplicationFactory(
  (wallet, signal) => new WalletSdkWorkerClient(wallet, signal),
);
