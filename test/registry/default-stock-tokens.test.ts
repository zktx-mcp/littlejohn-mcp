import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  defaultStockTokenSectionMarker,
  renderDefaultStockTokenSection,
} from "../../scripts/default-stock-token-document.js";
import { defaultStockTokenManifest } from "../../src/registry/index.js";

describe("default Stock Token manifest", () => {
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
