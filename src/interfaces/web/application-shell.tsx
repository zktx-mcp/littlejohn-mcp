import type {
  MouseEvent,
  ReactNode,
} from "react";

import {
  browserLocationHref,
  browserLocations,
  browserPages,
  browserPrimaryNavigation,
  type BrowserLocation,
  type BrowserPrimaryPageId,
} from "../browser-contract.js";
import { productDisplayName } from "../../core/browser.js";

export interface ApplicationShellProps {
  readonly activePrimaryPageId?: BrowserPrimaryPageId;
  readonly children: ReactNode;
  readonly notice?: ReactNode;
  readonly pageFocusVisible: boolean;
  readonly onNavigate: (
    location: BrowserLocation,
    event: MouseEvent<HTMLAnchorElement>,
  ) => void;
  readonly walletControl: ReactNode;
}

export const ApplicationShell = ({
  activePrimaryPageId,
  children,
  notice,
  pageFocusVisible,
  onNavigate,
  walletControl,
}: ApplicationShellProps) => {
  return (
    <div className="application-shell">
      <header className="application-header">
        <nav className="primary-navigation" aria-label="Primary">
          <a
            className="product-identity"
            href={browserLocationHref(browserLocations.assets())}
            aria-current={
              activePrimaryPageId === browserPages.assets.id
                ? "page"
                : undefined
            }
            onClick={(event) => {
              onNavigate(browserLocations.assets(), event);
            }}
          >
            {productDisplayName}
          </a>
          <div className="primary-navigation-items">
            {browserPrimaryNavigation.map((item) => (
              <a
                key={item.page.id}
                href={browserLocationHref(item.location)}
                aria-current={
                  item.page.id === activePrimaryPageId ? "page" : undefined
                }
                onClick={(event) => {
                  onNavigate(item.location, event);
                }}
              >
                {item.page.label}
              </a>
            ))}
          </div>
          <div className="application-header-actions">
            {walletControl}
          </div>
        </nav>
      </header>
      {notice}
      <main
        id="page-content"
        className={`page-content${pageFocusVisible ? " page-focus-visible" : ""}`}
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  );
};
