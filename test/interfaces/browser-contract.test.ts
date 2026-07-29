import { describe, expect, it } from "vitest";

import { referenceMarketManifest } from "../../src/core/index.js";
import {
  browserAssetPaths,
  browserApiRoot,
  browserBaseLocationForPath,
  browserCsrfHeaderName,
  browserCsrfMetaName,
  browserCsrfTokenByteLength,
  browserInformationPages,
  browserLocationHref,
  browserLocations,
  browserOperationCancellationPath,
  browserOperationConfirmationPath,
  browserOperationPath,
  browserPageMetadata,
  browserPages,
  browserPrimaryNavigation,
  browserPrimaryPages,
  browserWalletApiRoot,
  browserWalletApiPaths,
  parseBrowserLocation,
  parseBrowserCsrfToken,
} from "../../src/interfaces/browser-contract.js";

const operationId = Buffer.alloc(32, 18).toString("base64url");

describe("browser interface contract", () => {
  it("owns the complete page, location, metadata, and navigation contract", () => {
    expect(browserCsrfHeaderName).toBe("Littlejohn-CSRF-Token");
    expect(browserCsrfMetaName).toBe("littlejohn-csrf-token");
    expect(browserPages).toEqual({
      assets: {
        id: "assets",
        kind: "information",
        label: "Assets",
        pathPattern: "/",
        primaryNavigation: true,
      },
      referencePrices: {
        id: "reference_prices",
        kind: "information",
        label: "Prices",
        pathPattern: "/prices",
        primaryNavigation: true,
      },
      referencePrice: {
        id: "reference_price",
        kind: "information",
        label: "Prices",
        pathPattern: "/prices/{pairId}",
        primaryNavigation: false,
      },
    });
    expect(browserApiRoot).toBe("/api/v1");
    expect(browserWalletApiRoot).toBe("/api/v1/wallet");
    expect(browserWalletApiPaths).toEqual({
      operations: "/api/v1/wallet/operations",
      currentOperation: "/api/v1/wallet/current-operation",
      operationPattern: "/api/v1/wallet/operations/{operationId}",
      confirmationPattern: "/api/v1/wallet/operations/{operationId}/confirmation",
      cancellationPattern: "/api/v1/wallet/operations/{operationId}/cancellation",
    });
    expect(browserAssetPaths).toEqual({ pattern: "/assets/{assetName}" });

    expect(browserInformationPages).toEqual(Object.values(browserPages));
    expect(browserPrimaryPages).toEqual([
      browserPages.assets,
      browserPages.referencePrices,
    ]);
    expect(browserPrimaryNavigation.map((item) => item.page)).toEqual([
      browserPages.referencePrices,
    ]);
    expect(JSON.stringify(browserWalletApiPaths)).not.toContain("mcp");
    expect(JSON.stringify(browserWalletApiPaths)).not.toContain("cli");
  });

  it("round-trips every canonical location and derives exact page metadata", () => {
    const pair = referenceMarketManifest.pairs[0]!;
    const locations = [
      browserLocations.assets(),
      browserLocations.referencePrices(),
      browserLocations.referencePrice(pair.pairId),
      browserLocations.referencePrice(pair.pairId, "30d"),
    ] as const;
    for (const location of locations) {
      const href = browserLocationHref(location);
      const [pathname, search = ""] = href.split("?");
      expect(parseBrowserLocation(
        pathname,
        search.length === 0 ? "" : `?${search}`,
        "",
      )).toEqual(location);
    }

    expect(browserPageMetadata(browserLocations.assets())).toEqual({
      page: browserPages.assets,
      title: "Assets — Little John",
      activePrimaryPageId: "assets",
    });
    expect(browserPageMetadata(browserLocations.referencePrice(pair.pairId))).toEqual({
      page: browserPages.referencePrice,
      title: `${pair.label} — Little John`,
      activePrimaryPageId: "reference_prices",
    });
  });

  it("admits the selected-price window and rejects malformed, duplicate, or obsolete locations", () => {
    const pair = referenceMarketManifest.pairs[0]!;
    const addressA = "0x1111111111111111111111111111111111111111";
    expect(parseBrowserLocation(
      `/prices/${pair.pairId}`,
      "",
      "",
    )).toEqual(browserLocations.referencePrice(pair.pairId, "1d"));

    for (const [pathname, search, fragment] of [
      ["/inspections", "", ""],
      ["/reference-markets", "", ""],
      ["/uniswap-v2-quotes", "", ""],
      ["/prices/unsupported", "", ""],
      ["/prices", "?window=1d", ""],
      [`/prices/${pair.pairId}`, "?window=1d&window=30d", ""],
      [`/prices/${pair.pairId}`, "?unknown=1d", ""],
      ["/quotes/uniswap-v2", "", ""],
      ["/analysis", "", ""],
      ["/analysis", `?kind=contract`, ""],
      ["/analysis", `?address=${addressA}`, ""],
      ["/analysis", `?kind=contract&address=${addressA}&block-number=01`, ""],
      ["/analysis", `?kind=contract&address=${addressA}&expected-block-hash=0x${"33".repeat(32)}`, ""],
      ["/", "", "#fragment"],
      ["/", "?", ""],
    ] as const) {
      expect(() => parseBrowserLocation(pathname, search, fragment)).toThrow();
    }

    expect(browserBaseLocationForPath("/prices/bad")).toEqual(
      browserLocations.referencePrices(),
    );
    expect(browserBaseLocationForPath("/analysis")).toEqual(
      browserLocations.assets(),
    );
    expect(browserBaseLocationForPath("/unknown")).toEqual(
      browserLocations.assets(),
    );
  });

  it("constructs the exact operation read and control resources from a canonical identifier", () => {
    expect(browserOperationPath(operationId))
      .toBe(`/api/v1/wallet/operations/${operationId}`);
    expect(browserOperationConfirmationPath(operationId))
      .toBe(`/api/v1/wallet/operations/${operationId}/confirmation`);
    expect(browserOperationCancellationPath(operationId))
      .toBe(`/api/v1/wallet/operations/${operationId}/cancellation`);

    for (const invalid of [
      "not-canonical",
      `${operationId}=`,
      Buffer.alloc(31, 18).toString("base64url"),
      Buffer.alloc(33, 18).toString("base64url"),
      undefined,
    ]) {
      expect(() => browserOperationPath(invalid)).toThrow();
      expect(() => browserOperationConfirmationPath(invalid)).toThrow();
      expect(() => browserOperationCancellationPath(invalid)).toThrow();
    }
  });

  it("accepts only canonical fixed-length CSRF tokens", () => {
    expect(browserCsrfTokenByteLength).toBe(32);
    const token = Buffer.alloc(browserCsrfTokenByteLength, 19).toString("base64url");
    expect(parseBrowserCsrfToken(token)).toBe(token);

    for (const invalid of [
      Buffer.alloc(browserCsrfTokenByteLength - 1, 19).toString("base64url"),
      Buffer.alloc(browserCsrfTokenByteLength + 1, 19).toString("base64url"),
      `${token}=`,
      undefined,
    ]) expect(() => parseBrowserCsrfToken(invalid)).toThrow();
  });
});
