import {
  extendStockTokenPriceRuntimeSupportManifest,
  type RuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { stockTokenPriceCapabilityIds } from "./contracts.js";

export const extendStockTokenPriceSupportManifest = (parent: RuntimeSupportManifest) =>
  extendStockTokenPriceRuntimeSupportManifest(parent, {
    registrations: stockTokenPriceCapabilityIds.map((capabilityId) => ({ capabilityId,
      availability: { overall: "internal", direct: "internal", http: "unavailable", mcp: "unavailable", cli: "unavailable" } })),
    changes: [],
  });
