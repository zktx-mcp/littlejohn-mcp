import {
  extendStockTokenPriceRuntimeSupportManifest,
  type StockTokenTradeHistoryRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { stockTokenPriceCapabilityIds } from "./contracts.js";

export const extendStockTokenPriceSupportManifest = (parent: StockTokenTradeHistoryRuntimeSupportManifest) =>
  extendStockTokenPriceRuntimeSupportManifest(parent, {
    registrations: stockTokenPriceCapabilityIds.map((capabilityId) => ({ capabilityId,
      availability: { overall: "internal", direct: "internal", http: "unavailable", mcp: "unavailable", cli: "unavailable" } })),
    changes: [],
  });
