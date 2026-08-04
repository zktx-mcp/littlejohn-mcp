import {
  type ReferenceHistoryInput,
  type ReferenceHistorySuccess,
  type ReferencePriceInput,
  type ReferencePriceSuccess,
} from "../../core/browser.js";
import { browserCapabilityBindings } from "../browser-capability-bindings.js";
import { referenceMarketPublicRoutes } from "../browser-contract.js";
import {
  queryPublicBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

export const readReferencePrice = async (
  input: ReferencePriceInput,
  options: BrowserRequestOptions = {},
): Promise<ReferencePriceSuccess> => {
  const contract = browserCapabilityBindings.referencePrice.contract;
  const request = contract.parseInput(input);
  return contract.parsePublicSuccess(
    request,
    await queryPublicBrowserJson(referenceMarketPublicRoutes.priceQueries, request, options),
  );
};

export const readReferenceHistory = async (
  input: ReferenceHistoryInput,
  options: BrowserRequestOptions = {},
): Promise<ReferenceHistorySuccess> => {
  const contract = browserCapabilityBindings.referenceHistory.contract;
  const request = contract.parseInput(input);
  return contract.parsePublicSuccess(
    request,
    await queryPublicBrowserJson(referenceMarketPublicRoutes.historyQueries, request, options),
  );
};
