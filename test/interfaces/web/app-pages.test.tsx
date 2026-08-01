import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserLocationHref,
  browserLocations,
} from "../../../src/interfaces/browser-contract.js";
import { referenceMarketManifest } from "../../../src/core/browser.js";
import { App } from "../../../src/interfaces/web/app.js";
import type { ReferenceChartPort } from "../../../src/interfaces/web/reference-chart.js";

const unavailableChart: ReferenceChartPort = Object.freeze({
  mount: async () => Object.freeze({ status: "unavailable" }),
});
beforeEach(() => {
  vi.stubGlobal("window", {
    location: { reload: () => undefined },
    sessionStorage: {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
    },
  });
});

describe("browser information pages", () => {
  it.each([
    [browserLocations.assets(), "Assets"],
    [browserLocations.referencePrices(), "Prices"],
    [
      browserLocations.referencePrice(referenceMarketManifest.pairs[0]!.pairId),
      referenceMarketManifest.pairs[0]!.label,
    ],
  ] as const)("renders only the selected page for %o", (location, heading) => {
    const markup = renderToStaticMarkup(createElement(App, {
      referenceChart: unavailableChart,
      locationState: { status: "valid", location },
      navigationFocusVisible: false,
      onNavigate: () => undefined,
    }));

    const mains = markup.match(/<main\b[\s\S]*?<\/main>/gu);
    expect(mains).toHaveLength(1);
    const main = mains?.[0] ?? "";
    expect(main).toMatch(new RegExp(`<h1[^>]*>${heading.replace("/", "\\/")}<\\/h1>`, "u"));
    for (const otherHeading of [
      "Assets",
      "Prices",
      referenceMarketManifest.pairs[0]!.label,
    ]) {
      if (otherHeading !== heading) {
        expect(main).not.toMatch(
          new RegExp(`<h1[^>]*>${otherHeading.replace("/", "\\/")}<\\/h1>`, "u"),
        );
      }
    }
  });

  it("uses the product identity as the sole Assets link and keeps Prices visible", () => {
    const markup = renderToStaticMarkup(createElement(App, {
      referenceChart: unavailableChart,
      locationState: {
        status: "valid",
        location: browserLocations.referencePrices(),
      },
      navigationFocusVisible: false,
      onNavigate: () => undefined,
    }));

    expect(markup).toContain('class="primary-navigation-items"');
    expect(markup).toContain('aria-label="Wallet"');
    expect(markup).toContain('class="lucide lucide-wallet"');
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(markup.match(new RegExp(
      `href="${browserLocationHref(browserLocations.assets())}"`,
      "gu",
    ))).toHaveLength(1);
    expect(markup).toContain(
      `href="${browserLocationHref(browserLocations.referencePrices())}"`,
    );
    expect(markup).not.toContain('aria-label="Open navigation"');
    expect(markup).not.toContain('aria-controls="primary-navigation-items"');
    expect(markup).not.toContain('class="lucide lucide-menu"');
    expect(markup).not.toContain('role="menu"');
    expect(markup).not.toContain('role="menuitem"');
  });

  it("presents Prices as one named comparison table", () => {
    const markup = renderToStaticMarkup(createElement(App, {
      referenceChart: unavailableChart,
      locationState: {
        status: "valid",
        location: browserLocations.referencePrices(),
      },
      navigationFocusVisible: false,
      onNavigate: () => undefined,
    }));

    expect(markup).toContain('role="table"');
    expect(markup).toContain('aria-label="Reference price comparison"');
    for (const label of [
      "Pair",
      "Reference price",
      "Last observation",
    ]) {
      expect(markup).toContain(`role="columnheader">${label}</span>`);
    }
    expect(markup).not.toContain('role="columnheader">Actions</span>');
    expect(markup).not.toContain("sparkline");
  });
});
