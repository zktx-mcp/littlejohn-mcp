/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(resolve(path), "utf8");

describe("root browser application structure", () => {
  it("owns one application shell with only the canonical human page paths", () => {
    const main = source("src/interfaces/web/main.tsx");
    const app = source("src/interfaces/web/app.tsx");

    expect(main).toContain("<App />");
    expect(main).not.toContain("location.pathname");
    expect(app).toContain("parseBrowserPagePath(window.location.pathname)");
    expect(app).toContain("href={browserPagePaths.root}");
    expect(app).toContain("href={browserPagePaths.tokens}");
    expect(app).toContain("<TokenCatalogPage");
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

  it("places the wallet toggle at the inline end of the shared navigation", () => {
    const app = source("src/interfaces/web/app.tsx");
    const styles = source("src/interfaces/web/styles.css");

    expect(app).toContain('className="app-nav"');
    expect(app).toContain('className="wallet-nav-control secondary"');
    expect(styles).toMatch(
      /\.wallet-nav-control\s*\{[^}]*margin-inline-start:\s*auto;/u,
    );
  });

  it("slides toast notifications in and out without bypassing reduced motion", () => {
    const styles = source("src/interfaces/web/styles.css");

    expect(styles).toContain("@keyframes notification-enter");
    expect(styles).toContain("@keyframes notification-exit");
    expect(styles).toMatch(
      /@keyframes notification-enter\s*\{[^}]*translateX\(110%\)[\s\S]*?translateX\(0\)/u,
    );
    expect(styles).toMatch(
      /@keyframes notification-exit\s*\{[^}]*translateX\(0\)[\s\S]*?translateX\(110%\)/u,
    );
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("renders centered wallet and token modals with focus restoration and a shared backdrop", () => {
    const app = source("src/interfaces/web/app.tsx");
    const tokens = source("src/interfaces/web/token-catalog-page.tsx");
    const styles = source("src/interfaces/web/styles.css");

    expect(app).toContain("element.showModal()");
    expect(app).toContain("element.focus()");
    expect(app).toContain("walletNavigation.current?.focus()");
    expect(app).toContain('className="wallet-dialog"');
    expect(tokens).toContain("element.showModal()");
    expect(tokens).toContain("element.focus()");
    expect(tokens).toContain("dialogTrigger.current?.isConnected === true");
    expect(tokens).toContain("addTokenButton.current ?? pageHeading.current");
    expect(tokens).toContain('isBrowserResponseCode(error, "token_operation_not_found")');
    expect(tokens).toContain('className="token-dialog"');
    expect(app).toContain("event.preventDefault()");
    expect(tokens).toContain("event.preventDefault()");
    expect(app).toContain('event.key !== "Escape"');
    expect(tokens).toContain('event.key !== "Escape"');
    expect(styles).toMatch(
      /\.wallet-dialog::backdrop,\s*\.token-dialog::backdrop\s*\{[^}]*backdrop-filter:\s*blur\(12px\);/su,
    );
  });

  it("binds token results to one account under role-specific monotonic request authority", () => {
    const tokens = source("src/interfaces/web/token-catalog-page.tsx");

    expect(tokens).toContain("registrationPageMatchesAccount(account, page.registrations)");
    expect(tokens).toContain("registrationPageMatchesAccount(expected.account, page.registrations)");
    expect(tokens.match(/useState\(createBrowserRequestAuthority\)/gu)).toHaveLength(3);
    expect(tokens).toContain("listRequestAuthority.beginRead()");
    expect(tokens).toContain("detailRequestAuthority.beginRead()");
    expect(tokens).toContain("operationRequestAuthority.beginRead()");
    expect(tokens).toContain("operationRequestAuthority.beginControl()");
    expect(tokens).toContain("{ signal: request.signal }");
    expect(tokens).toContain("current.nextCursor === cursor");
    expect(tokens).toContain("const operationId = operation?.operationId;");
    expect(tokens).toMatch(
      /\[\s*acceptOperation,[^\]]*operationId[^\]]*recoverBrowserSession[^\]]*\]/u,
    );
    expect(tokens).not.toContain("[acceptOperation, operation, recoverBrowserSession]");
    expect(tokens).toContain("next.operationId !== dismissedReadOnlyOperationId.current");
    expect(tokens).toContain('operation.interactionInterface === "cli"');
    expect(tokens).not.toContain("useState(false);\n  const [requestPending");
    expect(tokens).not.toContain('mode: "loading"');
    expect(tokens).not.toContain("Reading the exact account registration and inspection.");
  });

  it("gives wallet identifiers the full dialog width without wrapping", () => {
    const styles = source("src/interfaces/web/styles.css");

    expect(styles).toMatch(
      /dl\s*\{[^}]*grid-template-columns:\s*1fr;/su,
    );
    expect(styles).toMatch(
      /dd\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*white-space:\s*nowrap;/su,
    );
    expect(styles).not.toContain("overflow-wrap: anywhere");
  });
});
