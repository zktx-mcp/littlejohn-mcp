import { canonicalBase64UrlSchema } from "../core/browser.js";
import { parseWalletOperationId } from "../wallet/operation-contract.js";
import type { ReferenceMarketDeliveryAction } from "./reference-market-delivery.js";

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

export const referenceMarketPublicRoutes = Object.freeze({
  priceQueries: "/api/v1/reference-markets/price-queries",
  historyQueries: "/api/v1/reference-markets/history-queries",
  watchlistQueries: "/api/v1/reference-market-watchlist/queries",
} as const);

export const publicInspectionPaths = Object.freeze({
  contractQueries: "/api/v1/contract-inspections",
  tokenQueries: "/api/v1/token-inspections",
} as const);

export const uniswapV2PublicRoutes = Object.freeze({
  exactInputQuotes: "/api/v1/uniswap-v2-exact-input-quotes",
} as const);

export const referenceMarketBrowserMutationPaths = Object.freeze({
  add: "/api/v1/reference-market-watchlist/entry-additions",
  remove: "/api/v1/reference-market-watchlist/entry-removals",
  reorder: "/api/v1/reference-market-watchlist/order-replacements",
} as const satisfies Readonly<Record<ReferenceMarketDeliveryAction, string>>);

export const referenceMarketBrowserMutationPath = (
  action: ReferenceMarketDeliveryAction,
): string => {
  switch (action) {
    case "add": return referenceMarketBrowserMutationPaths.add;
    case "remove": return referenceMarketBrowserMutationPaths.remove;
    case "reorder": return referenceMarketBrowserMutationPaths.reorder;
  }
};

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
