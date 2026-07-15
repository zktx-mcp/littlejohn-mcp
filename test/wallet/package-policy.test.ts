import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { loadWalletConnectProductionDependencies } from "../../src/wallet/walletconnect-client.js";

const walletConnectLicenseDigest =
  "1cb6f8cfe21f54ab1105105717eaa2ba08343037a2a9c41dfd5ab09e3ce270fc";

describe("WalletConnect package boundary", () => {
  it("loads and narrows the installed ESM packages without declaration shadows", async () => {
    const dependencies = await loadWalletConnectProductionDependencies();
    expect(Object.keys(dependencies).sort()).toEqual(["qrEncoder", "sdkFactory"]);
    expect(typeof dependencies.sdkFactory).toBe("function");
    const qr = dependencies.qrEncoder("walletconnect-package-boundary");
    expect(qr.rows).toHaveLength(qr.size);
    expect(qr.rows.every((row) => /^[01]+$/u.test(row) && row.length === qr.size)).toBe(true);
  });

  it("packages the exact pinned license bytes and required notice", async () => {
    const [installed, packaged, notice] = await Promise.all([
      readFile("node_modules/@walletconnect/sign-client/LICENSE.md"),
      readFile("LICENSES/WALLETCONNECT-COMMUNITY-LICENSE.md"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    expect(packaged).toEqual(installed);
    expect(createHash("sha256").update(packaged).digest("hex")).toBe(walletConnectLicenseDigest);
    expect(notice).toBe("Portions © 2025 Reown, Inc. All Rights Reserved\n");
  });
});
