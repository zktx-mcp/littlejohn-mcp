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
} from "../../../src/interfaces/web/analysis-details.js";
import { tokenInspectCapability } from "../../../src/token-catalog/browser.js";
import {
  analysisAdmin,
  analysisImplementation,
  analysisOwner,
  createExactResolvedAnalysis,
  createTerminalityUnresolvedAnalysis,
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

describe("analysis browser presentation", () => {
  it("leads with the unavailable scam conclusion and keeps established control facts", () => {
    const markup = renderToStaticMarkup(createElement(ContractAnalysisDetails, {
      analysis: exactInspection.data.analysis,
      coverage: exactInspection.evidence.coverage,
      warnings: exactInspection.warnings,
      limitations: getCapabilityDefinitionSnapshot(tokenInspectCapability).staticScopeExclusions,
    }));

    expect(markup).toContain("Scam status");
    expect(markup).toContain("Not established");
    expect(markup.indexOf("Scam status")).toBeLessThan(
      markup.indexOf("Control summary"),
    );
    expect(markup).toContain(analysisImplementation);
    expect(markup).toContain(analysisOwner);
    expect(markup).toContain(analysisAdmin);
    expect(markup).toContain("EIP-1967 implementation");
    expect(markup).toContain("Source verification");
    expect(markup).toContain("Exact source match");
    expect(markup).toContain("What this analysis cannot establish");
    expect(markup).toContain("custom proxy");
    expect(markup).not.toContain("Target code hash");
    expect(markup).not.toContain("Implementation code hash");
    expect(markup).not.toContain("Declared functions");
    expect(markup).not.toContain("owner()\npaused()");
    expect(markup).not.toContain(
      exactInspection.data.analysis.targetRuntimeCode.codeHash,
    );
    for (const source of exactInspection.evidence.sources) {
      expect(markup).not.toContain(source.recordDigest);
    }
  });

  it("uses the same analysis presentation for token inspection", () => {
    const markup = renderToStaticMarkup(createElement(TokenInspectionAnalysisDetails, {
      inspection: exactInspection,
    }));

    expect(markup).toContain("Example Token");
    expect(markup).toContain("Decimals");
    expect(markup).toContain("Scam status");
    expect(markup).toContain("Not established");
    expect(markup.indexOf("Scam status")).toBeLessThan(
      markup.indexOf("Token facts"),
    );
    expect(markup).not.toContain("Raw total supply");
    expect(markup).not.toContain("Declared functions");
    expect(markup).not.toContain(exactInspection.evidence.sources[0]!.recordDigest);
  });

  it("presents retained first-hop evidence without calling it an effective implementation", () => {
    const analysis = createTerminalityUnresolvedAnalysis(
      exactInspection.data.analysis.target,
      exactInspection.data.analysis.block,
    );
    if (
      analysis.proxy.status !== "unresolved" ||
      analysis.proxy.reason !== "implementation_terminality_unresolved"
    ) {
      throw new TypeError("Expected a terminality-unresolved analysis fixture.");
    }
    const markup = renderToStaticMarkup(createElement(ContractAnalysisDetails, {
      analysis,
      coverage: { ...exactInspection.evidence.coverage, status: "partial" },
      warnings: [],
      limitations: getCapabilityDefinitionSnapshot(tokenInspectCapability).staticScopeExclusions,
    }));

    expect(markup).toContain("The observed first-hop implementation is not terminal");
    expect(markup).toContain("Observed first-hop implementation");
    expect(markup).toContain(analysisImplementation);
    expect(markup).toContain("not admitted as the effective implementation");
    expect(markup).toContain("Another ERC-1167 minimal proxy marker was observed");
    expect(markup).toContain("Observed first-hop proxy administrator");
    expect(markup).not.toContain(analysis.proxy.firstHop.implementationRuntimeCode.codeHash);
  });
});
