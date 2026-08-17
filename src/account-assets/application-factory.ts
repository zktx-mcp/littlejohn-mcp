import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import {
  createResourceOwnershipScope,
  type OwnedResourceRegistry,
} from "../runtime/resource-ownership.js";
import type {
  AccountAssetRuntimeSupportManifest,
  TokenCatalogRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { createAccountAssetApplication } from "./application.js";
import type {
  AccountAssetCollectionInput,
  AccountAssetExactInput,
  AccountAssetOverviewInput,
} from "./contracts.js";
import { AccountAssetOperationError } from "./errors.js";
import { extendAccountAssetControlRouteRegistry } from "./routes.js";
import type {
  AccountAssetApplicationPort,
  AccountAssetReadProcessDependencies,
} from "./ports.js";
import { extendAccountAssetSupportManifest } from "./support.js";

export interface AccountAssetApplication extends AccountAssetApplicationPort {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: AccountAssetRuntimeSupportManifest;
  close(): Promise<void>;
}

export interface AccountAssetApplicationFactoryInput extends AccountAssetReadProcessDependencies {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: TokenCatalogRuntimeSupportManifest;
  readonly startupResources: OwnedResourceRegistry;
}

export const createAccountAssetApplicationFactory = async (
  input: AccountAssetApplicationFactoryInput,
): Promise<AccountAssetApplication> => {
  const lifecycle = createResourceOwnershipScope();
  const lifecycleOwnership = input.startupResources.register(lifecycle);
  let state: "starting" | "open" | "closing" | "closed" = "starting";
  let activeClose: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (state === "closed") return Promise.resolve();
    if (activeClose !== undefined) return activeClose;
    state = "closing";
    let tracked!: Promise<void>;
    tracked = lifecycle.close().then(() => {
      state = "closed";
    }).finally(() => {
      if (activeClose === tracked) activeClose = undefined;
    });
    activeClose = tracked;
    return tracked;
  };
  const assertOpen = (): void => {
    if (state !== "open") throw new AccountAssetOperationError("runtime_state_unavailable");
  };
  try {
    const application = createAccountAssetApplication(input);
    lifecycle.resources.register(application);
    lifecycle.seal();
    const accountAssets = Object.freeze({
      list(request: AccountAssetCollectionInput, signal?: AbortSignal) {
        assertOpen();
        return application.list(request, signal);
      },
      getOverview(request: AccountAssetOverviewInput, signal?: AbortSignal) {
        assertOpen();
        return application.getOverview(request, signal);
      },
      get(request: AccountAssetExactInput, signal?: AbortSignal) {
        assertOpen();
        return application.get(request, signal);
      },
    }) satisfies AccountAssetApplicationPort;
    const supportManifest = extendAccountAssetSupportManifest(input.supportManifest);
    const routes = extendAccountAssetControlRouteRegistry({
      routes: input.routes,
      accountAssets,
    });
    const result = Object.freeze({
      routes,
      supportManifest,
      ...accountAssets,
      close,
    });
    state = "open";
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
        "Account assets startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
