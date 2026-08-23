import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import {
  createResourceOwnershipScope,
  type OwnedResourceRegistry,
} from "../runtime/resource-ownership.js";
import type {
  AccountAssetRuntimeSupportManifest,
  StockTokenTradeHistoryRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { StockTokenTradeHistoryApplication } from "./application.js";
import { StockTokenTradeHistoryOperationError } from "./errors.js";
import type {
  StockTokenTradeHistoryApplicationDependencies,
  StockTokenTradeHistoryApplicationPort,
} from "./ports.js";
import { extendStockTokenTradeHistorySupportManifest } from "./support.js";

export interface StockTokenTradeHistoryOwnerApplication
  extends StockTokenTradeHistoryApplicationPort {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: StockTokenTradeHistoryRuntimeSupportManifest;
  close(): Promise<void>;
}

export interface StockTokenTradeHistoryApplicationFactoryInput
  extends StockTokenTradeHistoryApplicationDependencies {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: AccountAssetRuntimeSupportManifest;
  readonly startupResources: OwnedResourceRegistry;
}

export const createStockTokenTradeHistoryApplicationFactory = async (
  input: StockTokenTradeHistoryApplicationFactoryInput,
): Promise<StockTokenTradeHistoryOwnerApplication> => {
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
    if (state !== "open") {
      throw new StockTokenTradeHistoryOperationError("runtime_state_unavailable");
    }
  };
  try {
    const application = new StockTokenTradeHistoryApplication(input);
    lifecycle.resources.register(application);
    lifecycle.seal();
    const tradeHistory = Object.freeze({
      get(
        request: Parameters<StockTokenTradeHistoryApplicationPort["get"]>[0],
        signal?: AbortSignal,
      ) {
        assertOpen();
        return application.get(request, signal);
      },
    }) satisfies StockTokenTradeHistoryApplicationPort;
    const supportManifest = extendStockTokenTradeHistorySupportManifest(input.supportManifest);
    const result = Object.freeze({
      routes: input.routes,
      supportManifest,
      ...tradeHistory,
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
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Stock Token trade-history startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
