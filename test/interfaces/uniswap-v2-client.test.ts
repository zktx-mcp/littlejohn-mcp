import { describe, expect, it } from "vitest";

import {
  productChainId,
  uint256DecimalSchema,
} from "../../src/core/browser.js";
import {
  uniswapV2FactoryAddress,
  uniswapV2QuoteInputSchema,
} from "../../src/protocols/uniswap-v2/browser.js";
import { uniswapV2PublicRoutes } from "../../src/interfaces/browser-contract.js";
import {
  type BrowserFetch,
  type BrowserFetchInit,
} from "../../src/interfaces/web/browser-client.js";
import { quoteUniswapV2ExactInput } from "../../src/interfaces/web/uniswap-v2-client.js";
import { createUniswapV2DirectQuoteSuccess } from "../protocols/interface-harness.js";

const input = uniswapV2QuoteInputSchema.parse({
  tokenIn: {
    kind: "erc20",
    chainId: productChainId,
    address: `0x${"28".repeat(20)}`,
  },
  tokenOut: {
    kind: "erc20",
    chainId: productChainId,
    address: "0x2700f8aaecf0c1e1e0d8d9f8a2bb5a6eb4fc2f42",
  },
  factory: uniswapV2FactoryAddress,
  amountIn: "1000000000000000000",
  block: { kind: "latest" },
});

describe("Uniswap V2 browser client", () => {
  it("sends one credential-free canonical request and applies complete public replay", async () => {
    const success = await createUniswapV2DirectQuoteSuccess(input);
    let observedPath = "";
    let observedInit: BrowserFetchInit | undefined;
    const signal = new AbortController().signal;
    const request: BrowserFetch = async (path, init) => {
      observedPath = path;
      observedInit = init;
      return { ok: true, status: 200, json: async () => success };
    };

    await expect(quoteUniswapV2ExactInput(input, { request, signal }))
      .resolves.toEqual(success);
    expect(observedPath).toBe(uniswapV2PublicRoutes.exactInputQuotes);
    expect(observedInit).toEqual({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });

    const changed = structuredClone(success);
    const direct = changed.data.candidates[0];
    if (direct?.status !== "quoted") throw new TypeError("Expected a direct quote fixture.");
    direct.amountOut = uint256DecimalSchema.parse(
      (BigInt(direct.amountOut) + 1n).toString(10),
    );
    const changedRequest: BrowserFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => changed,
    });
    await expect(quoteUniswapV2ExactInput(input, { request: changedRequest }))
      .rejects.toThrow("The Uniswap V2 quote response is invalid.");
  });
});
