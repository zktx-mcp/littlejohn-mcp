import {
  extendStockTokenTradeHistoryRuntimeSupportManifest,
  type AccountAssetRuntimeSupportManifest,
  type StockTokenTradeHistoryRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { stockTokenTradeHistoryCapabilityIds } from "./contracts.js";

const internalAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
});

export const extendStockTokenTradeHistorySupportManifest = (
  parent: AccountAssetRuntimeSupportManifest,
): StockTokenTradeHistoryRuntimeSupportManifest =>
  extendStockTokenTradeHistoryRuntimeSupportManifest(parent, {
    registrations: stockTokenTradeHistoryCapabilityIds.map((capabilityId) => ({
      capabilityId,
      availability: internalAvailability,
    })),
    changes: [],
  });
