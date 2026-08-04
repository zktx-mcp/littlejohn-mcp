import {
  canonicalBase64UrlSchema,
  findReferencePair,
  productDisplayName,
  referenceHistoryWindowSchema,
  referenceSupportedPairIdSchema,
  type ReferenceHistoryWindow,
  type ReferencePairId,
} from "../core/browser.js";
import { parseWalletOperationId } from "../wallet/operation-contract.js";

export const browserCsrfHeaderName = "Littlejohn-CSRF-Token";
export const browserCsrfMetaName = "littlejohn-csrf-token";

export const browserCsrfTokenByteLength = 32;
const browserCsrfTokenSchema = canonicalBase64UrlSchema(browserCsrfTokenByteLength);

export const browserPages = Object.freeze({
  assets: Object.freeze({
    id: "assets",
    kind: "information",
    label: "Assets",
    pathPattern: "/",
    primaryNavigation: true,
  }),
  referencePrices: Object.freeze({
    id: "reference_prices",
    kind: "information",
    label: "Prices",
    pathPattern: "/prices",
    primaryNavigation: true,
  }),
  referencePrice: Object.freeze({
    id: "reference_price",
    kind: "information",
    label: "Prices",
    pathPattern: "/prices/{pairId}",
    primaryNavigation: false,
  }),
} as const);
export type BrowserPage = typeof browserPages[keyof typeof browserPages];
export type BrowserPageId = BrowserPage["id"];
export type BrowserPageKind = BrowserPage["kind"];

export const browserDialogSurfaces = Object.freeze({
  analysis: Object.freeze({ taskKind: "analysis" }),
  walletConnect: Object.freeze({ taskKind: "wallet_connect" }),
  walletDisconnect: Object.freeze({ taskKind: "wallet_disconnect" }),
  stockTokenAdd: Object.freeze({ taskKind: "stock_token_add" }),
  stockTokenRemove: Object.freeze({ taskKind: "stock_token_remove" }),
  externalTokenOperation: Object.freeze({ taskKind: "external_token_operation" }),
} as const);
export type BrowserDialogSurface =
  typeof browserDialogSurfaces[keyof typeof browserDialogSurfaces];

export const browserInformationPages: readonly BrowserPage[] = Object.freeze(
  Object.values(browserPages),
);

export const browserPrimaryPages = Object.freeze([
  browserPages.assets,
  browserPages.referencePrices,
] as const);
export type BrowserPrimaryPageId = typeof browserPrimaryPages[number]["id"];

interface AssetsBrowserLocation {
  readonly page: "assets";
}

interface ReferencePricesBrowserLocation {
  readonly page: "reference_prices";
}

interface ReferencePriceBrowserLocation {
  readonly page: "reference_price";
  readonly pairId: ReferencePairId;
  readonly window: ReferenceHistoryWindow;
}

export type BrowserLocation =
  | AssetsBrowserLocation
  | ReferencePricesBrowserLocation
  | ReferencePriceBrowserLocation;

interface ParsedQuery {
  readonly values: ReadonlyMap<string, string>;
}

const parseQuery = (input: unknown): ParsedQuery => {
  if (input === "") return Object.freeze({ values: new Map() });
  if (typeof input !== "string" || !input.startsWith("?") || input.length === 1) {
    throw new TypeError("Browser location query is invalid.");
  }
  const values = new Map<string, string>();
  for (const field of input.slice(1).split("&")) {
    const separator = field.indexOf("=");
    if (
      separator <= 0 ||
      separator !== field.lastIndexOf("=") ||
      separator === field.length - 1
    ) {
      throw new TypeError("Browser location query is invalid.");
    }
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (
      !/^[a-z][a-z0-9-]*$/u.test(key) ||
      !/^[a-zA-Z0-9-]+$/u.test(value) ||
      values.has(key)
    ) {
      throw new TypeError("Browser location query is invalid.");
    }
    values.set(key, value);
  }
  return Object.freeze({ values });
};

const exactKeys = (
  values: ReadonlyMap<string, string>,
  permitted: readonly string[],
): void => {
  if ([...values.keys()].some((key) => !permitted.includes(key))) {
    throw new TypeError("Browser location query contains an unknown field.");
  }
};

export const browserLocations = Object.freeze({
  assets: (): AssetsBrowserLocation => Object.freeze({ page: "assets" }),
  referencePrices: (): ReferencePricesBrowserLocation =>
    Object.freeze({ page: "reference_prices" }),
  referencePrice: (
    pairIdInput: unknown,
    windowInput: unknown = "1d",
  ): ReferencePriceBrowserLocation => Object.freeze({
    page: "reference_price",
    pairId: referenceSupportedPairIdSchema.parse(pairIdInput),
    window: referenceHistoryWindowSchema.parse(windowInput),
  }),
});

export const browserPrimaryNavigation = Object.freeze([
  Object.freeze({
    page: browserPages.referencePrices,
    location: browserLocations.referencePrices(),
  }),
] as const);

export const parseBrowserLocation = (
  pathnameInput: unknown,
  searchInput: unknown,
  fragmentInput: unknown,
): BrowserLocation => {
  if (typeof pathnameInput !== "string" || fragmentInput !== "") {
    throw new TypeError("Browser location is invalid.");
  }
  const query = parseQuery(searchInput).values;
  if (pathnameInput === "/") {
    exactKeys(query, []);
    return browserLocations.assets();
  }
  if (pathnameInput === "/prices") {
    exactKeys(query, []);
    return browserLocations.referencePrices();
  }
  if (pathnameInput.startsWith("/prices/")) {
    exactKeys(query, ["window"]);
    const pairId = pathnameInput.slice("/prices/".length);
    if (pairId.length === 0 || pairId.includes("/")) {
      throw new TypeError("Reference price path is invalid.");
    }
    return browserLocations.referencePrice(pairId, query.get("window") ?? "1d");
  }
  throw new TypeError("Browser location path is invalid.");
};

export const browserLocationHref = (pageLocation: BrowserLocation): string => {
  switch (pageLocation.page) {
    case "assets":
      return "/";
    case "reference_prices":
      return "/prices";
    case "reference_price": {
      const admitted = browserLocations.referencePrice(
        pageLocation.pairId,
        pageLocation.window,
      );
      if (admitted.page !== "reference_price") throw new TypeError("Invalid price location.");
      return `/prices/${admitted.pairId}${
        admitted.window === "1d" ? "" : `?window=${admitted.window}`
      }`;
    }
  }
};

export interface BrowserPageMetadata {
  readonly page: BrowserPage;
  readonly title: string;
  readonly activePrimaryPageId?: BrowserPrimaryPageId;
}

export const browserPageMetadata = (
  pageLocation: BrowserLocation,
): BrowserPageMetadata => {
  switch (pageLocation.page) {
    case "assets":
      return Object.freeze({
        page: browserPages.assets,
        title: `Assets — ${productDisplayName}`,
        activePrimaryPageId: "assets",
      });
    case "reference_prices":
      return Object.freeze({
        page: browserPages.referencePrices,
        title: `Prices — ${productDisplayName}`,
        activePrimaryPageId: "reference_prices",
      });
    case "reference_price":
      return Object.freeze({
        page: browserPages.referencePrice,
        title: `${
          findReferencePair(pageLocation.pairId).label
        } — ${productDisplayName}`,
        activePrimaryPageId: "reference_prices",
      });
  }
};

export const browserBaseLocationForPath = (pathname: unknown): BrowserLocation => {
  if (typeof pathname !== "string") return browserLocations.assets();
  if (pathname === "/prices" || pathname.startsWith("/prices/")) {
    return browserLocations.referencePrices();
  }
  return browserLocations.assets();
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
