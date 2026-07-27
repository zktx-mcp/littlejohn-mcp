import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { extendChainSupportManifest } from "../../src/chain/application.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import {
  walletConnectionInterface,
  walletInterfaceBindingList,
} from "../../src/interfaces/identities.js";
import { extendInterfaceSupportManifest } from "../../src/interfaces/support.js";
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

  it("derives every wallet management binding availability from the binding catalog", () => {
    const snapshot = readRuntimeSupportManifest(extendInterfaceSupportManifest(
      extendUniswapV2ProtocolHarnessManifest(
        extendReferenceMarketSupportManifest(extendAccountAssetSupportManifest(extendTokenCatalogSupportManifest(
          extendChainSupportManifest(extendWalletSupportManifest(initialManifest())),
        ))),
      ),
    ));
    for (const binding of walletInterfaceBindingList) {
      const availability = snapshot.capabilities
        .find((entry) => entry.capabilityId === binding.contract.capabilityId)?.availability;
      expect(availability).toEqual({
        overall: binding.mcp !== undefined || binding.cli !== undefined || binding.web !== undefined
          ? "available"
          : "internal",
        direct: "internal",
        http: "internal",
        mcp: binding.mcp === undefined ? "unavailable" : "available",
        cli: binding.cli === undefined ? "unavailable" : "available",
        web: binding.web === undefined ? "unavailable" : "available",
      });
    }
    expect(snapshot.capabilities
      .find((entry) => entry.capabilityId === walletConnectionInterface.capabilityId)?.availability)
      .toEqual({
        overall: "available",
        direct: "internal",
        http: "available",
        mcp: "available",
        cli: "available",
        web: "unavailable",
      });
  });

  it("keeps the public current state generated from the final interface manifest", async () => {
    const document = await readFile("docs/PRODUCT_POLICY.md", "utf8");
    const manifest = extendInterfaceSupportManifest(extendUniswapV2ProtocolHarnessManifest(
      extendReferenceMarketSupportManifest(extendAccountAssetSupportManifest(
        extendTokenCatalogSupportManifest(
          extendChainSupportManifest(extendWalletSupportManifest(initialManifest())),
        ),
      )),
    ));
    expect(renderCurrentSupportSection(manifest)).toContain(
      "Implemented wallet support: `wallet.cancel_operation` (MCP, CLI, web); " +
        "`wallet.connect` (MCP, CLI, web); `wallet.connection` (HTTP, MCP, CLI); " +
        "`wallet.current_operation` (web); `wallet.disconnect` (MCP, CLI, web); " +
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
    expect(() => verifyCurrentSupportDocument(document, manifest)).not.toThrow();
  });
});
