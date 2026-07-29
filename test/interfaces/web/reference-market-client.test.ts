import { describe, expect, it } from "vitest";

import {
  createExactRational,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referencePriceSuccessSchema,
  referencePriceWarnings,
  referenceRoundObservationSchema,
} from "../../../src/core/browser.js";
import {
  referenceMarketPublicRoutes,
} from "../../../src/interfaces/browser-contract.js";
import {
  readReferencePrice,
} from "../../../src/interfaces/web/reference-market-client.js";
import {
  type BrowserFetch,
  type BrowserFetchInit,
} from "../../../src/interfaces/web/browser-client.js";

const pair = referenceMarketManifest.pairs[0]!;
const feed = referenceMarketManifest.feeds[0]!;
const block = Object.freeze({
  chainId: "eip155:4663" as const,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}` as const,
  blockTimestamp: "2026-07-22T00:05:00.000Z" as const,
});
const updatedAtUnixSeconds = String(Date.parse("2026-07-22T00:00:00.000Z") / 1_000);
const rpcConfigurationDigest = "A".repeat(43);
const observation = referenceRoundObservationSchema.parse({
  fact: {
    manifestVersion: 1,
    feedId: feed.feedId,
    proxyAddress: feed.standardProxy,
    decimals: 8,
    roundId: String((1n << 64n) | 1n),
    answeredInRound: String((1n << 64n) | 1n),
    answer: "193384405462",
    startedAtUnixSeconds: updatedAtUnixSeconds,
    updatedAtUnixSeconds,
    value: createExactRational(193384405462n, 100000000n),
  },
  readEvidence: {
    observedAt: "2026-07-22T00:05:01.000Z",
    sourceOwner: "user_configured",
    sourceClass: "chain_rpc",
    sourceReference: {
      kind: "configured_rpc",
      sourceId: `rpc:${rpcConfigurationDigest}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: rpcConfigurationDigest,
    },
    block,
  },
});
const price = referencePriceSuccessSchema.parse({
  status: "current",
  pair,
  block,
  mappingEvidence: referenceMarketMappingEvidence,
  sources: [observation],
  warnings: referencePriceWarnings,
  currentPrice: observation.fact.value,
});

describe("reference-market browser client", () => {
  it("performs public reads without browser credentials and validates the canonical result", async () => {
    let observedPath = "";
    let observedInit: BrowserFetchInit | undefined;
    const request: BrowserFetch = async (path, init) => {
      observedPath = path;
      observedInit = init;
      return { ok: true, status: 200, json: async () => price };
    };
    await expect(readReferencePrice({ pairId: pair.pairId }, { request })).resolves.toEqual(price);
    expect(observedPath).toBe(referenceMarketPublicRoutes.priceQueries);
    expect(observedInit).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairId: pair.pairId }),
    });
  });

});
