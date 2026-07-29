/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(resolve(path), "utf8");

describe("browser application structure", () => {
  it("owns one pathname router outside the persistent application shell", () => {
    const main = source("src/interfaces/web/main.tsx");
    const app = source("src/interfaces/web/app.tsx");

    expect(main).toContain("parseBrowserLocation(");
    expect(main).toContain("window.location.pathname");
    expect(main).toContain("window.location.search");
    expect(main).toContain("window.history.pushState(null, \"\", href)");
    expect(main).toContain("window.addEventListener(\"popstate\", handlePopState)");
    expect(main).toContain("window.removeEventListener(\"popstate\", handlePopState)");
    expect(main).toContain("browserPageMetadata(nextLocation).title");
    expect(main).toContain("const referenceChart = createLightweightChartsAdapter()");
    expect(main).toContain("referenceChart={referenceChart}");
    expect(main).toContain("locationState={locationState}");
    expect(main).toContain(
      "setNavigationFocusVisible(event.detail === 0)",
    );
    expect(main).toContain(
      "navigationFocusVisible={navigationFocusVisible}",
    );
    expect(main).toContain("onNavigate={navigate}");
    expect(app).toContain("<ApplicationShell");
    expect(app).toContain("<AccountAssetsPage");
    expect(app).toContain("AnalysisDialogContent,");
    expect(app).toContain('from "./analysis-dialog.js"');
    expect(app.match(/<AnalysisDialogContent\b/gu)).toHaveLength(1);
    expect(app).not.toContain("AnalysisPage");
    expect(app).toContain('import { PricesPage } from "./prices-page.js"');
    expect(app.match(/<PricesPage\b/gu)).toHaveLength(1);
    expect(app).toContain('import { ReferencePricePage } from "./reference-price-page.js"');
    expect(app.match(/<ReferencePricePage\b/gu)).toHaveLength(1);
    expect(app).not.toContain("UniswapV2QuoteView");
    expect(app).not.toContain("location.pathname");
    expect(app).not.toContain("location.search");
  });

  it("keeps the wallet control in the persistent header without a menu disclosure", () => {
    const app = source("src/interfaces/web/app.tsx");
    const shell = source("src/interfaces/web/application-shell.tsx");
    const styles = source("src/interfaces/web/styles.css");

    expect(app).toContain('className="wallet-nav-control secondary icon-button"');
    expect(app).toContain('aria-label={walletLabel}');
    expect(app).toContain('? "wallet-disconnected"');
    expect(app).toContain(': "wallet-disconnect"');
    expect(shell).toContain('className="application-header-actions"');
    expect(shell).toContain("{walletControl}");
    expect(shell).not.toContain("navigation-menu-control");
    expect(styles).toMatch(
      /\.application-header-actions\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/u,
    );
  });

  it("keeps the sole named destination visible without a second navigation state", () => {
    const shell = source("src/interfaces/web/application-shell.tsx");
    const styles = source("src/interfaces/web/styles.css");

    expect(shell).toContain("browserPrimaryNavigation.map");
    expect(shell).toContain("browserLocations.assets()");
    expect(shell).not.toContain("navigationOpen");
    expect(shell).not.toContain("navigationButton");
    expect(shell).not.toContain('aria-controls="primary-navigation-items"');
    expect(shell).not.toContain('role="menu"');
    expect(styles).not.toContain(".primary-navigation-items.open");
    expect(styles).not.toContain(".navigation-menu-control");
  });

  it("slides notifications in and out without bypassing reduced motion", () => {
    const styles = source("src/interfaces/web/styles.css");

    expect(styles).toContain("@keyframes notification-enter");
    expect(styles).toContain("@keyframes notification-exit");
    expect(styles).toMatch(/@keyframes notification-enter\s*\{[^}]*translateX\(110%\)[\s\S]*?translateX\(0\)/u);
    expect(styles).toMatch(/@keyframes notification-exit\s*\{[^}]*translateX\(0\)[\s\S]*?translateX\(110%\)/u);
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("renders one centered action dialog and restores focus to the initiating control", () => {
    const app = source("src/interfaces/web/app.tsx");
    const dialog = source("src/interfaces/web/dialog-shell.tsx");
    const styles = source("src/interfaces/web/styles.css");

    expect(dialog).toContain("element.showModal()");
    expect(dialog).toContain("className={`application-dialog");
    expect(app).toContain("useState<ActiveModalTask>()");
    expect(app).toContain('kind: "analysis"');
    expect(app).toContain("<StockTokenAddDialog");
    expect(app).toContain("<StockTokenInformationDialog");
    expect(app).toContain("<StockTokenRemoveDialog");
    expect(app).toContain("<WalletTaskDialog");
    expect(app).toContain("if (current !== undefined) return current");
    expect(app).toContain("addTask.claimsOperation");
    expect(app).toContain("removeTask.claimsOperation");
    expect(app).toContain(
      "informationSelectionAddress !== activeModalTask.selectionAddress",
    );
    expect(app).not.toContain("connectionDialogOpen");
    expect(app).not.toContain("dialogPresentation");
    expect(styles).toMatch(/\.application-dialog::backdrop\s*\{[^}]*backdrop-filter:\s*blur\(18px\);/su);
  });

  it("prevents superseded Prices and selected-pair reads from publishing stale results", () => {
    const prices = source("src/interfaces/web/prices-page.tsx");
    const detail = source("src/interfaces/web/reference-price-page.tsx");

    expect(prices).toContain(
      "const [priceAuthority] = useState(createBrowserRequestAuthority)",
    );
    expect(prices).toContain("priceAuthority.isCurrent(request)");
    expect(prices).not.toContain("watchlistAuthority");
    expect(prices).not.toContain("readReferenceWatchlist");
    expect(detail).toContain(
      "const [historyAuthority] = useState(createBrowserRequestAuthority)",
    );
    expect(detail).toContain(
      "const [priceAuthority] = useState(createBrowserRequestAuthority)",
    );
    expect(detail).toContain("priceAuthority.isCurrent(request)");
    expect(detail).toContain("historyAuthority.isCurrent(request)");
    expect(detail).toContain("priceAuthority.cancelRead(request)");
    expect(detail).toContain("historyAuthority.cancelRead(request)");
  });

  it("uses the admitted exact Stock Token result without rendering machine commitments", () => {
    const app = source("src/interfaces/web/app.tsx");
    const information = source(
      "src/interfaces/web/stock-token-information-dialog.tsx",
    );
    const process = source("src/interfaces/web/stock-token-process.tsx");
    const taskPresentation = source(
      "src/interfaces/web/stock-token-task-presentation.tsx",
    );

    expect(information).toContain("projectAccountAssetExactView(result)");
    expect(process).toContain("presentStockTokenAddTask({");
    expect(process).toContain("presentStockTokenInformationTask(exactRead)");
    expect(process).toContain("presentStockTokenRemoveTask({");
    expect(taskPresentation).toContain(
      "operationMatchesStockTokenCandidate(",
    );
    expect(information).not.toContain("ContextualAnalysisAction");
    expect(information).toContain("onRemove");
    expect(information).toContain('title="Token information"');
    expect(information).toContain("<TokenControlSummary");
    expect(app).not.toContain("<TokenInspectionAnalysisDetails");
    expect(information).not.toContain("<TokenInspectionAnalysisDetails");
    expect(app).not.toContain('label="inspection digest"');
    expect(app).not.toContain('label="review digest"');
    expect(app).not.toContain('label="official asset UID"');
    expect(app).not.toContain('label="watchlist request digest"');
    expect(app).not.toContain("tokenInspectionDigest(");
    expect(app).not.toContain("tokenReviewDigest(");
  });

  it("wraps ordinary descriptions and visually ellipsizes complete identifiers", () => {
    const styles = source("src/interfaces/web/styles.css");
    const identifier = source("src/interfaces/web/copyable-identifier.tsx");

    expect(styles).toMatch(/dl\s*\{[^}]*grid-template-columns:\s*1fr;/su);
    expect(styles).toMatch(
      /dd\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/su,
    );
    expect(styles).toMatch(
      /\.copyable-identifier-value\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/su,
    );
    expect(identifier).toContain('title={value}>{value}</code>');
    expect(identifier).toContain("await writeClipboardText(");
    expect(identifier).toContain("value,");
  });

  it("keeps type, control size, and content elevation in their declared owners", () => {
    const styles = source("src/interfaces/web/styles.css");
    const chartLegend = styles.match(
      /\.chart-legend\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.["body"];

    expect(styles).toMatch(
      /h1\s*\{[^}]*font-size:\s*var\(--font-size-page\);[^}]*font-weight:\s*700;/su,
    );
    expect(styles).not.toMatch(/font-size:\s*18px;/u);
    expect(styles).not.toMatch(/min-height:\s*(?:30|32)px;/u);
    expect(chartLegend).toBeDefined();
    expect(chartLegend).not.toContain("border-radius:");
    expect(chartLegend).not.toContain("background:");
    expect(chartLegend).not.toMatch(/^\s*border:/mu);
    expect(chartLegend).toContain(
      "border-top: 1px solid var(--color-border-subtle);",
    );
  });

  it("uses one centered application canvas without page-specific outer widths", () => {
    const styles = source("src/interfaces/web/styles.css");
    const shell = source("src/interfaces/web/application-shell.tsx");
    const pageHeader = source("src/interfaces/web/page-header.tsx");

    expect(shell).toContain('className="application-shell"');
    expect(styles).toMatch(
      /\.application-shell\s*\{[^}]*width:\s*min\(100%, var\(--layout-width-page\)\);[^}]*margin:\s*0 auto;/su,
    );
    expect(styles).toMatch(
      /\.analysis-dialog\s*\{[^}]*width:\s*min\(calc\(100% - var\(--space-8\)\), var\(--layout-width-form\)\);/su,
    );
    expect(pageHeader).toContain("titleAction?: ReactNode");
    expect(pageHeader.indexOf("page-header-title-action")).toBeLessThan(
      pageHeader.indexOf("page-header-actions"),
    );
  });

  it("identifies keyboard page focus without outlining whole containers", () => {
    const app = source("src/interfaces/web/app.tsx");
    const styles = source("src/interfaces/web/styles.css");

    expect(app).toContain('document.getElementById("page-content")?.focus()');
    expect(styles).toContain(
      ".page-content.page-focus-visible:focus .page-header h1",
    );
    expect(styles).toMatch(
      /\.page-content:focus\s*\{[^}]*outline:\s*2px solid transparent;/su,
    );
    expect(styles).not.toContain('[tabindex="-1"]:focus');
  });

  it("lets dynamic dialog and asset content own its height while one list owns scrolling", () => {
    const styles = source("src/interfaces/web/styles.css");
    const dialogBody = styles.match(
      /\.stock-token-add-dialog \.dialog-shell-body\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.["body"] ?? "";
    const layout = styles.match(
      /\.stock-token-add-layout\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.["body"] ?? "";
    const candidates = styles.match(
      /\.stock-token-candidates\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.["body"] ?? "";
    const candidateRow = styles.match(
      /\.stock-token-candidate-row\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.["body"] ?? "";
    const candidateCopy = styles.match(
      /\.stock-token-candidate-copy\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.["body"] ?? "";
    const assetIdentity = styles.match(
      /\.asset-identity\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.["body"] ?? "";
    const dialogTitle = styles.match(
      /\.dialog-shell-header h1\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.["body"] ?? "";

    expect(dialogBody).toContain("display: grid;");
    expect(dialogBody).toContain("overflow: hidden;");
    expect(layout).toContain("max-height: 100%;");
    expect(candidates).toContain("grid-auto-rows: max-content;");
    expect(candidates).toContain("align-content: start;");
    expect(candidates).toContain("overflow-y: auto;");
    expect(candidateRow).toContain(
      "grid-template-columns: minmax(0, 1fr) auto;",
    );
    expect(candidateRow).not.toMatch(/(?:min-|max-)?height:/u);
    expect(candidateCopy).toContain("overflow-wrap: anywhere;");
    expect(assetIdentity).toContain("overflow-wrap: anywhere;");
    expect(dialogTitle).toContain("overflow-wrap: anywhere;");
  });
});
