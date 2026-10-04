import { extendTokenCatalogRuntimeSupportManifest, type RuntimeSupportManifest } from "../runtime/support-manifest.js";
import { tokenCatalogCapabilityIds } from "./contracts.js";

const internalAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
});

export const extendTokenCatalogSupportManifest = (
  parent: RuntimeSupportManifest,
): RuntimeSupportManifest => extendTokenCatalogRuntimeSupportManifest(parent, {
  registrations: tokenCatalogCapabilityIds.map((capabilityId) => ({
    capabilityId,
    availability: internalAvailability,
  })),
  changes: [],
});
