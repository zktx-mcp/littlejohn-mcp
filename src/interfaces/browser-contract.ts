import { canonicalBase64UrlSchema } from "../core/browser.js";
import { parseWalletOperationId } from "../wallet/operation-contract.js";

export const browserCsrfHeaderName = "Littlejohn-CSRF-Token";
export const browserCsrfMetaName = "littlejohn-csrf-token";

export const browserCsrfTokenByteLength = 32;
const browserCsrfTokenSchema = canonicalBase64UrlSchema(browserCsrfTokenByteLength);

export const browserPagePaths = Object.freeze({
  root: "/",
});
export type BrowserPagePath = typeof browserPagePaths[keyof typeof browserPagePaths];

export const parseBrowserPagePath = (input: unknown): BrowserPagePath => {
  if (input === browserPagePaths.root) return input;
  throw new TypeError("Browser page path is invalid.");
};

export const browserApiRoot = "/api/v1";
export const browserWalletApiRoot = "/api/v1/wallet";
const walletOperationsRoot = `${browserWalletApiRoot}/operations`;

export const browserWalletApiPaths = Object.freeze({
  operations: walletOperationsRoot,
  currentOperation: `${browserWalletApiRoot}/current-operation`,
  operationPattern: `${walletOperationsRoot}/{operationId}`,
  confirmationPattern: `${walletOperationsRoot}/{operationId}/confirmation`,
  cancellationPattern: `${walletOperationsRoot}/{operationId}/cancellation`,
});

export const browserAssetPaths = Object.freeze({
  pattern: "/assets/{assetName}",
});

export const parseBrowserCsrfToken = (input: unknown): string =>
  browserCsrfTokenSchema.parse(input);

const operationActionPath = (
  operationIdInput: unknown,
  action?: "confirmation" | "cancellation",
): string => `${walletOperationsRoot}/${parseWalletOperationId(operationIdInput)}${
  action === undefined ? "" : `/${action}`
}`;

export const browserOperationPath = (operationIdInput: unknown): string =>
  operationActionPath(operationIdInput);

export const browserOperationConfirmationPath = (operationIdInput: unknown): string =>
  operationActionPath(operationIdInput, "confirmation");

export const browserOperationCancellationPath = (operationIdInput: unknown): string =>
  operationActionPath(operationIdInput, "cancellation");
