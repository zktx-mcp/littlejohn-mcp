/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(resolve(path), "utf8");

describe("root browser application structure", () => {
  it("owns one application shell and one canonical human page", () => {
    const main = source("src/interfaces/web/main.tsx");
    const app = source("src/interfaces/web/app.tsx");

    expect(main).toContain("<App />");
    expect(main).not.toContain("location.pathname");
    expect(app).toContain("href={browserPagePaths.root}");
    expect(app).toContain("<AccountAssetsPage");
    expect(app).toContain('import {\n  ContractInspectionView,');
    expect(app.match(/<ContractInspectionView\b/gu)).toHaveLength(1);
    expect(app).toContain('import { ReferenceMarketView } from "./reference-market-view.js"');
    expect(app.match(/<ReferenceMarketView\b/gu)).toHaveLength(1);
    expect(app).not.toContain("browserPagePaths.tokens");
    expect(app).not.toContain("<TokenCatalogPage");
    expect(app).not.toContain("location.pathname");
    expect(app).not.toContain("location.search");
  });

  it("persists only the tab-local operation observation cursor across root reload", () => {
    const app = source("src/interfaces/web/app.tsx");
    const observation = source("src/interfaces/web/wallet-observation.ts");

    expect(app).toContain("useState(createBrowserWalletObservationStore)");
    expect(app).toContain("observationStore.save(next)");
    expect(app).toContain("window.sessionStorage.getItem(walletObservationStorageKey)");
    expect(app).toContain("window.sessionStorage.removeItem(walletObservationStorageKey)");
    expect(app).toContain("window.sessionStorage.setItem(walletObservationStorageKey, operationId)");
    expect(app).not.toContain("window.localStorage");
    expect(observation).toContain('const walletObservationStorageKey = "littlejohn.wallet-operation-observation"');
  });

  it("places the wallet control at the inline end of the shared navigation", () => {
    const app = source("src/interfaces/web/app.tsx");
    const styles = source("src/interfaces/web/styles.css");

    expect(app).toContain('className="app-nav"');
    expect(app).toContain('className="wallet-nav-control secondary"');
    expect(styles).toMatch(/\.wallet-nav-control\s*\{[^}]*margin-inline-start:\s*auto;/u);
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
    const styles = source("src/interfaces/web/styles.css");

    expect(app).toContain("element.showModal()");
    expect(app).toContain("element.focus()");
    expect(app).toContain("dialogTrigger.current?.isConnected === true");
    expect(app).toContain("walletNavigation.current)?.focus()");
    expect(app).toContain('className="application-dialog"');
    expect(app).toContain('isBrowserResponseCode(error, "token_operation_not_found")');
    expect(app).toContain("event.preventDefault()");
    expect(app).toContain('event.key === "Escape"');
    expect(styles).toMatch(/\.application-dialog::backdrop\s*\{[^}]*backdrop-filter:\s*blur\(18px\);/su);
  });

  it("binds wallet, asset, and token results to one account under role-specific request authority", () => {
    const app = source("src/interfaces/web/app.tsx");
    const page = source("src/interfaces/web/account-assets-page.tsx");

    expect(app.match(/useState\(createBrowserRequestAuthority\)/gu)).toHaveLength(5);
    expect(app).toContain("walletAuthority.beginRead()");
    expect(app).toContain("assetAuthority.beginRead()");
    expect(app).toContain("exactAuthority.beginRead()");
    expect(app).toContain("candidateAuthority.beginRead()");
    expect(app).toContain("tokenAuthority.beginRead()");
    expect(app).toContain("tokenAuthority.beginControl()");
    expect(app).toContain("resultMatchesAccount(expected, result)");
    expect(app).toContain("sameAccount({");
    expect(app).toContain("expected.connectionRevision === actual.connectionRevision");
    expect(app).toContain("next.operationId !== dismissedTokenOperation.current");
    expect(app).toContain('tokenOperation?.interactionInterface === "cli"');
    expect(app).toContain("handledTerminalTokenOperation.current === operation.operationId");
    expect(app).toContain("handledTerminalTokenOperation.current = operation.operationId");
    expect(app).toContain("handledTerminalTokenOperation.current !== next.operationId");
    expect(page).toContain("Add token");
    expect(page).toContain("Remove token");
    expect(page).toContain("onRemove(read.selection, event.currentTarget)");
    expect(app).toContain("selection: result.asset.selection");
    expect(app).not.toContain("visibleExactAsset");
    expect(app).not.toContain("startTokenSelectionUpdate");
  });

  it("displays server-produced token review commitments and the shared contract analysis", () => {
    const app = source("src/interfaces/web/app.tsx");

    expect(app).toContain("operation.review.inspectionDigest ??");
    expect(app).toContain("operation.review.reviewDigest");
    expect(app).toContain(
      "<TokenInspectionAnalysisDetails inspection={operation.review.inspection} />",
    );
    expect(app).not.toContain("tokenInspectionDigest(");
    expect(app).not.toContain("tokenReviewDigest(");
  });

  it("gives wallet identifiers the full dialog width without wrapping", () => {
    const styles = source("src/interfaces/web/styles.css");

    expect(styles).toMatch(/dl\s*\{[^}]*grid-template-columns:\s*1fr;/su);
    expect(styles).toMatch(
      /dd\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*white-space:\s*nowrap;/su,
    );
    expect(styles).not.toContain("overflow-wrap: anywhere");
  });
});
