import {
  type ReferenceHistoryInput,
  type ReferenceHistorySuccess,
  type ReferencePriceInput,
  type ReferencePriceSuccess,
} from "../../core/browser.js";
import { referenceMarketApplicationContracts } from "../../market-portfolio/contracts.js";
import { referenceMarketPublicRoutes } from "../browser-contract.js";
import {
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
