import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { referenceMarketManifest } from "../../../src/core/browser.js";
import { PricesPage } from "../../../src/interfaces/web/prices-page.js";

describe("Prices page", () => {
  it("exposes public pair resources before wallet connection without presenting saved-state controls", () => {
    const markup = renderToStaticMarkup(createElement(PricesPage, {
      onNavigate: () => undefined,
    }));

    expect(markup).toContain(">Prices<");
    expect(markup).toContain(
      "Reference prices are named oracle observations, not trade prices or executable quotes.",
    );
    expect(markup).toContain('aria-label="Refresh prices"');
    expect(markup).toContain('title="Refresh prices"');
    expect(markup).toContain('class="lucide lucide-refresh-cw"');
    expect(markup).not.toContain(">Refresh</button>");
    for (const pair of referenceMarketManifest.pairs) {
      expect(markup).toContain(`>${pair.label}<`);
      expect(markup).toContain(`/prices/${pair.pairId}`);
    }
    expect(markup).not.toContain("Connect a wallet");
    expect(markup).not.toContain('role="columnheader">Actions');
    expect(markup).not.toContain('data-label="Actions"');
    expect(markup).not.toContain("Not saved");
    expect(markup).not.toContain(">Save<");
    expect(markup).not.toContain(">Remove<");
  });
});
