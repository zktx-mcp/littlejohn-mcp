import {
  parseCapabilityInput,
  parseCapabilitySuccess,
  type CapabilitySuccess,
} from "../../core/browser.js";
import {
  uniswapV2QuoteCapability,
  type UniswapV2QuoteData,
  type UniswapV2QuoteInput,
} from "../../protocols/uniswap-v2/browser.js";
import { uniswapV2PublicRoutes } from "../browser-contract.js";
import {
  BrowserResponseError,
  invalidBrowserResponse,
  queryPublicBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

export const quoteUniswapV2ExactInput = async (
  input: unknown,
  options: BrowserRequestOptions = {},
): Promise<CapabilitySuccess<UniswapV2QuoteData>> => {
  const request = parseCapabilityInput(uniswapV2QuoteCapability, input);
  try {
    return parseCapabilitySuccess(
      uniswapV2QuoteCapability,
      request,
      await queryPublicBrowserJson(
        uniswapV2PublicRoutes.exactInputQuotes,
        request,
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidBrowserResponse("The Uniswap V2 quote response is invalid.");
  }
};

export type UniswapV2QuoteRequest = UniswapV2QuoteInput;
