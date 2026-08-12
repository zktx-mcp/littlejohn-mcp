import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
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
}

export const createReferenceMarketApplicationFactory = async (
  input: ReferenceMarketApplicationFactoryInput,
): Promise<ReferenceMarketOwnerApplication> => {
  let state: "starting" | "open" | "closing" | "closed" = "starting";
  const application = new ReferenceMarketApplication(input);
  let activeClose: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (state === "closed") return Promise.resolve();
    if (activeClose !== undefined) return activeClose;
    state = "closing";
    let tracked!: Promise<void>;
    tracked = application.close().then(() => {
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
    const supportManifest = extendReferenceMarketSupportManifest(input.supportManifest);
    state = "open";
    return Object.freeze({
      routes: input.routes,
      supportManifest,
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
      close,
    });
  } catch (startupError) {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Reference market startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
