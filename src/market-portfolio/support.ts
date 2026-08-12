import { referenceMarketCapabilityIds } from "./contracts.js";
import {
  extendReferenceMarketRuntimeSupportManifest,
  type AccountAssetRuntimeSupportManifest,
  type ReferenceMarketRuntimeSupportManifest,
} from "../runtime/support-manifest.js";

const internalAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
});

export const extendReferenceMarketSupportManifest = (
  parent: AccountAssetRuntimeSupportManifest,
): ReferenceMarketRuntimeSupportManifest => extendReferenceMarketRuntimeSupportManifest(parent, {
  registrations: referenceMarketCapabilityIds.map((capabilityId) => ({
    capabilityId,
    availability: internalAvailability,
  })),
  changes: [],
});
