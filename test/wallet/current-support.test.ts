import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  initialRuntimeSupportManifest,
  verifyCurrentSupportDocument,
} from "../../src/runtime/index.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";

describe("wallet Current Support projection", () => {
  it("keeps the public Current Support section equal to the wallet runtime manifest", async () => {
    const document = await readFile("docs/PRODUCT_POLICY.md", "utf8");
    const manifest = extendWalletSupportManifest(initialRuntimeSupportManifest);
    expect(() => verifyCurrentSupportDocument(document, manifest)).not.toThrow();
  });
});
