import { readFile } from "node:fs/promises";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createAnalysisTarget,
  type AnalysisTarget,
} from "../../../src/interfaces/web/analysis-dialog.js";
import { ContextualAnalysisAction } from "../../../src/interfaces/web/contextual-analysis-action.js";

describe("contextual Analysis action", () => {
  it("names one exact target without creating a browser destination", async () => {
    const target: AnalysisTarget = createAnalysisTarget({
      kind: "contract",
      address: "0x1111111111111111111111111111111111111111",
      blockNumber: "42",
      expectedBlockHash: `0x${"ab".repeat(32)}`,
    });
    const markup = renderToStaticMarkup(createElement(ContextualAnalysisAction, {
      label: "Analyze contract",
      target,
      onAnalyze: () => undefined,
    }));
    const source = await readFile(
      "src/interfaces/web/contextual-analysis-action.tsx",
      "utf8",
    );

    expect(markup).toContain("<button");
    expect(markup).toContain(">Analyze contract</button>");
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("target=");
    expect(source).toContain("onAnalyze(target, event.currentTarget)");
  });
});
