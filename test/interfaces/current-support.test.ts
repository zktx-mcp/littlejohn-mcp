import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { extendChainSupportManifest } from "../../src/chain/application.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import { compareCodePointSequences } from "../../src/core/index.js";
import {
  composeInterfaceCapabilityCatalog,
  extendInterfaceSupportManifest,
  sameInterfaceAvailabilityAxes,
} from "../../src/interfaces/support.js";
import { operationInterfaceBindingList } from "../../src/interfaces/operation-bindings.js";
import { presentationContractRegistry } from "../../src/interfaces/mcp-app/registry.js";
import { extendStockTokenTradeHistorySupportManifest } from
  "../../src/stock-token-trade-history/support.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  renderCurrentSupportSection,
  verifyCurrentSupportDocument,
} from "../../src/runtime/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import { extendProtocolHarnessManifest } from "../protocols/interface-harness.js";

describe("interface Current Support projection", () => {
  const initialManifest = () => createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain);
  const finalManifest = () => extendInterfaceSupportManifest(
    extendProtocolHarnessManifest(
      extendStockTokenTradeHistorySupportManifest(extendAccountAssetSupportManifest(
        extendTokenCatalogSupportManifest(
          extendChainSupportManifest(extendWalletSupportManifest(initialManifest())),
        ),
      )),
    ),
  );
  const expectedReadCapabilities = Object.freeze([
    "account.balance",
    "address.inspect",
    "chain.status",
    "market.stock_token_trade_history",
    "token.inspect",
    "transaction.inspect",
    "uniswap_v2.quote_exact_input",
    "uniswap_v4.list_pools",
    "wallet.connection",
  ]);

  it("projects the final read and operation interfaces through the closed support axes", () => {
    const manifest = finalManifest();
    const snapshot = readRuntimeSupportManifest(manifest);
    expect(snapshot.presentations).toEqual(presentationContractRegistry.values()
      .map((entry) => ({
        contractId: entry.contractId,
        contractVersion: entry.contractVersion,
      }))
      .sort((left, right) => compareCodePointSequences(
        `${left.contractId}\0${left.contractVersion}`,
        `${right.contractId}\0${right.contractVersion}`,
      )));
    for (const entry of snapshot.capabilities) {
      expect(Object.keys(entry.availability).sort()).toEqual([
        "cli", "direct", "http", "mcp", "overall",
      ]);
    }
    for (const binding of operationInterfaceBindingList) {
      const entry = snapshot.capabilities.find((candidate) =>
        candidate.capabilityId === binding.contract.capabilityId);
      expect(entry?.availability).toEqual({
        overall: "available",
        direct: "internal",
        http: "internal",
        mcp: "available",
        cli: binding.cli === undefined ? "unavailable" : "available",
      });
    }
    expect(snapshot.capabilities
      .filter((entry) => entry.availability.overall === "unavailable"))
      .toEqual([]);
    const readCatalog = composeInterfaceCapabilityCatalog(manifest);
    expect(readCatalog.capabilities.map((entry) => entry.capabilityId))
      .toEqual(expectedReadCapabilities);
  });

  it("classifies equality without capability-specific exceptions", () => {
    const parent = Object.freeze({
      direct: "internal" as const,
      http: "internal" as const,
      mcp: "unavailable" as const,
      cli: "unavailable" as const,
    });
    expect(sameInterfaceAvailabilityAxes(parent, { ...parent })).toBe(true);
    expect(sameInterfaceAvailabilityAxes(parent, { ...parent, cli: "available" })).toBe(false);
    expect(sameInterfaceAvailabilityAxes({ ...parent, http: "available" }, parent)).toBe(false);
  });

  it("keeps the public current state generated from the final interface manifest", async () => {
    const document = await readFile("docs/PRODUCT_POLICY.md", "utf8");
    const manifest = finalManifest();
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
