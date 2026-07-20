import { describe, expect, it } from "vitest";

import {
  browserAssetPaths,
  browserApiRoot,
  browserCsrfHeaderName,
  browserCsrfMetaName,
  browserCsrfTokenByteLength,
  browserOperationCancellationPath,
  browserOperationConfirmationPath,
  browserOperationPath,
  browserPagePaths,
  browserWalletApiRoot,
  browserWalletApiPaths,
  parseBrowserCsrfToken,
  parseBrowserPagePath,
} from "../../src/interfaces/browser-contract.js";

const operationId = Buffer.alloc(32, 18).toString("base64url");

describe("browser interface contract", () => {
  it("separates the root page, wallet API resources, and immutable assets", () => {
    expect(browserCsrfHeaderName).toBe("Littlejohn-CSRF-Token");
    expect(browserCsrfMetaName).toBe("littlejohn-csrf-token");
    expect(browserPagePaths).toEqual({ root: "/" });
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

    expect(Object.values(browserPagePaths)).toEqual(["/"]);
    expect(parseBrowserPagePath("/")).toBe("/");
    for (const invalid of ["/tokens", "/tokens/", "/wallet", "/?x=1", undefined]) {
      expect(() => parseBrowserPagePath(invalid)).toThrow();
    }
    expect(JSON.stringify(browserPagePaths)).not.toContain("operationId");
    expect(JSON.stringify(browserWalletApiPaths)).not.toContain("mcp");
    expect(JSON.stringify(browserWalletApiPaths)).not.toContain("cli");
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
