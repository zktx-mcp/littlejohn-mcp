/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(resolve(path), "utf8");

describe("root browser application structure", () => {
  it("owns one fixed-root application without operation page routing", () => {
    const main = source("src/interfaces/web/main.tsx");
    const app = source("src/interfaces/web/app.tsx");

    expect(main).toContain("<App />");
    expect(main).not.toContain("location.pathname");
    expect(app).not.toContain("href=");
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

    expect(styles).toContain("@keyframes wallet-toast-enter");
    expect(styles).toContain("@keyframes wallet-toast-exit");
    expect(styles).toMatch(
      /@keyframes wallet-toast-enter\s*\{[^}]*translateX\(110%\)[\s\S]*?translateX\(0\)/u,
    );
    expect(styles).toMatch(
      /@keyframes wallet-toast-exit\s*\{[^}]*translateX\(0\)[\s\S]*?translateX\(110%\)/u,
    );
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("renders one centered modal dialog with a blurred backdrop", () => {
    const app = source("src/interfaces/web/app.tsx");
    const styles = source("src/interfaces/web/styles.css");

    expect(app).toContain("element.showModal()");
    expect(app).toContain("element.focus()");
    expect(app).toContain("walletNavigation.current?.focus()");
    expect(app).toContain('className="wallet-dialog"');
    expect(app).toContain("<dialog");
    expect(app).toContain("event.preventDefault()");
    expect(styles).toMatch(
      /\.wallet-dialog::backdrop\s*\{[^}]*backdrop-filter:\s*blur\(12px\);/su,
    );
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
