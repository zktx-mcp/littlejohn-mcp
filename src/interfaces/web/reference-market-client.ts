import {
  captureCanonicalJson,
  type ReferenceHistoryInput,
  type ReferenceHistorySuccess,
  type ReferencePriceInput,
  type ReferencePriceSuccess,
  type ReferenceWatchlistMutationInput,
  type ReferenceWatchlistReorderInput,
  type ReferenceWatchlistSuccess,
} from "../../core/browser.js";
import { referenceMarketBrowserApplicationContracts as referenceMarketApplicationContracts } from "../../market-portfolio/contracts.js";
import { referenceMarketPublicRoutes } from "../browser-contract.js";
import {
  createReferenceMarketDeliveryUnknown,
  type ReferenceMarketDeliveryUnknown,
} from "../reference-market-delivery.js";
import {
  controlBrowserReferenceMarketMutationJson,
  queryPublicBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

export const readReferencePrice = async (
  input: ReferencePriceInput,
  options: BrowserRequestOptions = {},
): Promise<ReferencePriceSuccess> => {
  const request = referenceMarketApplicationContracts.price.parseInput(input);
  return referenceMarketApplicationContracts.price.parsePublicSuccess(
    request,
    await queryPublicBrowserJson(referenceMarketPublicRoutes.priceQueries, request, options),
  );
};

export const readReferenceHistory = async (
  input: ReferenceHistoryInput,
  options: BrowserRequestOptions = {},
): Promise<ReferenceHistorySuccess> => {
  const request = referenceMarketApplicationContracts.history.parseInput(input);
  return referenceMarketApplicationContracts.history.parsePublicSuccess(
    request,
    await queryPublicBrowserJson(referenceMarketPublicRoutes.historyQueries, request, options),
  );
};

export const readReferenceWatchlist = async (
  options: BrowserRequestOptions = {},
): Promise<ReferenceWatchlistSuccess> => referenceMarketApplicationContracts.watchlist.parsePublicSuccess(
  {},
  await queryPublicBrowserJson(referenceMarketPublicRoutes.watchlistQueries, {}, options),
);

export type ReferenceMarketBrowserMutationResult =
  | Readonly<{ status: "committed"; value: ReferenceWatchlistSuccess }>
  | Readonly<{ status: "delivery_unknown"; delivery: ReferenceMarketDeliveryUnknown }>;

type ReferenceMarketBrowserMutationInput =
  | Readonly<{ action: "add"; request: ReferenceWatchlistMutationInput }>
  | Readonly<{ action: "remove"; request: ReferenceWatchlistMutationInput }>
  | Readonly<{ action: "reorder"; request: ReferenceWatchlistReorderInput }>;

const mutate = async (
  input: ReferenceMarketBrowserMutationInput & Readonly<{
    csrfToken: unknown;
    options?: BrowserRequestOptions;
  }>,
): Promise<ReferenceMarketBrowserMutationResult> => {
  const prepared = (() => {
    switch (input.action) {
      case "add": {
        const request = referenceMarketApplicationContracts.add.parseInput(input.request);
        return Object.freeze({
          request,
          parseSuccess: (value: unknown) =>
            referenceMarketApplicationContracts.add.parsePublicSuccess(request, value),
        });
      }
      case "remove": {
        const request = referenceMarketApplicationContracts.remove.parseInput(input.request);
        return Object.freeze({
          request,
          parseSuccess: (value: unknown) =>
            referenceMarketApplicationContracts.remove.parsePublicSuccess(request, value),
        });
      }
      case "reorder": {
        const request = referenceMarketApplicationContracts.reorder.parseInput(input.request);
        return Object.freeze({
          request,
          parseSuccess: (value: unknown) =>
            referenceMarketApplicationContracts.reorder.parsePublicSuccess(request, value),
        });
      }
    }
  })();
  const canonicalRequest = captureCanonicalJson(prepared.request);
  const delivered = await controlBrowserReferenceMarketMutationJson({
    action: input.action,
    request: canonicalRequest,
    csrfToken: input.csrfToken,
    ...(input.options === undefined ? {} : { options: input.options }),
  });
  if (delivered.status === "delivery_unknown") return delivered;
  try {
    return Object.freeze({
      status: "committed",
      value: prepared.parseSuccess(delivered.value),
    });
  } catch {
    return Object.freeze({
      status: "delivery_unknown",
      delivery: createReferenceMarketDeliveryUnknown({
        action: input.action,
        request: prepared.request,
      }),
    });
  }
};

export const addReferenceWatchlistPair = (
  request: ReferenceWatchlistMutationInput,
  csrfToken: unknown,
  options?: BrowserRequestOptions,
): Promise<ReferenceMarketBrowserMutationResult> => mutate({
  action: "add",
  request,
  csrfToken,
  ...(options === undefined ? {} : { options }),
});

export const removeReferenceWatchlistPair = (
  request: ReferenceWatchlistMutationInput,
  csrfToken: unknown,
  options?: BrowserRequestOptions,
): Promise<ReferenceMarketBrowserMutationResult> => mutate({
  action: "remove",
  request,
  csrfToken,
  ...(options === undefined ? {} : { options }),
});

export const reorderReferenceWatchlistPairs = (
  request: ReferenceWatchlistReorderInput,
  csrfToken: unknown,
  options?: BrowserRequestOptions,
): Promise<ReferenceMarketBrowserMutationResult> => mutate({
  action: "reorder",
  request,
  csrfToken,
  ...(options === undefined ? {} : { options }),
});
