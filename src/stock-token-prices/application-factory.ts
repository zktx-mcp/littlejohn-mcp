import { ObservationAuthorityRegistry, type CanonicalClock } from "../core/index.js";
import { createApplicationLifecycle } from "../runtime/application-lifecycle.js";
import type { OwnedResourceRegistry } from "../runtime/resource-ownership.js";
import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import { type RuntimeSupportManifest } from "../runtime/support-manifest.js";
import { createStockTokenPriceApplication } from "./application.js";
import { createDexScreenerPoolCandidateSource } from "./dexscreener-source.js";
import { extendStockTokenPriceSupportManifest } from "./support.js";
import type { StockTokenPriceApplicationPort, StockTokenPriceDependencies, PoolCandidateSourcePort } from "./ports.js";

export interface StockTokenPriceOwnerApplication extends StockTokenPriceApplicationPort {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: RuntimeSupportManifest;
}
export interface StockTokenPriceFactoryInput extends Omit<StockTokenPriceDependencies, "admission" | "source"> {
  readonly clock: CanonicalClock;
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: RuntimeSupportManifest;
  readonly startupResources: OwnedResourceRegistry;
  readonly source?: PoolCandidateSourcePort;
}

export const createStockTokenPriceApplicationFactory = async (
  input: StockTokenPriceFactoryInput,
): Promise<StockTokenPriceOwnerApplication> => {
  const lifecycle = createApplicationLifecycle();
  const ownership = input.startupResources.register(lifecycle);
  try {
    const source = input.source ?? createDexScreenerPoolCandidateSource({ clock: input.clock });
    lifecycle.resources.register(source);
    const invocationPorts = Object.freeze({ observations: new ObservationAuthorityRegistry(input.clock, [
      input.invocationPorts.observations.get("chain_rpc"), input.officialAssetObservationAuthority,
      source.observationAuthorityRegistration,
    ]) });
    const application = createStockTokenPriceApplication({
      admission: lifecycle.admission, ownerSignal: input.ownerSignal,
      chainInvocations: input.chainInvocations, currentBlockReads: input.currentBlockReads,
      officialAssets: input.officialAssets, officialAssetReads: input.officialAssetReads,
      protocolReads: input.protocolReads, poolReads: input.poolReads, source,
      officialAssetObservationAuthority: input.officialAssetObservationAuthority,
      invocationAuthority: input.invocationAuthority, invocationPorts,
    });
    lifecycle.resources.register(application);
    const supportManifest = extendStockTokenPriceSupportManifest(input.supportManifest);
    lifecycle.open();
    ownership.transfer();
    return Object.freeze({ ...application, routes: input.routes, supportManifest, close: lifecycle.close });
  } catch (error) {
    try { await lifecycle.close(); ownership.transfer(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Stock Token price startup and cleanup failed."); }
    throw error;
  }
};
