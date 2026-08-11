import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { extendChainSupportManifest } from "../../src/chain/application.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import {
  composeInterfaceCapabilityCatalog,
  extendInterfaceSupportManifest,
  sameInterfaceAvailabilityAxes,
} from "../../src/interfaces/support.js";
import { presentationContractRegistry } from "../../src/interfaces/mcp-app/registry.js";
import { extendReferenceMarketSupportManifest } from "../../src/market-portfolio/support.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  renderCurrentSupportSection,
  verifyCurrentSupportDocument,
} from "../../src/runtime/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import { extendUniswapV2ProtocolHarnessManifest } from "../protocols/interface-harness.js";

describe("interface Current Support projection", () => {
  const initialManifest = () => createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain);
  const finalManifest = () => extendInterfaceSupportManifest(
    extendUniswapV2ProtocolHarnessManifest(
      extendReferenceMarketSupportManifest(extendAccountAssetSupportManifest(
        extendTokenCatalogSupportManifest(
          extendChainSupportManifest(extendWalletSupportManifest(initialManifest())),
        ),
      )),
    ),
  );
  const expectedWebCapabilities = Object.freeze([
    "contract.inspect",
    "market.reference_history",
    "market.reference_price",
    "token.cancel_operation",
    "token.operation",
    "token.start_addition",
    "token.start_removal",
    "wallet.cancel_operation",
    "wallet.connect",
    "wallet.disconnect",
    "wallet.operation",
  ]);
  const expectedInternalCapabilities = Object.freeze([
    "account.asset",
    "wallet.current_operation",
  ]);
  const expectedAvailableCapabilities = Object.freeze([
    "account.assets",
    "account.balance",
    "chain.status",
    "contract.inspect",
    "market.add_watchlist_pair",
    "market.reference_history",
    "market.reference_price",
    "market.remove_watchlist_pair",
    "market.reorder_watchlist_pairs",
    "market.watchlist",
    "token.cancel_operation",
    "token.inspect",
    "token.operation",
    "token.selection",
    "token.selections",
    "token.start_addition",
    "token.start_removal",
    "transaction.inspect",
    "uniswap_v2.quote_exact_input",
    "wallet.cancel_operation",
    "wallet.connect",
    "wallet.connection",
    "wallet.disconnect",
    "wallet.operation",
  ]);
  const expectedReadCapabilities = Object.freeze([
    "account.balance",
    "chain.status",
    "contract.inspect",
    "token.inspect",
    "transaction.inspect",
    "uniswap_v2.quote_exact_input",
    "wallet.connection",
  ]);

  it("matches the independent browser, public-read, and overall availability oracles", () => {
    const manifest = finalManifest();
    const snapshot = readRuntimeSupportManifest(manifest);
    expect(snapshot.presentations).toEqual(presentationContractRegistry.values().map((entry) => ({
      contractId: entry.contractId,
      contractVersion: entry.contractVersion,
    })));
    expect(snapshot.capabilities
      .filter((entry) => entry.availability.web === "available")
      .map((entry) => entry.capabilityId)).toEqual(expectedWebCapabilities);
    expect(snapshot.capabilities
      .filter((entry) => entry.availability.overall === "internal")
      .map((entry) => entry.capabilityId)).toEqual(expectedInternalCapabilities);
    expect(snapshot.capabilities
      .filter((entry) => entry.availability.overall === "available")
      .map((entry) => entry.capabilityId)).toEqual(expectedAvailableCapabilities);
    expect(snapshot.capabilities
      .filter((entry) => entry.availability.overall === "unavailable"))
      .toEqual([]);
    const readCatalog = composeInterfaceCapabilityCatalog(manifest);
    expect(readCatalog.capabilities.map((entry) => entry.capabilityId))
      .toEqual(expectedReadCapabilities);
    expect(readCatalog.capabilities
      .filter((entry) => entry.availability.web === "available")
      .map((entry) => entry.capabilityId)).toEqual(["contract.inspect"]);
  });

  it("classifies equality without capability-specific exceptions", () => {
    const parent = Object.freeze({
      direct: "internal" as const,
      http: "internal" as const,
      mcp: "unavailable" as const,
      cli: "unavailable" as const,
      web: "unavailable" as const,
    });
    expect(sameInterfaceAvailabilityAxes(parent, { ...parent })).toBe(true);
    expect(sameInterfaceAvailabilityAxes(parent, { ...parent, web: "available" })).toBe(false);
    expect(sameInterfaceAvailabilityAxes(
      { ...parent, web: "available" },
      parent,
    )).toBe(false);
  });

  it("keeps the public current state generated from the final interface manifest", async () => {
    const document = await readFile("docs/PRODUCT_POLICY.md", "utf8");
    const manifest = finalManifest();
    expect(renderCurrentSupportSection(manifest)).toContain(
      "Implemented wallet support: `wallet.cancel_operation` (MCP, CLI, web); " +
        "`wallet.connect` (MCP, CLI, web); `wallet.connection` (HTTP, MCP, CLI); " +
        "`wallet.disconnect` (MCP, CLI, web); " +
        "`wallet.operation` (MCP, CLI, web).",
    );
    expect(renderCurrentSupportSection(manifest)).not.toContain("MCP-started wallet management");
    expect(renderCurrentSupportSection(manifest)).toContain(
      "Implemented protocol support: `uniswap_v2` (L0 discovered).",
    );
    expect(renderCurrentSupportSection(manifest)).toContain(
      "Official identity source: [Uniswap]" +
        "(https://github.com/Uniswap/contracts/blob/" +
        "f56eb0c6016361101d103ffd2754498c9893d107/deployments/4663.md)",
    );
    expect(renderCurrentSupportSection(manifest)).toContain(
      "Supported conclusions: `factory_address_at_source_revision`, " +
        "`pair_init_code_hash_at_source_revision`.",
    );
    expect(renderCurrentSupportSection(manifest)).toContain(
      "`current_protocol_availability`",
    );
    expect(renderCurrentSupportSection(manifest)).toContain(
      "`uniswap_v2.quote_exact_input`",
    );
    expect(renderCurrentSupportSection(manifest)).toContain(
      "Implemented MCP App presentation contracts: `account.assets@1`",
    );
    expect(() => verifyCurrentSupportDocument(document, manifest)).not.toThrow();
  });
});
