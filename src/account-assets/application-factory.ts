import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import { createApplicationLifecycle } from "../runtime/application-lifecycle.js";
import type { OwnedResourceRegistry } from "../runtime/resource-ownership.js";
import type { RuntimeSupportManifest } from "../runtime/support-manifest.js";
import { createAccountAssetApplication } from "./application.js";
import type {
  AccountAssetCollectionInput,
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
  readonly supportManifest: RuntimeSupportManifest;
  close(): Promise<void>;
}

export interface AccountAssetApplicationFactoryInput extends AccountAssetReadProcessDependencies {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: RuntimeSupportManifest;
  readonly startupResources: OwnedResourceRegistry;
}

export const createAccountAssetApplicationFactory = async (
  input: AccountAssetApplicationFactoryInput,
): Promise<AccountAssetApplication> => {
  const lifecycle = createApplicationLifecycle();
  const lifecycleOwnership = input.startupResources.register(lifecycle);
  const assertOpen = (): void => {
    if (!lifecycle.admission.isOpen) throw new AccountAssetOperationError("runtime_state_unavailable");
  };
  try {
    const application = createAccountAssetApplication(input);
    lifecycle.resources.register(application);
    const accountAssets = Object.freeze({
      list(request: AccountAssetCollectionInput, signal?: AbortSignal) {
        assertOpen();
        return application.list(request, signal);
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
        "Account assets startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
