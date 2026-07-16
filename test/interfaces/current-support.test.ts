import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { extendChainSupportManifest } from "../../src/chain/application.js";
import { extendInterfaceSupportManifest } from "../../src/interfaces/support.js";
import {
  initialRuntimeSupportManifest,
  renderCurrentSupportSection,
  verifyCurrentSupportDocument,
} from "../../src/runtime/index.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";

describe("interface Current Support projection", () => {
  it("keeps the public current state generated from the final interface manifest", async () => {
    const document = await readFile("docs/PRODUCT_POLICY.md", "utf8");
    const manifest = extendInterfaceSupportManifest(extendChainSupportManifest(
      extendWalletSupportManifest(initialRuntimeSupportManifest),
    ));
    expect(renderCurrentSupportSection(manifest)).toContain(
      "Implemented wallet support: `wallet.cancel_operation` (MCP, CLI, web); " +
        "`wallet.connect` (MCP, CLI); `wallet.connection` (HTTP, MCP, CLI, web); " +
        "`wallet.disconnect` (MCP, CLI); `wallet.operation` (MCP, CLI, web).",
    );
    expect(renderCurrentSupportSection(manifest)).not.toContain("MCP-started wallet management");
    expect(() => verifyCurrentSupportDocument(document, manifest)).not.toThrow();
  });
});
