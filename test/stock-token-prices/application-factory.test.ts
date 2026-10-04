import { describe, expect, it } from "vitest";
import { CapabilityBindingRegistry, CapabilityRegistry, ObservationAuthorityRegistry } from "../../src/core/index.js";
import { createStockTokenPriceApplicationFactory } from "../../src/stock-token-prices/application-factory.js";
import { stockTokenPricesCapability } from "../../src/stock-token-prices/contracts.js";
import { createInitialRuntimeSupportManifest, readRuntimeSupportManifest } from "../../src/runtime/support-manifest.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import type { RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { createStockTokenTradeHistoryApplication } from "../../src/stock-token-trade-history/application.js";
import { createStockTokenTradeHistoryObservationAuthorities } from "../../src/stock-token-trade-history/application-factory.js";
import { stockTokenTradeHistoryCapability } from "../../src/stock-token-trade-history/contracts.js";
import { createPriceFixture } from "./fixture.js";

describe("independent Price assembly", () => {
  it.each(["not_created", "source_unavailable"] as const)("reads a price with History %s and no Account support", async (historyState) => {
    const fixture = createPriceFixture();
    const startup = createResourceOwnershipScope();
    const application = await createStockTokenPriceApplicationFactory({
      ...fixture.dependencies,
      clock: fixture.clock,
      routes: {} as RuntimeRouteRegistry,
      supportManifest: createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
      startupResources: startup.resources,
    });
    const archive = createStockTokenTradeHistoryObservationAuthorities(fixture.clock).archive;
    const history = historyState === "not_created" ? undefined : createStockTokenTradeHistoryApplication({
      ...fixture.dependencies,
      source: {
        read: async () => ({ status: "unavailable", scope: "catalog_root", reason: "trade_history_unavailable",
          observedAt: fixture.clock.now() }),
        close: async () => undefined,
      },
      archiveObservationAuthority: archive,
      invocationPorts: { observations: new ObservationAuthorityRegistry(fixture.clock, [
        fixture.dependencies.invocationPorts.observations.get("chain_rpc"),
        fixture.dependencies.officialAssetObservationAuthority, archive,
      ]) },
    });
    try {
      if (history !== undefined) {
        const historyBindings = new CapabilityBindingRegistry(new CapabilityRegistry([stockTokenTradeHistoryCapability]), [history.binding]);
        const failedHistory = await historyBindings.invoke(stockTokenTradeHistoryCapability, { symbol: "AAPL" }, { signal: new AbortController().signal });
        expect(failedHistory).toMatchObject({ ok: true, data: { status: "unavailable", archive: { reason: "trade_history_unavailable", scope: "catalog_root" } } });
      }
      expect(startup.empty).toBe(true);
      const support = readRuntimeSupportManifest(application.supportManifest);
      expect(support.capabilities.some(entry => entry.capabilityId === "account.assets")).toBe(false);
      expect(support.capabilities.some(entry => entry.capabilityId === "market.stock_token_trade_history")).toBe(false);
      const bindings = new CapabilityBindingRegistry(new CapabilityRegistry([stockTokenPricesCapability]), [application.prices]);
      const result = await bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal });
      if (!result.ok || result.data.status !== "available") throw new Error(JSON.stringify(result));
      // Fixture protocol reserves independently represent one token on each side.
      expect(result.data.pools.filter(pool => pool.status === "verified").map(pool => pool.price))
        .toEqual([{ numerator: "1", denominator: "1" }, { numerator: "1", denominator: "1" }, { numerator: "1", denominator: "1" }]);
    } finally { await history?.close(); await application.close(); await fixture.close(); }
  });
});
