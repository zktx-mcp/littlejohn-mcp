import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  defaultStockTokenSectionMarker,
  renderDefaultStockTokenSection,
} from "../../scripts/default-stock-token-document.js";
import { defaultStockTokenManifest } from "../../src/registry/index.js";
import {
  defaultStockTokenCount,
  defaultStockTokenRankSchema,
} from "../../src/registry/default-stock-token-contract.js";
import {
  defaultStockTokenManifestSchema,
} from "../../src/registry/default-stock-tokens.js";

describe("default Stock Token manifest", () => {
  it("admits exactly the canonical count and retains independent identity uniqueness", () => {
    const assets = defaultStockTokenManifest.assets.map((asset) => ({ ...asset }));
    const additional = {
      assetUid: `0x${"11".repeat(32)}`,
      contractAddress: `0x${"22".repeat(20)}`,
    };

    expect(defaultStockTokenCount).toBe(5);
    expect(defaultStockTokenManifestSchema.safeParse({
      chainId: defaultStockTokenManifest.chainId,
      assets: [...assets.slice(0, -1), additional],
    }).success).toBe(true);
    expect(defaultStockTokenManifestSchema.safeParse({
      chainId: defaultStockTokenManifest.chainId,
      assets: assets.slice(0, -1),
    }).success).toBe(false);
    expect(defaultStockTokenManifestSchema.safeParse({
      chainId: defaultStockTokenManifest.chainId,
      assets: [...assets, additional],
    }).success).toBe(false);
    expect(defaultStockTokenManifestSchema.safeParse({
      chainId: defaultStockTokenManifest.chainId,
      assets: assets.map((asset, index) => index === assets.length - 1
        ? { ...asset, assetUid: assets[0]!.assetUid }
        : asset),
    }).success).toBe(false);
    expect(defaultStockTokenManifestSchema.safeParse({
      chainId: defaultStockTokenManifest.chainId,
      assets: assets.map((asset, index) => index === assets.length - 1
        ? { ...asset, contractAddress: assets[0]!.contractAddress }
        : asset),
    }).success).toBe(false);
  });

  it("owns the default rank domain as count minus one", () => {
    expect(defaultStockTokenRankSchema.safeParse(0).success).toBe(true);
    expect(defaultStockTokenRankSchema.safeParse(defaultStockTokenCount - 1).success).toBe(true);
    for (const rejected of [-1, defaultStockTokenCount, 0.5]) {
      expect(defaultStockTokenRankSchema.safeParse(rejected).success).toBe(false);
    }
  });

  it("publishes only deeply frozen admitted manifest values", () => {
    expect(Object.isFrozen(defaultStockTokenManifest)).toBe(true);
    expect(Object.isFrozen(defaultStockTokenManifest.assets)).toBe(true);
    for (const asset of defaultStockTokenManifest.assets) {
      expect(Object.isFrozen(asset)).toBe(true);
    }
  });

  it("owns one ordered identity set and its exact public current-state projection", async () => {
    expect(defaultStockTokenManifest.assets).toHaveLength(5);
    expect(new Set(defaultStockTokenManifest.assets.map((asset) => asset.assetUid)).size).toBe(5);
    expect(new Set(defaultStockTokenManifest.assets.map((asset) => asset.contractAddress)).size).toBe(5);

    const projection = renderDefaultStockTokenSection();
    expect(projection.match(new RegExp(defaultStockTokenSectionMarker, "gu"))).toHaveLength(1);
    for (const [index, asset] of defaultStockTokenManifest.assets.entries()) {
      expect(projection).toContain(
        `${index + 1}. UID \`${asset.assetUid}\`; contract \`${asset.contractAddress}\`.`,
      );
    }
    expect(await readFile("docs/PRODUCT_POLICY.md", "utf8")).toContain(projection);
  });
});
