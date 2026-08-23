import {
  extendStockTokenTradeHistoryRuntimeSupportManifest,
  type AccountAssetRuntimeSupportManifest,
  type StockTokenTradeHistoryRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { stockTokenTradeHistoryCapabilityIds } from "./contracts.js";

const available = Object.freeze({
  overall: "available" as const,
  direct: "internal" as const,
  http: "available" as const,
  mcp: "available" as const,
  cli: "available" as const,
});

export const extendStockTokenTradeHistorySupportManifest = (
  parent: AccountAssetRuntimeSupportManifest,
): StockTokenTradeHistoryRuntimeSupportManifest =>
  extendStockTokenTradeHistoryRuntimeSupportManifest(parent, {
    registrations: stockTokenTradeHistoryCapabilityIds.map((capabilityId) => ({
      capabilityId,
      availability: available,
    })),
    changes: [],
  });
