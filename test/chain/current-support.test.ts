import { describe, expect, it } from "vitest";

import { extendChainSupportManifest } from "../../src/chain/application.js";
import {
  initialRuntimeSupportManifest,
  renderCurrentSupportSection,
} from "../../src/runtime/index.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";

describe("chain current-support projection", () => {
  it("keeps chain reads internal until the interface-owned final projection", async () => {
    const manifest = extendChainSupportManifest(
      extendWalletSupportManifest(initialRuntimeSupportManifest),
    );
    const section = renderCurrentSupportSection(manifest);
    expect(section).toContain("Implemented wallet support: none.");
    expect(section).toContain("Available user-facing capabilities: none.");
    expect(section).not.toContain("`wallet.connection`");
    expect(section).not.toContain("`chain.status`");
  });
});
