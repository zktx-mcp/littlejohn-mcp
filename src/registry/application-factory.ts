import { createApplicationLifecycle } from "../runtime/application-lifecycle.js";
import type { OwnedResourceRegistry } from "../runtime/resource-ownership.js";
import { createOfficialAssetSynchronization, type OfficialAssetSynchronizationPort } from "./synchronization.js";
import type { RobinhoodOfficialAssetSourceClient } from "./official-asset-source-contract.js";
import type { OfficialAssetSnapshotStore } from "./official-asset-source-contract.js";

export interface RegistryOwnerApplication {
  readonly routes: import("../runtime/http-routing.js").RuntimeRouteRegistry;
  readonly officialAssets: OfficialAssetSynchronizationPort;
  close(): Promise<void>;
}

export const createRegistryOwnerApplication = (input: {
  readonly routes: import("../runtime/http-routing.js").RuntimeRouteRegistry;
  readonly source: RobinhoodOfficialAssetSourceClient;
  readonly store: OfficialAssetSnapshotStore;
  readonly signal: AbortSignal;
  readonly startupResources: OwnedResourceRegistry;
}): RegistryOwnerApplication => {
  const lifecycle = createApplicationLifecycle();
  const ownership = input.startupResources.register(lifecycle);
  const officialAssets = createOfficialAssetSynchronization(input);
  lifecycle.resources.register(officialAssets);
  lifecycle.open();
  ownership.transfer();
  return Object.freeze({ routes: input.routes, officialAssets, close: lifecycle.close });
};
