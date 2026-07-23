import type { CanonicalClock } from "../core/index.js";
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
  TokenCatalogApplicationPort,
  AccountTokenSelectionStore,
  TokenCatalogBrowserOperationPort,
  TokenCatalogConsumerPorts,
  TokenCatalogCoordinatorDependencies,
  TokenCatalogInteractiveCliPort,
  TokenCatalogNonInteractiveOperationPort,
  TokenCatalogOperationCoordinatorPort,
  TokenCatalogQueryApplicationPort,
  TokenCatalogQueryStore,
  TokenCatalogStartApplicationPort,
  TokenCatalogStore,
} from "./ports.js";
import { extendTokenCatalogSupportManifest } from "./support.js";

const createStartPort = <InteractionInterface extends "cli" | "web">(
  application: TokenCatalogApplicationPort,
  interactionInterface: InteractionInterface,
  assertOpen: () => void,
): TokenCatalogStartApplicationPort<InteractionInterface> => Object.freeze({
  interactionInterface,
  startAddition(
    input: Parameters<TokenCatalogApplicationPort["startAddition"]>[0],
    operationId: Parameters<TokenCatalogStartApplicationPort<InteractionInterface>["startAddition"]>[1],
  ) {
    assertOpen();
    return application.startAddition(input, { operationId, interactionInterface });
  },
  startRemoval(
    input: Parameters<TokenCatalogApplicationPort["startRemoval"]>[0],
    operationId: Parameters<TokenCatalogStartApplicationPort<InteractionInterface>["startRemoval"]>[1],
  ) {
    assertOpen();
    return application.startRemoval(input, { operationId, interactionInterface });
  },
});

const createTokenCatalogConsumerPorts = (
  application: TokenCatalogApplicationPort,
  coordinator: TokenCatalogOperationCoordinatorPort,
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
  const tokenCatalogWebStart = createStartPort(application, "web", assertOpen);
  const cliStart = createStartPort(application, "cli", assertOpen);
  const tokenCatalogBrowserOperations = Object.freeze({
    interactionInterface: "web",
    getOperation(input: Parameters<TokenCatalogApplicationPort["getOperation"]>[0]) {
      assertOpen();
      return application.getOperation(input);
    },
    getCurrentOperation() {
      assertOpen();
      return coordinator.getCurrentOperation();
    },
    confirm(input: Parameters<TokenCatalogBrowserOperationPort["confirm"]>[0]) {
      assertOpen();
      return coordinator.confirm({ operationId: input.operationId, interactionInterface: "web" }, input);
    },
    cancel(operationId: Parameters<TokenCatalogBrowserOperationPort["cancel"]>[0]) {
      assertOpen();
      return coordinator.cancel(operationId, "web");
    },
  }) satisfies TokenCatalogBrowserOperationPort;
  const tokenCatalogInteractiveCli = Object.freeze({
    ...cliStart,
    interactionInterface: "cli",
    confirm(input: Parameters<TokenCatalogInteractiveCliPort["confirm"]>[0]) {
      assertOpen();
      return coordinator.confirm({ operationId: input.operationId, interactionInterface: "cli" }, input);
    },
  }) satisfies TokenCatalogInteractiveCliPort;
  const tokenCatalogNonInteractiveOperations = Object.freeze({
    getOperation(input: Parameters<TokenCatalogApplicationPort["getOperation"]>[0]) {
      assertOpen();
      return application.getOperation(input);
    },
    cancelOperation(input: Parameters<TokenCatalogApplicationPort["cancelOperation"]>[0]) {
      assertOpen();
      return application.cancelOperation(input);
    },
  }) satisfies TokenCatalogNonInteractiveOperationPort;
  return Object.freeze({
    accountTokenSelectionStore: Object.freeze({
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
    tokenCatalogWebStart,
    tokenCatalogBrowserOperations,
    tokenCatalogInteractiveCli,
    tokenCatalogNonInteractiveOperations,
  });
};

export interface TokenCatalogApplication extends TokenCatalogConsumerPorts {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: TokenCatalogRuntimeSupportManifest;
  readonly officialAssets: TokenCatalogCoordinatorDependencies["officialAssets"];
  close(): Promise<void>;
}

export interface TokenCatalogApplicationFactoryInput {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly activeWallet: TokenCatalogCoordinatorDependencies["activeWallet"];
  readonly additionChainReads: TokenCatalogCoordinatorDependencies["additionChainReads"];
  readonly officialAssets: TokenCatalogCoordinatorDependencies["officialAssets"];
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
      activeWallet: input.activeWallet,
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
        activeWallet: input.activeWallet,
        store: input.readStore,
      },
      operations: coordinator,
    });
    const ports = createTokenCatalogConsumerPorts(
      application,
      coordinator,
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
