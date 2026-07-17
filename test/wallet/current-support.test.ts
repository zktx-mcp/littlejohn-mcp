import { describe, expect, it } from "vitest";

import {
  createInitialRuntimeSupportManifest,
  renderCurrentSupportSection,
} from "../../src/runtime/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";

describe("wallet Current Support projection", () => {
  it("keeps wallet capabilities internal until the interface-owned final projection", async () => {
    const manifest = extendWalletSupportManifest(
      createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
    );
    const section = renderCurrentSupportSection(manifest);
    expect(section).toContain("Implemented wallet support: none.");
    expect(section).toContain("Available user-facing capabilities: none.");
    expect(section).not.toContain("`chain.status`");
    expect(section).not.toContain("`wallet.connection`");
  });
});
