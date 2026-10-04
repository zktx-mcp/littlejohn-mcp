import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {productChainId, productChainNumericId, productDisplayName} from "../../src/registry/product-identity.js";

describe("product identity projection", () => {
  it("matches the product-policy authority and keeps prose free of the technical spelling", async () => {
    const policy = await readFile("docs/PRODUCT_POLICY.md", "utf8");
    expect(productDisplayName).toBe("Little John");
    expect(policy).toContain(`The human-facing product name is \`${productDisplayName}\`.`);
    expect(policy).toContain("The technical identifier stem is `littlejohn`.");

    const documents = (await readdir("docs"))
      .filter((name) => name.endsWith(".md"))
      .sort();
    for (const name of documents) {
      const document = await readFile(`docs/${name}`, "utf8");
      const prose = document.replace(/`[^`\n]*`/gu, "");
      for (const match of prose.matchAll(/\blittle\s*john\b/giu)) {
        expect(match[0], name).toBe(productDisplayName);
      }
    }
  });

  it("owns the product chain and derives its numeric API identifier", async () => {
    const policy = await readFile("docs/PRODUCT_POLICY.md", "utf8");
    expect(policy).toContain(`canonical chain ID for that network is \`${productChainId}\``);
    expect(productChainNumericId).toBe(4663);
  });
});
