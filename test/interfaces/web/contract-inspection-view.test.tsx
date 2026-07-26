import { readFile } from "node:fs/promises";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import {
  chainAnchorSchema,
  getCapabilityDefinitionSnapshot,
} from "../../../src/core/browser.js";
import {
  ContractAnalysisDetails,
  TokenInspectionAnalysisDetails,
} from "../../../src/interfaces/web/contract-inspection-view.js";
import { tokenInspectCapability } from "../../../src/token-catalog/browser.js";
import {
  analysisAdmin,
  analysisImplementation,
  analysisOwner,
  createExactResolvedAnalysis,
} from "../../core/contract-analysis-fixtures.js";
import {
  createInspectionSuccess,
  tokenAddress,
  type InspectionHarnessOptions,
} from "../../token-catalog/harness.js";

let exactInspection: Awaited<ReturnType<typeof createInspectionSuccess>>;

beforeAll(async () => {
  const block = chainAnchorSchema.parse({
    chainId: "eip155:4663",
    blockNumber: "42",
    blockHash: `0x${"ab".repeat(32)}`,
    blockTimestamp: "2026-07-18T00:00:00.000Z",
  });
  const options: InspectionHarnessOptions = {
    analysis: createExactResolvedAnalysis(tokenAddress, block),
  };
  exactInspection = await createInspectionSuccess(undefined, options);
});

describe("contract inspection browser presentation", () => {
  it("presents the exact analysis, evidence, limitations, and ordered functions without per-function rows", () => {
    const markup = renderToStaticMarkup(createElement(ContractAnalysisDetails, {
      analysis: exactInspection.data.analysis,
      sources: exactInspection.evidence.sources,
      coverage: exactInspection.evidence.coverage,
      warnings: exactInspection.warnings,
      limitations: getCapabilityDefinitionSnapshot(tokenInspectCapability).staticScopeExclusions,
    }));

    expect(markup).toContain("Unresolved is not safe");
    expect(markup).toContain(tokenAddress);
    expect(markup).toContain(analysisImplementation);
    expect(markup).toContain(analysisOwner);
    expect(markup).toContain(analysisAdmin);
    expect(markup).toContain("eip1967 implementation");
    expect(markup).toContain("Target code hash");
    expect(markup).toContain("Implementation code hash");
    expect(markup).toContain("Source verification");
    expect(markup).toContain("exact match");
    expect(markup).toContain("Evidence sources");
    expect(markup).toContain("Sourcify");
    expect(markup).toContain("custom proxy");
    expect(markup.match(/<code class="declared-functions">/gu)).toHaveLength(1);
    expect(markup).toContain("owner()\npaused()");
    expect(markup.match(/<li[^>]*>[^<]*owner\(\)/gu)).toBeNull();
  });

  it("uses the same analysis presentation for token inspection", () => {
    const markup = renderToStaticMarkup(createElement(TokenInspectionAnalysisDetails, {
      inspection: exactInspection,
    }));

    expect(markup).toContain("Example Token");
    expect(markup).toContain("Raw total supply");
    expect(markup).toContain("Target");
    expect(markup).toContain(tokenAddress);
    expect(markup).toContain("Declared functions");
    expect(markup).toContain("Unavailable or unresolved information is not evidence");
  });

  it("binds request cancellation and stale-response admission to the shared request authority", async () => {
    const source = await readFile(
      "src/interfaces/web/contract-inspection-view.tsx",
      "utf8",
    );

    expect(source).toContain("useState(createBrowserRequestAuthority)");
    expect(source).toContain("const active = authority.beginRead()");
    expect(source).toContain("signal: active.signal");
    expect(source.match(/authority\.isCurrent\(active\)/gu)).toHaveLength(2);
    expect(source).toContain("authority.invalidateRead()");
    expect(source).toContain("authority.close()");
    expect(source).not.toContain("tokenInspectionDigest");
    expect(source).not.toContain("tokenReviewDigest");
  });
});
