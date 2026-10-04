import type { CanonicalClock } from "../core/index.js";
import type { OfficialAssetReadPort } from "../registry/index.js";
import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import { createApplicationLifecycle } from "../runtime/application-lifecycle.js";
import type { OwnedResourceRegistry } from "../runtime/resource-ownership.js";
import type { RuntimeSupportManifest } from "../runtime/support-manifest.js";
import { createTokenCatalogApplication } from "./application.js";
import { TokenCatalogCoordinator } from "./coordinator.js";
import { TokenCatalogOperationError } from "./operation-error.js";
import type {
  AccountTokenSelectionStore,
  TokenCatalogApplicationPort,
  TokenCatalogConsumerPorts,
  TokenCatalogCoordinatorDependencies,
  TokenCatalogManagementApplicationPort,
  TokenCatalogQueryApplicationPort,
  TokenCatalogQueryStore,
  TokenCatalogStore,
} from "./ports.js";
import { extendTokenCatalogSupportManifest } from "./support.js";

const createTokenCatalogConsumerPorts = (
  application: TokenCatalogApplicationPort,
  accountTokenSelectionStore: AccountTokenSelectionStore,
  assertOpen: () => void,
): TokenCatalogConsumerPorts => {
  const tokenCatalogQueries = Object.freeze({
    getSelection(input: Parameters<TokenCatalogApplicationPort["getSelection"]>[0]) {
      assertOpen();
      return application.getSelection(input);
    },
    listSelections(input: Parameters<TokenCatalogApplicationPort["listSelections"]>[0]) {
      assertOpen();
      return application.listSelections(input);
    },
  }) satisfies TokenCatalogQueryApplicationPort;
  const tokenCatalogManagement = Object.freeze({
    review(input: Parameters<TokenCatalogApplicationPort["review"]>[0]) {
      assertOpen();
      return application.review(input);
    },
    decide(input: Parameters<TokenCatalogApplicationPort["decide"]>[0]) {
      assertOpen();
      return application.decide(input);
    },
    getOperation(input: Parameters<TokenCatalogApplicationPort["getOperation"]>[0]) {
      assertOpen();
      return application.getOperation(input);
    },
  }) satisfies TokenCatalogManagementApplicationPort;
  return Object.freeze({
    accountTokenSelectionStore: Object.freeze({
      isAccountRetained(input: Parameters<AccountTokenSelectionStore["isAccountRetained"]>[0]) {
        assertOpen();
        return accountTokenSelectionStore.isAccountRetained(input);
      },
      getState(input: Parameters<AccountTokenSelectionStore["getState"]>[0]) {
        assertOpen();
        return accountTokenSelectionStore.getState(input);
      },
      getForAccount(input: Parameters<AccountTokenSelectionStore["getForAccount"]>[0]) {
        assertOpen();
        return accountTokenSelectionStore.getForAccount(input);
      },
      listIncludedForAccount(input: Parameters<AccountTokenSelectionStore["listIncludedForAccount"]>[0]) {
        assertOpen();
        return accountTokenSelectionStore.listIncludedForAccount(input);
      },
      initializeDefaults(input: Parameters<AccountTokenSelectionStore["initializeDefaults"]>[0]) {
        assertOpen();
        return accountTokenSelectionStore.initializeDefaults(input);
      },
    }),
    tokenCatalogQueries,
    tokenCatalogManagement,
  });
};

export interface TokenCatalogApplication extends TokenCatalogConsumerPorts {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: RuntimeSupportManifest;
  close(): Promise<void>;
}

export interface TokenCatalogApplicationFactoryInput {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: RuntimeSupportManifest;
  readonly addressTargets: TokenCatalogCoordinatorDependencies["addressTargets"];
  readonly additionChainReads: TokenCatalogCoordinatorDependencies["additionChainReads"];
  readonly officialAssets: OfficialAssetReadPort;
  readonly startupResources: OwnedResourceRegistry;
  readonly store: TokenCatalogStore;
  readonly readStore: TokenCatalogQueryStore;
  readonly accountTokenSelectionStore: AccountTokenSelectionStore;
  readonly clock: CanonicalClock;
  readonly signal: AbortSignal;
}

export const createTokenCatalogApplicationFactory = async (
  input: TokenCatalogApplicationFactoryInput,
): Promise<TokenCatalogApplication> => {
  const lifecycle = createApplicationLifecycle();
  const lifecycleOwnership = input.startupResources.register(lifecycle);
  const assertOpen = (): void => {
    if (!lifecycle.admission.isOpen) {
      throw new TokenCatalogOperationError("runtime_state_unavailable");
    }
  };
  try {
    const coordinator = new TokenCatalogCoordinator({
      addressTargets: input.addressTargets,
      additionChainReads: input.additionChainReads,
      officialAssets: input.officialAssets,
      store: input.store,
      clock: input.clock,
      signal: input.signal,
    });
    lifecycle.resources.register(coordinator);
    const application = createTokenCatalogApplication({
      dependencies: {
        addressTargets: input.addressTargets,
        store: input.readStore,
      },
      operations: coordinator,
    });
    const ports = createTokenCatalogConsumerPorts(
      application,
      input.accountTokenSelectionStore,
      assertOpen,
    );
    const result = Object.freeze({
      routes: input.routes,
      supportManifest: extendTokenCatalogSupportManifest(input.supportManifest),
      ...ports,
      close: lifecycle.close,
    });
    lifecycle.open();
    lifecycleOwnership.transfer();
    return result;
  } catch (startupError) {
    try {
      await lifecycle.close();
      lifecycleOwnership.transfer();
    }
    catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Token catalog startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
