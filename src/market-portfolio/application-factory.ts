import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import {
  createResourceOwnershipScope,
  type OwnedResourceRegistry,
} from "../runtime/resource-ownership.js";
import type {
  AccountAssetRuntimeSupportManifest,
  ReferenceMarketRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { ReferenceMarketApplication } from "./application.js";
import { ReferenceMarketOperationError } from "./errors.js";
import type {
  ReferenceMarketApplicationDependencies,
  ReferenceMarketApplicationPort,
} from "./ports.js";
import { extendReferenceMarketSupportManifest } from "./support.js";

export interface ReferenceMarketOwnerApplication extends ReferenceMarketApplicationPort {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: ReferenceMarketRuntimeSupportManifest;
  close(): Promise<void>;
}

export interface ReferenceMarketApplicationFactoryInput extends ReferenceMarketApplicationDependencies {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: AccountAssetRuntimeSupportManifest;
  readonly startupResources: OwnedResourceRegistry;
}

export const createReferenceMarketApplicationFactory = async (
  input: ReferenceMarketApplicationFactoryInput,
): Promise<ReferenceMarketOwnerApplication> => {
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
    if (state !== "open") throw new ReferenceMarketOperationError("runtime_state_unavailable");
  };
  try {
    const application = new ReferenceMarketApplication(input);
    lifecycle.resources.register(application);
    lifecycle.seal();
    const referenceMarkets = Object.freeze({
      price(request: Parameters<ReferenceMarketApplicationPort["price"]>[0], signal?: AbortSignal) {
        assertOpen();
        return application.price(request, signal);
      },
      history(request: Parameters<ReferenceMarketApplicationPort["history"]>[0], signal?: AbortSignal) {
        assertOpen();
        return application.history(request, signal);
      },
      stockTokenMarket(
        request: Parameters<ReferenceMarketApplicationPort["stockTokenMarket"]>[0],
        signal?: AbortSignal,
      ) {
        assertOpen();
        return application.stockTokenMarket(request, signal);
      },
      watchlist(request: Parameters<ReferenceMarketApplicationPort["watchlist"]>[0], signal?: AbortSignal) {
        assertOpen();
        return application.watchlist(request, signal);
      },
      reviewWatchlistChange(
        request: Parameters<ReferenceMarketApplicationPort["reviewWatchlistChange"]>[0],
        signal?: AbortSignal,
      ) {
        assertOpen();
        return application.reviewWatchlistChange(request, signal);
      },
      decideWatchlistChange(
        request: Parameters<ReferenceMarketApplicationPort["decideWatchlistChange"]>[0],
        signal?: AbortSignal,
      ) {
        assertOpen();
        return application.decideWatchlistChange(request, signal);
      },
      getWatchlistOperation(
        request: Parameters<ReferenceMarketApplicationPort["getWatchlistOperation"]>[0],
        signal?: AbortSignal,
      ) {
        assertOpen();
        return application.getWatchlistOperation(request, signal);
      },
    }) satisfies ReferenceMarketApplicationPort;
    const supportManifest = extendReferenceMarketSupportManifest(input.supportManifest);
    const result = Object.freeze({
      routes: input.routes,
      supportManifest,
      ...referenceMarkets,
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
        "Reference market startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
