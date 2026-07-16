import { canonicalBase64UrlSchema } from "../core/browser.js";
import { parseWalletOperationId } from "../wallet/operation-contract.js";

export const browserCsrfHeaderName = "Littlejohn-CSRF-Token";
export const browserCsrfMetaName = "littlejohn-csrf-token";

export const browserRequestTokenByteLength = 32;
const browserRequestTokenSchema = canonicalBase64UrlSchema(browserRequestTokenByteLength);

const operationPageRoot = "/wallet/operations";
const operationApiRoot = "/api/v1/wallet/operations";

export const browserInterfacePaths = Object.freeze({
  operationPagePattern: `${operationPageRoot}/{operationId}`,
  operationPattern: `${operationApiRoot}/{operationId}`,
  qrPattern: `${operationApiRoot}/{operationId}/qr`,
  confirmationPattern: `${operationApiRoot}/{operationId}/confirmation`,
  assetPattern: "/assets/{assetName}",
});

export const parseBrowserRequestToken = (input: unknown): string =>
  browserRequestTokenSchema.parse(input);

export const browserOperationPagePath = (operationIdInput: unknown): string =>
  `${operationPageRoot}/${parseWalletOperationId(operationIdInput)}`;

export const browserOperationResourcePath = (operationIdInput: unknown): string =>
  `${operationApiRoot}/${parseWalletOperationId(operationIdInput)}`;

export const browserOperationQrPath = (operationIdInput: unknown): string =>
  `${browserOperationResourcePath(operationIdInput)}/qr`;

export const browserOperationConfirmationPath = (operationIdInput: unknown): string =>
  `${browserOperationResourcePath(operationIdInput)}/confirmation`;

export const parseBrowserOperationPagePath = (input: unknown): string => {
  if (typeof input !== "string" || !input.startsWith(`${operationPageRoot}/`)) {
    throw new TypeError("The wallet operation page path is invalid.");
  }
  const operationId = parseWalletOperationId(input.slice(operationPageRoot.length + 1));
  if (input !== browserOperationPagePath(operationId)) {
    throw new TypeError("The wallet operation page path is invalid.");
  }
  return operationId;
};
