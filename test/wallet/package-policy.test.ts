import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { loadWalletConnectProductionDependencies } from "../../src/wallet/walletconnect-client.js";


const walletConnectLicenseDigest =
  "1cb6f8cfe21f54ab1105105717eaa2ba08343037a2a9c41dfd5ab09e3ce270fc";

const finderPattern = Object.freeze([
  "1111111",
  "1000001",
  "1011101",
  "1011101",
  "1011101",
  "1000001",
  "1111111",
]);

const matrixRegion = (
  rows: readonly string[],
  startRow: number,
  startColumn: number,
): readonly string[] => Object.freeze(finderPattern.map((_, rowOffset) =>
  rows[startRow + rowOffset]?.slice(startColumn, startColumn + 7) ?? ""));

describe("WalletConnect package boundary", () => {
  it("loads and narrows the installed ESM packages without declaration shadows", async () => {
    const dependencies = await loadWalletConnectProductionDependencies();
    expect(Object.keys(dependencies).sort()).toEqual(["qrEncoder", "sdkFactory"]);
    expect(typeof dependencies.sdkFactory).toBe("function");
    const qr = dependencies.qrEncoder(
      `wc:${"a".repeat(64)}@2?relay-protocol=irn&symKey=${"b".repeat(64)}`,
    );
    expect(qr.rows).toHaveLength(qr.size);
    expect(qr.rows.every((row) => /^[01]+$/u.test(row) && row.length === qr.size)).toBe(true);
    expect(matrixRegion(qr.rows, 0, 0)).toEqual(finderPattern);
    expect(matrixRegion(qr.rows, 0, qr.size - 7)).toEqual(finderPattern);
    expect(matrixRegion(qr.rows, qr.size - 7, 0)).toEqual(finderPattern);
    expect(qr.rows).not.toEqual(Array.from(
      { length: qr.size },
      (_, row) => Array.from(
        { length: qr.size },
        (_, column) => (row + column) % 2 === 0 ? "1" : "0",
      ).join(""),
    ));
  });

  it("packages the exact pinned license bytes and required notice", async () => {
    const [installed, packaged, notice] = await Promise.all([
      readFile("node_modules/@walletconnect/sign-client/LICENSE.md"),
      readFile("LICENSES/WALLETCONNECT-COMMUNITY-LICENSE.md"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    expect(packaged).toEqual(installed);
    expect(createHash("sha256").update(packaged).digest("hex")).toBe(walletConnectLicenseDigest);
    expect(notice.split("Portions © 2025 Reown, Inc. All Rights Reserved")).toHaveLength(2);
  });
});
