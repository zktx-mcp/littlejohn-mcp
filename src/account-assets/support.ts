import { extendAccountAssetRuntimeSupportManifest, type RuntimeSupportManifest } from "../runtime/support-manifest.js";
import { accountAssetCapabilityIds } from "./contracts.js";

const internalAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
});

export const extendAccountAssetSupportManifest = (
  parent: RuntimeSupportManifest,
): RuntimeSupportManifest => extendAccountAssetRuntimeSupportManifest(parent, {
  registrations: accountAssetCapabilityIds.map((capabilityId) => ({
    capabilityId,
    availability: internalAvailability,
  })),
  changes: [],
});
