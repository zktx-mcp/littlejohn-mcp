import { readFile } from "node:fs/promises";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import {
  productChainId,
  type CapabilitySuccess,
} from "../../src/core/browser.js";
import {
  uniswapV2FactoryAddress,
  type UniswapV2QuoteData,
  uniswapV2QuoteInputSchema,
} from "../../src/protocols/uniswap-v2/browser.js";
import { UniswapV2QuoteResult } from "../../src/interfaces/web/uniswap-v2-quote-view.js";
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

let success: CapabilitySuccess<UniswapV2QuoteData>;

beforeAll(async () => {
  success = await createUniswapV2DirectQuoteSuccess(input);
});

describe("Uniswap V2 browser presentation", () => {
  it("keeps each evaluated hop, source record, coverage result, and limitation visible", () => {
    const markup = renderToStaticMarkup(createElement(UniswapV2QuoteResult, {
      result: success,
    }));
    const direct = success.data.candidates[0];
    if (direct?.status !== "quoted") throw new TypeError("Expected a direct quote fixture.");
    const directHop = direct.evaluatedHops[0];
    if (directHop?.status !== "completed") throw new TypeError("Expected a completed hop.");

    expect(markup).toContain("Uniswap");
    expect(markup).toContain("uniswap_v2");
    expect(markup).toContain(uniswapV2FactoryAddress);
    expect(markup).toContain(success.data.deployment.runtimeCode.codeHash);
    expect(markup).toContain(success.data.deployment.pairInitCodeHash);
    expect(markup).toContain(success.data.block.blockHash);
    expect(markup).toContain(directHop.pair.pairAddress);
    expect(markup).toContain(directHop.pair.runtimeCode.codeHash);
    expect(markup).toContain(directHop.pair.reserve0);
    expect(markup).toContain(directHop.pair.reserve1);
    expect(markup).toContain(direct.amountOut);
    expect(markup).toContain("Mid price (raw output units per raw input unit)");
    expect(markup).toContain("Mid price (output tokens per input token)");
    expect(markup).toContain("Execution price (raw output units per raw input unit)");
    expect(markup).toContain("Execution price (output tokens per input token)");
    expect(markup).toContain("matched");
    expect(markup.match(/Status: pair absent/gu)).toHaveLength(2);
    expect(markup).toContain(success.data.deployment.source.sourceUri);
    expect(markup).toContain(success.data.deployment.source.sourceRevision);
    expect(markup).toContain(success.data.deployment.source.coverage.replaceAll("_", " "));
    for (const conclusion of success.data.deployment.source.supportedConclusions) {
      expect(markup).toContain(conclusion);
    }
    expect(markup).toContain(success.data.coverage.source.sourceUri);
    expect(markup).toContain(success.data.coverage.source.sourceObservedAt);
    expect(markup).toContain(success.data.coverage.source.coverage.replaceAll("_", " "));
    for (const conclusion of success.data.coverage.source.unsupportedConclusions) {
      expect(markup).toContain(conclusion);
    }
    for (const source of success.evidence.sources) {
      expect(markup).toContain(source.recordDigest);
      expect(markup).toContain(source.observedAt);
    }
    for (const conclusion of success.evidence.conclusions) {
      expect(markup).toContain(conclusion.id);
    }
    expect(markup).toContain("does not select a best route");
    expect(markup).not.toContain("Best route:");
    expect(markup).not.toContain("Minimum output:");
    expect(markup).not.toContain("Transaction ready");
  });

  it("uses the shared read authority for cancellation and stale-response rejection", async () => {
    const source = await readFile(
      "src/interfaces/web/uniswap-v2-quote-view.tsx",
      "utf8",
    );

    expect(source).toContain("useState(createBrowserRequestAuthority)");
    expect(source).toContain("const active = authority.beginRead()");
    expect(source).toContain("signal: active.signal");
    expect(source.match(/authority\.isCurrent\(active\)/gu)).toHaveLength(2);
    expect(source).toContain("authority.invalidateRead()");
    expect(source).toContain("authority.close()");
  });
});
