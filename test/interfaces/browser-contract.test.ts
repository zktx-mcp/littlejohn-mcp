import { describe, expect, it } from "vitest";

import {
  browserCsrfHeaderName,
  browserCsrfMetaName,
  browserInterfacePaths,
  browserOperationConfirmationPath,
  browserOperationPagePath,
  browserOperationQrPath,
  browserOperationResourcePath,
  browserRequestTokenByteLength,
  parseBrowserOperationPagePath,
  parseBrowserRequestToken,
} from "../../src/interfaces/browser-contract.js";

const operationId = Buffer.alloc(32, 18).toString("base64url");

describe("browser interface contract", () => {
  it("owns the exact browser names and operation resource paths", () => {
    expect(browserCsrfHeaderName).toBe("Littlejohn-CSRF-Token");
    expect(browserCsrfMetaName).toBe("littlejohn-csrf-token");
    expect(browserInterfacePaths).toEqual({
      operationPagePattern: "/wallet/operations/{operationId}",
      operationPattern: "/api/v1/wallet/operations/{operationId}",
      qrPattern: "/api/v1/wallet/operations/{operationId}/qr",
      confirmationPattern: "/api/v1/wallet/operations/{operationId}/confirmation",
      assetPattern: "/assets/{assetName}",
    });
    expect(browserOperationPagePath(operationId)).toBe(`/wallet/operations/${operationId}`);
    expect(browserOperationResourcePath(operationId)).toBe(`/api/v1/wallet/operations/${operationId}`);
    expect(browserOperationQrPath(operationId)).toBe(`/api/v1/wallet/operations/${operationId}/qr`);
    expect(browserOperationConfirmationPath(operationId))
      .toBe(`/api/v1/wallet/operations/${operationId}/confirmation`);
    expect(parseBrowserOperationPagePath(browserOperationPagePath(operationId))).toBe(operationId);
  });

  it("rejects non-canonical tokens, operation identifiers, and page path variants", () => {
    expect(browserRequestTokenByteLength).toBe(32);
    const token = Buffer.alloc(browserRequestTokenByteLength, 19).toString("base64url");
    expect(parseBrowserRequestToken(token)).toBe(token);
    for (const invalid of [
      Buffer.alloc(browserRequestTokenByteLength - 1, 19).toString("base64url"),
      Buffer.alloc(browserRequestTokenByteLength + 1, 19).toString("base64url"),
      `${token}=`,
      undefined,
    ]) expect(() => parseBrowserRequestToken(invalid)).toThrow();

    for (const invalidPath of [
      `/wallet/operations/${operationId}/extra`,
      `/wallet/operations//${operationId}`,
      `/api/v1/wallet/operations/${operationId}`,
      "/wallet/operations/not-canonical",
    ]) expect(() => parseBrowserOperationPagePath(invalidPath)).toThrow();
  });
});
