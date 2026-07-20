import type { CanonicalClock } from "../core/index.js";
import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import type {
  ChainRuntimeSupportManifest,
  TokenCatalogRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { createTokenCatalogApplication } from "./application.js";
import { TokenCatalogCoordinator } from "./coordinator.js";
import { TokenCatalogOperationError } from "./operation-error.js";
import type {
  TokenCatalogApplicationPort,
  AccountTokenRegistrationReadPort,
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
  startRegistration(
    input: Parameters<TokenCatalogApplicationPort["startRegistration"]>[0],
    operationId: Parameters<TokenCatalogStartApplicationPort<InteractionInterface>["startRegistration"]>[1],
  ) {
    assertOpen();
    return application.startRegistration(input, { operationId, interactionInterface });
  },
  startUnregistration(
    input: Parameters<TokenCatalogApplicationPort["startUnregistration"]>[0],
    operationId: Parameters<TokenCatalogStartApplicationPort<InteractionInterface>["startUnregistration"]>[1],
  ) {
    assertOpen();
    return application.startUnregistration(input, { operationId, interactionInterface });
  },
});

const createTokenCatalogConsumerPorts = (
  application: TokenCatalogApplicationPort,
  coordinator: TokenCatalogOperationCoordinatorPort,
  accountTokenRegistrationRead: AccountTokenRegistrationReadPort,
  assertOpen: () => void,
): TokenCatalogConsumerPorts => {
  const tokenCatalogQueries = Object.freeze({
    getRegistration(input: Parameters<TokenCatalogApplicationPort["getRegistration"]>[0]) {
      assertOpen();
      return application.getRegistration(input);
    },
    listRegistrations(input: Parameters<TokenCatalogApplicationPort["listRegistrations"]>[0]) {
      assertOpen();
      return application.listRegistrations(input);
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
    accountTokenRegistrationRead: Object.freeze({
      getForAccount(input: Parameters<AccountTokenRegistrationReadPort["getForAccount"]>[0]) {
        assertOpen();
        return accountTokenRegistrationRead.getForAccount(input);
      },
      listForAccount(input: Parameters<AccountTokenRegistrationReadPort["listForAccount"]>[0]) {
        assertOpen();
        return accountTokenRegistrationRead.listForAccount(input);
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
  close(): Promise<void>;
}

export interface TokenCatalogApplicationFactoryInput {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly activeWallet: TokenCatalogCoordinatorDependencies["activeWallet"];
  readonly inspection: TokenCatalogCoordinatorDependencies["inspection"];
  readonly store: TokenCatalogStore;
  readonly readStore: TokenCatalogQueryStore;
  readonly accountTokenRegistrationRead: AccountTokenRegistrationReadPort;
  readonly clock: CanonicalClock;
  readonly signal: AbortSignal;
}

export const createTokenCatalogApplicationFactory = async (
  input: TokenCatalogApplicationFactoryInput,
): Promise<TokenCatalogApplication> => {
  const coordinator = new TokenCatalogCoordinator({
    activeWallet: input.activeWallet,
    inspection: input.inspection,
    store: input.store,
    clock: input.clock,
    signal: input.signal,
  });
  let lifecycleState: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | undefined;
  const assertOpen = (): void => {
    if (lifecycleState !== "open") {
      throw new TokenCatalogOperationError("runtime_state_unavailable");
    }
  };
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    lifecycleState = "closing";
    closePromise = coordinator.close().then(() => { lifecycleState = "closed"; });
    return closePromise;
  };
  try {
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
      input.accountTokenRegistrationRead,
      assertOpen,
    );
    return Object.freeze({
      routes: input.routes,
      supportManifest: extendTokenCatalogSupportManifest(input.supportManifest),
      ...ports,
      close,
    });
  } catch (startupError) {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Token catalog startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
