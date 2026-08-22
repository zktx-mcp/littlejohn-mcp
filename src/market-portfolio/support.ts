import { marketPortfolioCapabilityIds } from "./contracts.js";
import {
  extendMarketPortfolioRuntimeSupportManifest,
  type AccountAssetRuntimeSupportManifest,
  type MarketPortfolioRuntimeSupportManifest,
} from "../runtime/support-manifest.js";

const internalAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
});

export const extendMarketPortfolioSupportManifest = (
  parent: AccountAssetRuntimeSupportManifest,
): MarketPortfolioRuntimeSupportManifest => extendMarketPortfolioRuntimeSupportManifest(parent, {
  registrations: marketPortfolioCapabilityIds.map((capabilityId) => ({
    capabilityId,
    availability: internalAvailability,
  })),
  changes: [],
});
