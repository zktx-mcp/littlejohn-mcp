import {
  extendAccountAssetRuntimeSupportManifest,
  type AccountAssetRuntimeSupportManifest,
  type TokenCatalogRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { accountAssetCapabilityIds } from "./contracts.js";

const internalAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
});

export const extendAccountAssetSupportManifest = (
  parent: TokenCatalogRuntimeSupportManifest,
): AccountAssetRuntimeSupportManifest => extendAccountAssetRuntimeSupportManifest(parent, {
  registrations: accountAssetCapabilityIds.map((capabilityId) => ({
    capabilityId,
    availability: internalAvailability,
  })),
  changes: [],
});
