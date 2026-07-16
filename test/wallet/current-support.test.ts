import { describe, expect, it } from "vitest";

import {
  initialRuntimeSupportManifest,
  renderCurrentSupportSection,
} from "../../src/runtime/index.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";

describe("wallet Current Support projection", () => {
  it("projects the complete wallet-scoped support state without owning the later public projection", async () => {
    const manifest = extendWalletSupportManifest(initialRuntimeSupportManifest);
    const section = renderCurrentSupportSection(manifest);
    expect(section).toContain("`wallet.connection`");
    expect(section).not.toContain("`chain.status`");
    expect(section).toContain(
      "Implemented wallet support: `wallet.cancel_operation` (CLI); `wallet.connect` (CLI); " +
        "`wallet.connection` (CLI); `wallet.disconnect` (CLI); `wallet.operation` (CLI).",
    );
    expect(section).not.toContain("MCP");
    expect(section).not.toContain("web");
  });
});
