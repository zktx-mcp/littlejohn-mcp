import { readFile } from "node:fs/promises";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AnalysisDialogContent,
  createAnalysisTarget,
  type AnalysisTarget,
} from "../../../src/interfaces/web/analysis-dialog.js";

const tokenAddress = "0x1111111111111111111111111111111111111111";
const blockHash = `0x${"ab".repeat(32)}`;

describe("Analysis dialog", () => {
  it("admits only complete canonical targets", () => {
    const target = createAnalysisTarget({
      kind: "contract",
      address: tokenAddress,
      blockNumber: "42",
      expectedBlockHash: blockHash,
    });

    expect(Object.isFrozen(target)).toBe(true);
    expect(target).toEqual({
      kind: "contract",
      address: tokenAddress,
      blockNumber: "42",
      expectedBlockHash: blockHash,
    });
    expect(() => createAnalysisTarget({
      kind: "wallet",
      address: tokenAddress,
    })).toThrow("Analysis target kind is invalid.");
    expect(() => createAnalysisTarget({
      kind: "contract",
      address: "0x1234",
    })).toThrow();
    expect(() => createAnalysisTarget({
      kind: "contract",
      address: tokenAddress,
      blockNumber: "-1",
    })).toThrow();
    expect(() => createAnalysisTarget({
      kind: "contract",
      address: tokenAddress,
      expectedBlockHash: blockHash,
    })).toThrow("Expected block hash requires an exact block number.");
  });

  it("renders only the exact contextual target supplied by its trigger", () => {
    const target: AnalysisTarget = createAnalysisTarget({
      kind: "token",
      address: tokenAddress,
      blockNumber: "42",
      expectedBlockHash: blockHash,
    });
    const markup = renderToStaticMarkup(createElement(AnalysisDialogContent, {
      target,
      recoverSession: () => false,
    }));

    expect(markup).toContain("Originating token target");
    expect(markup).toContain(tokenAddress);
    expect(markup).toContain(">42<");
    expect(markup.indexOf("Reading analysis")).toBeLessThan(
      markup.indexOf("Originating token target"),
    );
    expect(markup).not.toContain(blockHash);
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("Contract address");
    expect(markup).not.toContain("Analyze</button>");
  });

  it("binds cancellation and stale-response admission to one request authority", async () => {
    const source = await readFile(
      "src/interfaces/web/analysis-dialog.tsx",
      "utf8",
    );

    expect(source).toContain("useState(createBrowserRequestAuthority)");
    expect(source).toContain("const active = authority.beginRead()");
    expect(source).toContain("signal: active.signal");
    expect(source.match(/authority\.isCurrent\(active\)/gu)).toHaveLength(3);
    expect(source).toContain("authority.invalidateRead()");
    expect(source).toContain("authority.close()");
    expect(source).toContain(
      "analysisBlock(value).blockHash !== boundTarget.expectedBlockHash",
    );
    expect(source).not.toContain("tokenInspectionDigest");
    expect(source).not.toContain("tokenReviewDigest");
  });
});
