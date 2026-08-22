import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import {
  createResourceOwnershipScope,
  type OwnedResourceRegistry,
} from "../runtime/resource-ownership.js";
import type {
  AccountAssetRuntimeSupportManifest,
  MarketPortfolioRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { MarketPortfolioApplication } from "./application.js";
import { MarketPortfolioOperationError } from "./errors.js";
import type {
  MarketPortfolioApplicationDependencies,
  MarketPortfolioApplicationPort,
} from "./ports.js";
import { extendMarketPortfolioSupportManifest } from "./support.js";

export interface MarketPortfolioOwnerApplication extends MarketPortfolioApplicationPort {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: MarketPortfolioRuntimeSupportManifest;
  close(): Promise<void>;
}

export interface MarketPortfolioApplicationFactoryInput extends MarketPortfolioApplicationDependencies {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: AccountAssetRuntimeSupportManifest;
  readonly startupResources: OwnedResourceRegistry;
}

export const createMarketPortfolioApplicationFactory = async (
  input: MarketPortfolioApplicationFactoryInput,
): Promise<MarketPortfolioOwnerApplication> => {
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
    if (state !== "open") throw new MarketPortfolioOperationError("runtime_state_unavailable");
  };
  try {
    const application = new MarketPortfolioApplication(input);
    lifecycle.resources.register(application);
    lifecycle.seal();
    const markets = Object.freeze({
      price(request: Parameters<MarketPortfolioApplicationPort["price"]>[0], signal?: AbortSignal) {
        assertOpen();
        return application.price(request, signal);
      },
      history(request: Parameters<MarketPortfolioApplicationPort["history"]>[0], signal?: AbortSignal) {
        assertOpen();
        return application.history(request, signal);
      },
      stockTokenMarket(
        request: Parameters<MarketPortfolioApplicationPort["stockTokenMarket"]>[0],
        signal?: AbortSignal,
      ) {
        assertOpen();
        return application.stockTokenMarket(request, signal);
      },
      watchlist(request: Parameters<MarketPortfolioApplicationPort["watchlist"]>[0], signal?: AbortSignal) {
        assertOpen();
        return application.watchlist(request, signal);
      },
      reviewWatchlistChange(
        request: Parameters<MarketPortfolioApplicationPort["reviewWatchlistChange"]>[0],
        signal?: AbortSignal,
      ) {
        assertOpen();
        return application.reviewWatchlistChange(request, signal);
      },
      decideWatchlistChange(
        request: Parameters<MarketPortfolioApplicationPort["decideWatchlistChange"]>[0],
        signal?: AbortSignal,
      ) {
        assertOpen();
        return application.decideWatchlistChange(request, signal);
      },
      getWatchlistOperation(
        request: Parameters<MarketPortfolioApplicationPort["getWatchlistOperation"]>[0],
        signal?: AbortSignal,
      ) {
        assertOpen();
        return application.getWatchlistOperation(request, signal);
      },
    }) satisfies MarketPortfolioApplicationPort;
    const supportManifest = extendMarketPortfolioSupportManifest(input.supportManifest);
    const result = Object.freeze({
      routes: input.routes,
      supportManifest,
      ...markets,
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
        "Market portfolio startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
