import type { CanonicalClock } from "../core/index.js";
import type { OfficialAssetSynchronizationPort } from "../registry/index.js";
import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import {
  createResourceOwnershipScope,
  type OwnedResourceRegistry,
} from "../runtime/resource-ownership.js";
import type {
  ChainRuntimeSupportManifest,
  TokenCatalogRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
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
  readonly supportManifest: TokenCatalogRuntimeSupportManifest;
  readonly officialAssets: TokenCatalogApplicationFactoryInput["officialAssets"];
  close(): Promise<void>;
}

export interface TokenCatalogApplicationFactoryInput {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly addressTargets: TokenCatalogCoordinatorDependencies["addressTargets"];
  readonly additionChainReads: TokenCatalogCoordinatorDependencies["additionChainReads"];
  readonly officialAssets: OfficialAssetSynchronizationPort;
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
  const lifecycle = createResourceOwnershipScope();
  const lifecycleOwnership = input.startupResources.register(lifecycle);
  let lifecycleState: "open" | "closing" | "closed" = "open";
  let activeClose: Promise<void> | undefined;
  const assertOpen = (): void => {
    if (lifecycleState !== "open") {
      throw new TokenCatalogOperationError("runtime_state_unavailable");
    }
  };
  const close = (): Promise<void> => {
    if (lifecycleState === "closed") return Promise.resolve();
    if (activeClose !== undefined) return activeClose;
    lifecycleState = "closing";
    let tracked!: Promise<void>;
    tracked = lifecycle.close().then(() => {
      lifecycleState = "closed";
    }).finally(() => {
      if (activeClose === tracked) activeClose = undefined;
    });
    activeClose = tracked;
    return tracked;
  };
  try {
    lifecycle.resources.register(input.officialAssets);
    const coordinator = new TokenCatalogCoordinator({
      addressTargets: input.addressTargets,
      additionChainReads: input.additionChainReads,
      officialAssets: input.officialAssets,
      store: input.store,
      clock: input.clock,
      signal: input.signal,
    });
    lifecycle.resources.register(coordinator);
    lifecycle.seal();
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
      officialAssets: input.officialAssets,
      ...ports,
      close,
    });
    lifecycleOwnership.transfer();
    return result;
  } catch (startupError) {
    if (!lifecycle.sealed) lifecycle.seal();
    try {
      await close();
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
