import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  findStockTokenCatalogDisposition,
  referenceFeedIds,
  referenceMarketManifest,
  referencePairIds,
  referencePairSourceIdSchema,
  stockTokenCatalogEvidence,
  stockTokenReferenceFeedIds,
  stockTokenReferenceMarketCatalog,
  stockTokenReferenceMarketGeneratedCatalogSchema,
} from "../../src/core/reference-market.js";
import { stockTokenReferenceMarketGeneratedCatalog } from
  "../../src/core/stock-token-reference-market.generated.js";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("generated Stock Token reference-market catalog", () => {
  it("retains the complete reviewed source result as one deterministic artifact", async () => {
    const generatedBytes = await readFile(
      new URL("../../src/core/stock-token-reference-market.generated.ts", import.meta.url),
    );
    expect(sha256(generatedBytes)).toBe(
      "f5d9c702e222b59541c17c6d0e6cd7967eeb628813191925b1dbfcaf4f0a9f5b",
    );
    expect(stockTokenReferenceMarketGeneratedCatalogSchema.parse(
      stockTokenReferenceMarketGeneratedCatalog,
    )).toEqual(stockTokenReferenceMarketCatalog);
    expect(stockTokenReferenceMarketCatalog).toMatchObject({
      contractVersion: "1",
      dispositionSetDigest:
        "0xb995fcea74b35f8d4f9f037f9b6e7848c08414c145784e620fdff43d801f8efe",
      sources: [
        {
          uri: "https://api.robinhood.com/rhj/assets",
          observedAt: "2026-08-12T13:12:28.000Z",
          rawResponseBytes: 76_348,
          rawResponseDigest:
            "0xb0b8146f0901ab22d9006cd2c2603cc7d2551aec2ca307ce35334aca2a6f146b",
        },
        {
          uri: "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
          observedAt: "2026-08-12T13:12:48.000Z",
          rawResponseBytes: 79_741,
          rawResponseDigest:
            "0x1f9d96f1f3f25be68f299a20c99457288e8cf2f69748962360ecb6dd8824a434",
        },
      ],
    });
    expect(stockTokenCatalogEvidence).toEqual({
      contractVersion: "1",
      dispositionSetDigest:
        "0xb995fcea74b35f8d4f9f037f9b6e7848c08414c145784e620fdff43d801f8efe",
      sources: stockTokenReferenceMarketCatalog.sources.map((source) => ({
        uri: source.uri,
        observedAt: source.observedAt,
        rawResponseDigest: source.rawResponseDigest,
      })),
    });
  });

  it("covers the complete asset set with the common mapped and unavailable outcomes", () => {
    const mapped = stockTokenReferenceMarketCatalog.dispositions.filter((entry) =>
      entry.mapping.status === "mapped");
    const unmapped = stockTokenReferenceMarketCatalog.dispositions.filter((entry) =>
      entry.mapping.status === "unmapped");
    expect({ total: stockTokenReferenceMarketCatalog.dispositions.length,
      mapped: mapped.length, unmapped: unmapped.length }).toEqual({
      total: 96,
      mapped: 32,
      unmapped: 64,
    });

    expect(findStockTokenCatalogDisposition(
      "0x00000000000000000000000000000000c2425be3658540dd8e2424cbf3c5c649",
    )).toEqual(expect.objectContaining({
      asset: expect.objectContaining({
        symbol: "AAPL",
        deployments: [expect.objectContaining({
          chainId: 4_663,
          contractAddress: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
        })],
      }),
      mapping: {
        status: "mapped",
        selectedDeployment: {
          chainId: 4_663,
          contractAddress: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
          networkName: "Robinhood Chain",
        },
        feed: {
          feedId: "0x6b22a786baa607d76728168703a39ea9c99f2cd0",
          proxyAddress: "0x6b22a786baa607d76728168703a39ea9c99f2cd0",
          expectedDescription: "Robinhood AAPL / USD",
          decimals: 8,
          heartbeatSeconds: 86_400,
          availability: "session_dependent_24_5",
          sourceRow: 33,
        },
      },
    }));
    expect(findStockTokenCatalogDisposition(
      "0x0000000000000000000000000000000002c4d1ce31ec4310b2c507c921a52b70",
    )).toEqual(expect.objectContaining({
      asset: expect.objectContaining({ symbol: "P" }),
      mapping: { status: "unmapped", reason: "feed_not_found" },
    }));
  });

  it("extends one feed registry without widening generic pair addressability", () => {
    expect(stockTokenReferenceFeedIds).toHaveLength(32);
    expect(referenceFeedIds).toHaveLength(34);
    expect(referenceMarketManifest.feeds).toHaveLength(34);
    expect(referencePairIds).toHaveLength(3);
    expect(referenceMarketManifest.pairs.flatMap((pair) =>
      pair.contract.sourceIds)).toEqual([
      "eth_usd",
      "usdg_usd",
      "eth_usd",
      "usdg_usd",
    ]);
    expect(referencePairSourceIdSchema.safeParse(
      "0x6b22a786baa607d76728168703a39ea9c99f2cd0",
    ).success).toBe(false);
  });
});
