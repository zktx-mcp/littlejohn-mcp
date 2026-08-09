import { useState } from "react";

import type {
  AccountAssetOverviewSuccess,
} from "../../account-assets/browser.js";
import type { OfficialAssetCandidate } from "../../registry/browser.js";
import {
  officialSnapshotFresh,
  projectAccountAssetOverviewView,
} from "../../account-assets/browser.js";
import type { TokenSelection } from "../../token-catalog/browser.js";
import {
  AssetAmount,
  presentNativeAssetAmount,
  stockTokenAmount,
} from "./asset-amount.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import { Icon } from "./icons.js";
import { LoadingIndicator } from "./loading-indicator.js";
import { PageHeader } from "./page-header.js";

export interface AccountAssetPageSnapshot {
  readonly result: AccountAssetOverviewSuccess;
}

export interface AccountAssetPageProps {
  readonly snapshot: AccountAssetPageSnapshot | undefined;
  readonly loading: boolean;
  readonly staleMessage: string | undefined;
  readonly mutationDisabled: boolean;
  readonly onRefresh: () => void;
  readonly onAddStockToken: (
    candidates: readonly OfficialAssetCandidate[],
    trigger: HTMLButtonElement,
  ) => void;
  readonly onInfo: (selection: TokenSelection, trigger: HTMLButtonElement) => void;
}

export const AccountAssetsPage = ({
  snapshot,
  loading,
  staleMessage,
  mutationDisabled,
  onRefresh,
  onAddStockToken,
  onInfo,
}: AccountAssetPageProps) => {
  const [stockTokensExpanded, setStockTokensExpanded] = useState(true);
  const overview = snapshot === undefined
    ? undefined
    : projectAccountAssetOverviewView(snapshot.result);
  const refreshDisabled = loading || mutationDisabled;
  const assetActionsDisabled =
    loading || staleMessage !== undefined || mutationDisabled;
  const stockTokens = overview?.stockTokens.status === "current"
    ? overview.stockTokens.assets
    : [];

  return (
    <section className="asset-page" aria-labelledby="account-assets-heading">
      <PageHeader
        headingId="account-assets-heading"
        title="Assets"
        actions={(
          <button
            type="button"
            className={`icon-button secondary${
              loading ? " asset-refresh-button-active" : ""
            }`}
            aria-label={loading ? "Refreshing assets" : "Refresh assets"}
            title={loading ? "Refreshing assets" : "Refresh assets"}
            disabled={refreshDisabled}
            onClick={onRefresh}
          >
            <Icon name="refresh" />
          </button>
        )}
      />
      {loading && overview !== undefined ? (
        <span className="visually-hidden" role="status">
          Refreshing assets
        </span>
      ) : null}
      {overview === undefined ? (
        loading ? (
          <div className="page-loading">
            <LoadingIndicator label="Loading assets" />
          </div>
        ) : (
          <div className="page-state page-state-unavailable">
            <h2>Assets unavailable</h2>
            <p>{staleMessage ?? "Refresh to read the connected account."}</p>
          </div>
        )
      ) : (
        <>
          <section className="asset-account-subject" aria-labelledby="asset-account-heading">
            <h2 id="asset-account-heading">Account</h2>
            <p>Robinhood Chain</p>
            <CopyableIdentifier
              label="connected account address"
              value={overview.account.address}
            />
          </section>
          {staleMessage === undefined ? null : (
            <p className="limitation" role="status">
              The latest refresh failed. Previous balances remain visible.
            </p>
          )}
          <section className="asset-section" aria-labelledby="native-assets-heading">
            <h2 id="native-assets-heading">Native</h2>
            <div className="asset-list">
              <article className="asset-row">
                <div className="asset-identity">
                  <p className="type-label">Native</p>
                  <h3>ETH</h3>
                </div>
                <AssetAmount amount={presentNativeAssetAmount(overview.native)} />
              </article>
            </div>
          </section>
          <section className="asset-section" aria-labelledby="stock-token-assets-heading">
            <div className="section-heading-row">
              <h2 id="stock-token-assets-heading">
                <button
                  type="button"
                  className="section-disclosure"
                  aria-expanded={stockTokensExpanded}
                  aria-controls="stock-token-assets"
                  onClick={() => { setStockTokensExpanded((current) => !current); }}
                >
                  <Icon name={stockTokensExpanded ? "chevron-down" : "chevron-right"} />
                  <span>Stock Tokens</span>
                </button>
              </h2>
              <button
                type="button"
                className="icon-button unfilled"
                aria-label="Add Stock Token"
                title="Add Stock Token"
                disabled={
                  assetActionsDisabled ||
                  !officialSnapshotFresh(overview.viewRevision)
                }
                onClick={(event) => {
                  if (overview.stockTokens.status !== "current") return;
                  onAddStockToken(
                    overview.stockTokens.candidates,
                    event.currentTarget,
                  );
                }}
              >
                <Icon name="plus" />
              </button>
            </div>
            <div
              id="stock-token-assets"
              className={stockTokensExpanded ? undefined : "disclosure-content-hidden"}
            >
              {overview.stockTokens.status === "unavailable" ? (
                <p className="limitation" role="status">
                  Stock Tokens are unavailable until the official list refreshes.
                </p>
              ) : stockTokens.length === 0 ? (
                <p className="section-empty-state">No Stock Tokens added.</p>
              ) : (
                <div className="asset-list">
                  {stockTokens.map((row) => (
                    <article className="asset-row" key={row.selection.asset.address}>
                      <div className="asset-identity">
                        <p className="type-label">{row.classification.label}</p>
                        <h3>{row.identity.label}</h3>
                        {row.classification.limitation === null ? null : (
                          <p className="limitation" role="status">
                            {row.classification.limitation}
                          </p>
                        )}
                      </div>
                      <AssetAmount amount={stockTokenAmount(row)} />
                      <div className="asset-row-actions">
                        <button
                          type="button"
                          className="icon-button secondary"
                          aria-label={`Open ${row.identity.label} information`}
                          title="Token information"
                          disabled={assetActionsDisabled}
                          onClick={(event) => {
                            onInfo(row.selection, event.currentTarget);
                          }}
                        >
                          <Icon name="more" />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </section>
  );
};
