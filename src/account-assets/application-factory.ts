import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import type {
  AccountAssetRuntimeSupportManifest,
  TokenCatalogRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { createAccountAssetApplication } from "./application.js";
import type {
  AccountAssetCollectionInput,
  AccountAssetExactInput,
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
}

export const createAccountAssetApplicationFactory = async (
  input: AccountAssetApplicationFactoryInput,
): Promise<AccountAssetApplication> => {
  let state: "starting" | "open" | "closing" | "closed" = "starting";
  let application: ReturnType<typeof createAccountAssetApplication> | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    state = "closing";
    closePromise = (application?.close() ?? Promise.resolve()).then(() => { state = "closed"; });
    return closePromise;
  };
  const assertOpen = (): void => {
    if (state !== "open") throw new AccountAssetOperationError("runtime_state_unavailable");
  };
  try {
    application = createAccountAssetApplication(input);
    const supportManifest = extendAccountAssetSupportManifest(input.supportManifest);
    const routes = extendAccountAssetControlRouteRegistry({
      routes: input.routes,
      accountAssets: application,
    });
    state = "open";
    return Object.freeze({
      routes,
      supportManifest,
      list(request: AccountAssetCollectionInput, signal?: AbortSignal) {
        assertOpen();
        return application!.list(request, signal);
      },
      get(request: AccountAssetExactInput, signal?: AbortSignal) {
        assertOpen();
        return application!.get(request, signal);
      },
      close,
    });
  } catch (startupError) {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Account assets startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
