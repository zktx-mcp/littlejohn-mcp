import { describe, expect, it } from "vitest";

import {
  captureCanonicalJson,
  createExactRational,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referencePriceSuccessSchema,
  referencePriceWarnings,
  referenceRoundObservationSchema,
} from "../../../src/core/browser.js";
import {
  browserCsrfHeaderName,
  referenceMarketBrowserMutationPaths,
  referenceMarketPublicRoutes,
} from "../../../src/interfaces/browser-contract.js";
import {
  addReferenceWatchlistPair,
  readReferencePrice,
  removeReferenceWatchlistPair,
  reorderReferenceWatchlistPairs,
} from "../../../src/interfaces/web/reference-market-client.js";
import {
  controlBrowserReferenceMarketMutationJson,
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

  it("derives each mutation path, sends once, and preserves a lost-response commitment", async () => {
    const calls: Array<{ path: string; init: BrowserFetchInit }> = [];
    const request: BrowserFetch = async (path, init) => {
      calls.push({ path, init });
      throw new TypeError("response lost after send began");
    };
    const csrfToken = Buffer.alloc(32, 7).toString("base64url");
    expect(() => controlBrowserReferenceMarketMutationJson({
      action: "add",
      request: captureCanonicalJson({
        pairIds: [pair.pairId],
        expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA",
      }),
      csrfToken,
      options: { request },
    })).toThrow();
    expect(calls).toHaveLength(0);

    const result = await addReferenceWatchlistPair({
      pairId: pair.pairId,
      expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA",
    }, csrfToken, { request });
    const removed = await removeReferenceWatchlistPair({
      pairId: pair.pairId,
      expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA",
    }, csrfToken, { request });
    const reordered = await reorderReferenceWatchlistPairs({
      pairIds: referenceMarketManifest.pairs.slice(0, 2).map((entry) => entry.pairId),
      expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA",
    }, csrfToken, { request });
    expect(result).toMatchObject({
      status: "delivery_unknown",
      delivery: {
        action: "add",
        requestDigest: "26ba5ebfd2ed004b2e15c2bc669d6dd9edfc4764085ad0f212f4e621af1f774d",
        expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA",
        resendAllowed: false,
        verificationCapability: "market.watchlist",
      },
    });
    expect(removed).toMatchObject({ status: "delivery_unknown", delivery: { action: "remove" } });
    expect(reordered).toMatchObject({ status: "delivery_unknown", delivery: { action: "reorder" } });
    expect(calls.map((call) => call.path)).toEqual([
      referenceMarketBrowserMutationPaths.add,
      referenceMarketBrowserMutationPaths.remove,
      referenceMarketBrowserMutationPaths.reorder,
    ]);
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: {
        [browserCsrfHeaderName]: csrfToken,
        "Content-Type": "application/json",
      },
    });
  });
});
