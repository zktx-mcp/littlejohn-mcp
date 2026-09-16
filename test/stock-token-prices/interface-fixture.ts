// Bindings for tests whose subject is runtime composition or another route.
// Price execution tests use the real application and protocol readers.
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";
import { stockTokenPricesCapability, stockTokensCapability, stockTokenPricesErrorRegistry, stockTokenPriceCapabilityIds } from "../../src/stock-token-prices/contracts.js";
import { extendStockTokenPriceRuntimeSupportManifest, type StockTokenTradeHistoryRuntimeSupportManifest } from "../../src/runtime/support-manifest.js";

export const priceInterfaceBindings = () => {
  const harness = createCapabilityHarness();
  const unavailable = async () => ({ status: "failure" as const, code: "internal_error" as const, issues: [] });
  return {
    prices: bindForHarness(stockTokenPricesCapability, harness, unavailable, stockTokenPricesErrorRegistry),
    tokens: bindForHarness(stockTokensCapability, harness, unavailable, stockTokenPricesErrorRegistry),
  };
};
export const priceInterfaceManifest = (parent: StockTokenTradeHistoryRuntimeSupportManifest) =>
  extendStockTokenPriceRuntimeSupportManifest(parent, {
    registrations: stockTokenPriceCapabilityIds.map((capabilityId) => ({ capabilityId,
      availability: { overall: "internal", direct: "internal", http: "unavailable", mcp: "unavailable", cli: "unavailable" } })), changes: [],
  });
